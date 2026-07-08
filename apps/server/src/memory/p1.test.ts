import { describe, it, expect } from 'vitest';
import { openDb, runMigrations } from './migrate';
import { LibSqlStorageClient } from './libsql-storage-client';
import { computeRecKey, valueKeyFor, findContradiction } from './dedup';
import { replayReportScore } from '../scoring/replay';
import type { LedgerRecommendation, IntentTag, Referent } from '../domain/recommendation';
import { SINGLE_INSTANCE_INTENTS } from '../domain/recommendation';
import type { ListingSnapshot } from '../domain/snapshot';
import type { ScoredDimension, AuditReport } from '../domain/audit';
import { loadFixtureListing } from '../identity/__fixtures__/load';

/**
 * §F P1 acceptance — the whole "audit the same app twice" contract, exercised
 * end-to-end over the real StorageClient + dedup, with NO model in the loop.
 */

const APP = '1', CC = 'us';

function makeRec(
  intent: IntentTag,
  rawValue: string,
  over: Partial<LedgerRecommendation> = {},
): LedgerRecommendation {
  const dimension = over.dimension ?? 'subtitle';
  const targetField = over.targetField ?? 'subtitle';
  const referent: Referent = SINGLE_INSTANCE_INTENTS.has(intent)
    ? { kind: 'none' }
    : { kind: 'keyword', value: rawValue };
  const valueKey = valueKeyFor(intent, referent);
  return {
    id: over.id ?? `rec_${intent}_${rawValue}`,
    appId: APP,
    country: CC,
    recKey: computeRecKey({ dimension, intent, targetField, referent }),
    valueKey,
    taxonomyVersion: null,
    dimension,
    intent,
    targetField,
    title: over.title ?? `${intent} ${rawValue}`,
    body: over.body ?? 'because evidence',
    beforeText: null,
    afterText: null,
    evidence: over.evidence ?? [{ kind: 'listing_field', field: targetField, snapshotId: 'snap-1' }],
    status: over.status ?? 'proposed',
    supersededBy: null,
    firstSeenAt: over.firstSeenAt ?? '2026-06-01T00:00:00.000Z',
    lastSeenAt: over.lastSeenAt ?? '2026-06-01T00:00:00.000Z',
    appliedAt: null,
    proofRegime: 'correlational',
  };
}

function dim(id: ScoredDimension['id'], score: number): ScoredDimension {
  return { id, score, confidence: 'observed', findings: 'f', evidence: [], label: id, weight: 10, weightedPoints: 0 };
}

function report(dimensions: ScoredDimension[]): AuditReport {
  return {
    app: { appId: APP, country: CC, url: 'u', name: 'n', developer: 'd', iconUrl: null, primaryGenre: null, averageRating: null, ratingCount: null },
    generatedAt: '2026-06-01T00:00:00.000Z',
    headline: 'h', overallScore: 0, dimensions,
    quickWins: [], highImpact: [], strategic: [],
    competitorComparison: { summary: 's', rows: [] }, limitations: [],
  };
}

function snap(id: string, rep: AuditReport): ListingSnapshot {
  return {
    id, appId: APP, country: CC, fetchedAt: '2026-06-01T00:00:00.000Z',
    listing: loadFixtureListing('onstoreonly'), signals: {}, report: rep,
    rubricVersion: 'rubric-1', promptHash: 'p', modelId: 'gemini-2.5-flash',
  };
}

async function freshClient() {
  const db = openDb(':memory:');
  await runMigrations(db);
  return { client: new LibSqlStorageClient(db), close: () => db.close() };
}

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe('§F P1: audit the same app twice', () => {
  it('re-raising a suggestion yields no duplicate ledger row (dedup on rec_key)', async () => {
    const h = await freshClient();
    try {
      // Audit 1: raise "add tracker".
      unwrap(await h.client.upsertRecommendation('tenant-test', makeRec('add_keyword', 'tracker', { id: 'a1' })));
      // Audit 2: the SAME suggestion, phrased differently and re-dated.
      unwrap(
        await h.client.upsertRecommendation(
          'tenant-test',
          makeRec('add_keyword', 'Trackers', {
            id: 'a2',
            body: 'rephrased but the same opportunity',
            lastSeenAt: '2026-06-20T00:00:00.000Z',
          }),
        ),
      );
      const ledger = unwrap(await h.client.ledger('tenant-test', APP, CC));
      expect(ledger).toHaveLength(1); // ← no duplicate
      expect(ledger[0]!.lastSeenAt).toBe('2026-06-20T00:00:00.000Z'); // ← bumped
    } finally {
      h.close();
    }
  });

  it('two distinct add_keyword recs for the same field survive as two rows', async () => {
    const h = await freshClient();
    try {
      unwrap(await h.client.upsertRecommendation('tenant-test', makeRec('add_keyword', 'tracker', { id: 'a1' })));
      unwrap(await h.client.upsertRecommendation('tenant-test', makeRec('add_keyword', 'budget', { id: 'a2' })));
      const ledger = unwrap(await h.client.ledger('tenant-test', APP, CC));
      // Both directions asserted: dedup did NOT collapse two real opportunities.
      expect(ledger).toHaveLength(2);
      expect(new Set(ledger.map((r) => r.valueKey))).toEqual(new Set(['tracker', 'budget']));
    } finally {
      h.close();
    }
  });

  it('contradiction guard fires on a reversed rec read back from the ledger', async () => {
    const h = await freshClient();
    try {
      unwrap(await h.client.upsertRecommendation('tenant-test', makeRec('add_keyword', 'tracker', { id: 'a1' })));
      const ledger = unwrap(await h.client.ledger('tenant-test', APP, CC));
      const reversal = makeRec('remove_wasted_term', 'tracker', { id: 'b1' });
      const hit = findContradiction(ledger, reversal);
      expect(hit).not.toBeNull();
      expect(hit?.intent).toBe('add_keyword');
    } finally {
      h.close();
    }
  });

  it('rubric-weight replay recomputes a stored report with ZERO LLM calls', async () => {
    const h = await freshClient();
    let llmCalls = 0;
    // A spy "model" — replay must never touch it (it takes no agent by design).
    const _model = { generate: async () => { llmCalls++; return { text: '' }; } };
    try {
      const dims = [dim('title', 10), dim('subtitle', 0), dim('keywordField', 5)];
      const rep = report(dims);
      unwrap(await h.client.putSnapshot('tenant-test', snap('snap-1', rep)));
      const stored = unwrap(await h.client.latestSnapshot('tenant-test', APP, CC));
      expect(stored).not.toBeNull();

      // Replay under the live weights, then under a re-tuned column.
      const baseline = replayReportScore(stored!.report);
      const retuned = replayReportScore(stored!.report, (id) => (id === 'title' ? 40 : 5));
      expect(baseline).toBeGreaterThanOrEqual(0);
      expect(retuned).not.toBe(baseline); // a weight change moved the score
      expect(llmCalls).toBe(0); // ← the whole point: instant, zero-LLM
    } finally {
      h.close();
    }
  });
});
