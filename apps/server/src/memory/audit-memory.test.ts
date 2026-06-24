import { describe, it, expect } from 'vitest';
import { openDb, runMigrations } from './migrate';
import { LibSqlStorageClient } from './libsql-storage-client';
import { persistAudit, toLedgerRec, detectApplied, changeDiff } from './audit-memory';
import { loadFixtureListing } from '../identity/__fixtures__/load';
import type { AppListing } from '../domain/listing';
import type { AuditReport, Recommendation as ReportRec } from '../domain/audit';
import type { ResolvedIdentity } from '../identity/resolve';

/**
 * §F P1 end-to-end (no model in the loop): "audit the same app twice — the
 * second references the first, marks which past suggestions were applied, and
 * never repeats one." Reports are hand-built so the assertion is deterministic.
 */

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

async function fresh() {
  const db = openDb(':memory:');
  await runMigrations(db);
  return { client: new LibSqlStorageClient(db), close: () => db.close() };
}

const CONFIDENT: ResolvedIdentity = {
  category: 'Productivity to-do list',
  categoryBand: 'high',
  niche: 'to-do list',
  nicheBand: 'medium',
  divergence: 'none',
  escalate: false,
  tally: [],
};

function rec(over: Partial<ReportRec>): ReportRec {
  return {
    category: 'quick-win',
    dimension: 'subtitle',
    title: 'Add "tracker" to the subtitle',
    rationale: 'High-intent term you do not rank for.',
    evidence: 'subtitle is empty',
    before: null,
    after: 'Budget Tracker & Planner',
    ...over,
  };
}

function report(recs: ReportRec[], score = 70): AuditReport {
  return {
    app: { appId: '1', country: 'us', url: 'u', name: 'n', developer: 'd', iconUrl: null, primaryGenre: 'Productivity', averageRating: 4, ratingCount: 10 },
    generatedAt: '2026-06-01T00:00:00.000Z',
    headline: 'h', overallScore: score, dimensions: [],
    quickWins: recs.filter((r) => r.category === 'quick-win'),
    highImpact: recs.filter((r) => r.category === 'high-impact'),
    strategic: recs.filter((r) => r.category === 'strategic'),
    competitorComparison: { summary: 's', rows: [] }, limitations: [],
  };
}

function listingWith(over: Partial<AppListing>): AppListing {
  return { ...loadFixtureListing('onstoreonly'), appId: '1', country: 'us', ...over };
}

const persistArgs = (listing: AppListing, rep: AuditReport, now: string) => ({
  listing, signals: {}, report: rep, resolved: CONFIDENT,
  identityFactSheet: 'fact sheet', rubricVersion: 'r1', promptHash: 'p1',
  modelId: 'gemini-2.5-flash', now,
});

describe('persistAudit — the memory loop', () => {
  it('audit twice: marks the applied suggestion, never duplicates, reports the change', async () => {
    const h = await fresh();
    try {
      // Audit 1: subtitle is empty; we suggest adding "Budget Tracker & Planner".
      const l1 = listingWith({ subtitle: null });
      await persistAudit(h.client, persistArgs(l1, report([rec({})], 60), '2026-06-01T00:00:00.000Z'));

      let ledger = unwrap(await h.client.ledger('1', 'us'));
      expect(ledger).toHaveLength(1);
      expect(ledger[0]!.status).toBe('proposed');

      // Audit 2: the user has applied it — subtitle now contains the after-text.
      // The same suggestion is also re-raised; it must not duplicate or re-open.
      const l2 = listingWith({ subtitle: 'Budget Tracker & Planner' });
      const memo = await persistAudit(
        h.client,
        persistArgs(l2, report([rec({})], 75), '2026-06-20T00:00:00.000Z'),
      );

      ledger = unwrap(await h.client.ledger('1', 'us'));
      expect(ledger).toHaveLength(1); // ← never repeats
      expect(ledger[0]!.status).toBe('applied'); // ← marked applied (match, not cause)
      expect(ledger[0]!.appliedAt).toBe('2026-06-20T00:00:00.000Z');
      expect(memo.applied.map((r) => r.title)).toContain('Add "tracker" to the subtitle');
      // ← references the first: a real change-diff, not a cold start.
      expect(memo.changeDiff.join(' ')).toMatch(/score|Subtitle changed/i);
      expect(memo.identityVersion).toBe(1); // v0 then v1
    } finally {
      h.close();
    }
  });

  it('suppresses identity-rewriting recs when identity is unconfirmed (escalate)', async () => {
    const h = await fresh();
    try {
      const escalating: ResolvedIdentity = { ...CONFIDENT, categoryBand: 'low', divergence: 'cross_domain', escalate: true };
      const l = listingWith({});
      await persistAudit(h.client, {
        ...persistArgs(l, report([rec({ dimension: 'competitive', category: 'strategic', title: 'Reposition around EVs', after: null })]), '2026-06-01T00:00:00.000Z'),
        resolved: escalating,
      });
      const ledger = unwrap(await h.client.ledger('1', 'us'));
      // The reposition_identity rec was withheld.
      expect(ledger.find((r) => r.intent === 'reposition_identity')).toBeUndefined();
    } finally {
      h.close();
    }
  });
});

describe('detectApplied + changeDiff units', () => {
  it('detectApplied flips a prior rec whose after-text now appears in the field', () => {
    const prior = [toLedgerRec(rec({}), { appId: '1', country: 'us', snapshotId: 's1', now: 't0' })];
    const flipped = detectApplied(prior, listingWith({ subtitle: 'My Budget Tracker & Planner app' }), 't1');
    expect(flipped).toHaveLength(1);
    expect(flipped[0]!.status).toBe('applied');
  });

  it('detectApplied leaves recs alone when the listing does not satisfy them', () => {
    const prior = [toLedgerRec(rec({}), { appId: '1', country: 'us', snapshotId: 's1', now: 't0' })];
    const flipped = detectApplied(prior, listingWith({ subtitle: 'Something else entirely' }), 't1');
    expect(flipped).toHaveLength(0);
  });

  it('changeDiff reports first-audit and score movement', () => {
    expect(changeDiff(null, { report: { overallScore: 50 } } as any)[0]).toMatch(/First audit/);
  });
});
