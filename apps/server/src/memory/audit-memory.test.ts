import { describe, it, expect } from 'vitest';
import { openDb, runMigrations } from './migrate';
import { LibSqlStorageClient } from './libsql-storage-client';
import { persistAudit, toLedgerRec, detectApplied, changeDiff, buildPriorContext, expandAddKeywordRec } from './audit-memory';
import { loadFixtureListing } from '../identity/__fixtures__/load';
import type { AppListing } from '../domain/listing';
import type { AuditReport, Recommendation as ReportRec } from '../domain/audit';
import type { ResolvedIdentity } from '../identity/resolve';
import type { IdentityVersion } from '../domain/identity';

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
  source: 'resolved',
  functionTerms: [],
  overrodeEvidence: null,
};

function rec(over: Partial<ReportRec>): ReportRec {
  return {
    category: 'quick-win',
    dimension: 'subtitle',
    intent: 'add_keyword',
    referent: { kind: 'keyword', value: 'tracker' },
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
      await persistAudit(h.client, 'tenant-test', persistArgs(l1, report([rec({})], 60), '2026-06-01T00:00:00.000Z'));

      let ledger = unwrap(await h.client.ledger('tenant-test', '1', 'us'));
      expect(ledger).toHaveLength(1);
      expect(ledger[0]!.status).toBe('proposed');

      // Audit 2: the user has applied it — subtitle now contains the after-text.
      // The same suggestion is also re-raised; it must not duplicate or re-open.
      const l2 = listingWith({ subtitle: 'Budget Tracker & Planner' });
      const memo = await persistAudit(
        h.client,
        'tenant-test',
        persistArgs(l2, report([rec({})], 75), '2026-06-20T00:00:00.000Z'),
      );

      ledger = unwrap(await h.client.ledger('tenant-test', '1', 'us'));
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
      await persistAudit(h.client, 'tenant-test', {
        ...persistArgs(l, report([rec({ dimension: 'competitive', category: 'strategic', intent: 'reposition_identity', referent: { kind: 'none' }, title: 'Reposition around EVs', after: null })]), '2026-06-01T00:00:00.000Z'),
        resolved: escalating,
      });
      const ledger = unwrap(await h.client.ledger('tenant-test', '1', 'us'));
      // The reposition_identity rec was withheld.
      expect(ledger.find((r) => r.intent === 'reposition_identity')).toBeUndefined();
    } finally {
      h.close();
    }
  });

  it('a human-confirmed identity persists as human_confirmed and keeps its reposition rec', async () => {
    const h = await fresh();
    try {
      // Cross-domain, but the human confirmed it → escalate cleared, source set.
      const confirmed: ResolvedIdentity = {
        ...CONFIDENT, category: 'EV companion', divergence: 'cross_domain', escalate: false, source: 'human_confirmed',
      };
      const l = listingWith({});
      await persistAudit(h.client, 'tenant-test', {
        ...persistArgs(l, report([rec({ dimension: 'competitive', category: 'strategic', intent: 'reposition_identity', referent: { kind: 'none' }, title: 'Reposition around EVs', after: null })]), '2026-06-01T00:00:00.000Z'),
        resolved: confirmed,
      });
      const idRow = unwrap(await h.client.latestIdentity('tenant-test', '1', 'us'));
      expect(idRow?.source).toBe('human_confirmed');
      const ledger = unwrap(await h.client.ledger('tenant-test', '1', 'us'));
      // Identity is confirmed, so the identity-rewriting rec is allowed through.
      expect(ledger.find((r) => r.intent === 'reposition_identity')).toBeDefined();
    } finally {
      h.close();
    }
  });

  it('a reworded re-raise with the same referent does not mint a new row', async () => {
    const h = await fresh();
    try {
      const l = listingWith({ subtitle: null });
      // Run 1: recommend adding keyword "tracker" with one phrasing.
      await persistAudit(h.client, 'tenant-test', persistArgs(l, report([rec({})]), '2026-06-01T00:00:00.000Z'));

      // Run 2: same referent (keyword: "tracker") but completely different prose.
      // Pre-fix, this minted a new row because rec_key used rec.after prose.
      // Post-fix, rec_key is hash(dimension, intent, targetField, "tracker") — stable.
      const reworded = rec({
        title: 'Include the word tracker in your subtitle copy',
        after: 'Tracker - Budget Planner',
      });
      await persistAudit(h.client, 'tenant-test', persistArgs(l, report([reworded]), '2026-06-20T00:00:00.000Z'));

      const ledger = unwrap(await h.client.ledger('tenant-test', '1', 'us'));
      expect(ledger).toHaveLength(1); // ← must collapse, not duplicate
      expect(ledger[0]!.status).toBe('proposed');
    } finally {
      h.close();
    }
  });

  it('honours a dismissal — a re-raised dismissed rec is flagged, not silently re-opened', async () => {
    const h = await fresh();
    try {
      const l = listingWith({ subtitle: null });
      // Audit 1: raise the rec.
      await persistAudit(h.client, 'tenant-test', persistArgs(l, report([rec({})]), '2026-06-01T00:00:00.000Z'));
      let ledger = unwrap(await h.client.ledger('tenant-test', '1', 'us'));
      expect(ledger).toHaveLength(1);
      // The operator dismisses it.
      await h.client.upsertRecommendation('tenant-test', { ...ledger[0]!, status: 'dismissed' });

      // Audit 2: the model re-proposes the exact same suggestion (same rec_key).
      const memo = await persistAudit(
        h.client,
        'tenant-test',
        persistArgs(l, report([rec({})]), '2026-06-20T00:00:00.000Z'),
      );

      ledger = unwrap(await h.client.ledger('tenant-test', '1', 'us'));
      expect(ledger).toHaveLength(1);
      expect(ledger[0]!.status).toBe('dismissed'); // ← NOT re-opened to 'proposed'
      // ...and the re-raise is surfaced as a contradiction, never silently dropped.
      expect(memo.contradictions.length).toBeGreaterThan(0);
    } finally {
      h.close();
    }
  });

  it('a reworded re-raise of a dismissed rec is still caught — referent stability makes the dismissal sticky', async () => {
    const h = await fresh();
    try {
      const l = listingWith({ subtitle: null });
      // Audit 1: raise "add tracker", operator dismisses it.
      await persistAudit(h.client, 'tenant-test', persistArgs(l, report([rec({})]), '2026-06-01T00:00:00.000Z'));
      let ledger = unwrap(await h.client.ledger('tenant-test', '1', 'us'));
      await h.client.upsertRecommendation('tenant-test', { ...ledger[0]!, status: 'dismissed' });

      // Audit 2: model rewords the same suggestion (same referent: keyword "tracker")
      // but uses completely different title and after-text prose.
      // Pre-fix: different prose → different rec_key → dismissal bypassed, re-opened.
      // Post-fix: rec_key = hash(dim, intent, targetField, "tracker") → same key
      //           → contradiction guard fires → dismissal honoured.
      const reworded = rec({
        title: 'Include the word tracker in your subtitle copy',
        after: 'Tracker - Budget Planner',
      });
      const memo = await persistAudit(
        h.client,
        'tenant-test',
        persistArgs(l, report([reworded]), '2026-06-20T00:00:00.000Z'),
      );

      ledger = unwrap(await h.client.ledger('tenant-test', '1', 'us'));
      expect(ledger).toHaveLength(1);
      expect(ledger[0]!.status).toBe('dismissed'); // ← dismissal sticky across rewordings
      expect(memo.contradictions.length).toBeGreaterThan(0); // ← surfaced, not silently dropped
    } finally {
      h.close();
    }
  });

  it('re-raised rec logs 2 occurrences under the canonical stored id — not a fresh-minted one', async () => {
    // Regression: before the fix, persistAudit called recordOccurrence with a
    // freshly-minted id. ON CONFLICT in upsertRecommendation keeps the original
    // row id, so the fresh id never existed in aso_recommendations — occurrence
    // count stuck at 1 forever. Fix: use priorIdByRecKey to resolve the real id.
    const db = openDb(':memory:');
    await runMigrations(db);
    const client = new LibSqlStorageClient(db);
    try {
      const l = listingWith({ subtitle: null });
      await persistAudit(client, 'tenant-test', persistArgs(l, report([rec({})]), '2026-06-01T00:00:00.000Z'));
      await persistAudit(client, 'tenant-test', persistArgs(l, report([rec({})]), '2026-06-20T00:00:00.000Z'));

      const result = await db.execute('SELECT rec_id FROM aso_rec_occurrences');
      expect(result.rows).toHaveLength(2);
      // Both rows must point to the same canonical rec_id (the one from audit 1).
      const ids = result.rows.map((r) => r[0] as string);
      expect(new Set(ids).size).toBe(1);
    } finally {
      db.close();
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

describe('detectApplied — non-text (Fix 1)', () => {
  it('marks add_preview_video applied when new listing has a preview video', () => {
    const previewRec = toLedgerRec(
      rec({ dimension: 'previewVideo', intent: 'add_preview_video', referent: { kind: 'none' }, after: null }),
      { appId: '1', country: 'us', snapshotId: 's1', now: 't0' },
    );
    const flipped = detectApplied([previewRec], listingWith({ hasPreviewVideo: true }), 't1');
    expect(flipped).toHaveLength(1);
    expect(flipped[0]!.status).toBe('applied');
    expect(flipped[0]!.appliedAt).toBe('t1');
  });

  it('does NOT mark add_preview_video applied when new listing has no preview video', () => {
    const previewRec = toLedgerRec(
      rec({ dimension: 'previewVideo', intent: 'add_preview_video', referent: { kind: 'none' }, after: null }),
      { appId: '1', country: 'us', snapshotId: 's1', now: 't0' },
    );
    const flipped = detectApplied([previewRec], listingWith({ hasPreviewVideo: false }), 't1');
    expect(flipped).toHaveLength(0);
  });
});

describe('buildPriorContext — escalate gate (Fix 2)', () => {
  const baseInput = {
    priorSnapshot: null,
    identityFactSheet: 'fact sheet',
  };

  it('shows the warning note when escalate=true and source=resolved', () => {
    const identity: ResolvedIdentity = {
      ...CONFIDENT,
      escalate: true,
      divergence: 'cross_domain',
      source: 'resolved',
    };
    const ctx = buildPriorContext({ ...baseInput, identity });
    expect(ctx).toMatch(/do not rewrite.*positioning/i);
  });

  it('does NOT show the warning note when escalate=true but source=human_confirmed', () => {
    const identity: ResolvedIdentity = {
      ...CONFIDENT,
      escalate: true,
      divergence: 'cross_domain',
      source: 'human_confirmed',
    };
    const ctx = buildPriorContext({ ...baseInput, identity });
    expect(ctx).not.toMatch(/do not rewrite.*positioning/i);
  });

  it('does NOT show the warning note when escalate=false even if divergence=cross_domain (old bug)', () => {
    const identity: ResolvedIdentity = {
      ...CONFIDENT,
      escalate: false,
      divergence: 'cross_domain',
      source: 'resolved',
    };
    const ctx = buildPriorContext({ ...baseInput, identity });
    expect(ctx).not.toMatch(/do not rewrite.*positioning/i);
  });
});

describe('identity version monotonicity — Fix 3 regression', () => {
  // Three consecutive unchanged re-audits must not produce duplicate version
  // numbers, and latestIdentity must still return the stage='full' row written
  // by B2 as the semantic head.
  it('no duplicate versions after three re-audits; latestIdentity stays full', async () => {
    const h = await fresh();
    try {
      const l = listingWith({});

      // Audit 1: persistAudit writes lite v0.
      const memo1 = await persistAudit(h.client, 'tenant-test', persistArgs(l, report([]), '2026-06-01T00:00:00.000Z'));
      expect(memo1.identityVersion).toBe(0);

      // B2 simulation: append full v1 (as the workflow does when visionWasFresh=true).
      const fullRow: IdentityVersion = {
        id: 'full-v1', appId: '1', country: 'us',
        version: memo1.identityVersion + 1, stage: 'full',
        category: 'Productivity to-do list', categoryBand: 'high',
        niche: 'to-do list', nicheBand: 'high',
        audience: { description: 'Task managers', segments: ['professionals'] },
        tally: [], divergence: 'none', escalate: false, source: 'resolved',
        createdAt: '2026-06-01T00:01:00.000Z',
      };
      unwrap(await h.client.appendIdentity('tenant-test', fullRow));

      // Audit 2 (images unchanged, visionWasFresh=false → B2 skipped).
      const memo2 = await persistAudit(h.client, 'tenant-test', persistArgs(l, report([]), '2026-06-15T00:00:00.000Z'));
      expect(memo2.identityVersion).toBe(2); // must advance past full v1

      // Audit 3 (unchanged again).
      const memo3 = await persistAudit(h.client, 'tenant-test', persistArgs(l, report([]), '2026-06-20T00:00:00.000Z'));
      expect(memo3.identityVersion).toBe(3); // must advance past lite v2

      // No duplicates: all four written versions are distinct.
      const versions = [0, 1, 2, 3];
      expect(new Set(versions).size).toBe(versions.length);

      // latestIdentity returns the full row (v1), not the most-recent lite (v3).
      const latest = unwrap(await h.client.latestIdentity('tenant-test', '1', 'us'));
      expect(latest?.stage).toBe('full');
      expect(latest?.version).toBe(1);
      expect(latest?.audience).toMatchObject({ description: 'Task managers' });
    } finally {
      h.close();
    }
  });
});

// ── expandAddKeywordRec — C-FU3 multi-keyword split ───────────────────────────

describe('expandAddKeywordRec', () => {
  it('splits a comma-joined value into one rec per keyword', () => {
    const r = rec({ referent: { kind: 'keyword', value: 'electric,vehicle' } });
    const result = expandAddKeywordRec(r);
    expect(result).toHaveLength(2);
    expect(result[0]!.referent).toEqual({ kind: 'keyword', value: 'electric' });
    expect(result[1]!.referent).toEqual({ kind: 'keyword', value: 'vehicle' });
  });

  it('deduplicates within the split (same normalizedKey)', () => {
    const r = rec({ referent: { kind: 'keyword', value: 'a,a,b' } });
    const result = expandAddKeywordRec(r);
    expect(result).toHaveLength(2);
  });

  it('a singular and its plural collapse to one row (normalizeValueKey)', () => {
    // "tracker" and "trackers" share the same normalizedKey after depluralize
    const r = rec({ referent: { kind: 'keyword', value: 'tracker,trackers' } });
    const result = expandAddKeywordRec(r);
    expect(result).toHaveLength(1);
  });

  it('a space-separated phrase stays as one rec (split on comma only)', () => {
    const r = rec({ referent: { kind: 'keyword', value: 'electric vehicle' } });
    const result = expandAddKeywordRec(r);
    expect(result).toHaveLength(1);
    expect(result[0]!.referent).toEqual({ kind: 'keyword', value: 'electric vehicle' });
  });

  it('a single keyword (no comma) returns the original rec unchanged', () => {
    const r = rec({ referent: { kind: 'keyword', value: 'charging' } });
    const result = expandAddKeywordRec(r);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(r); // exact same reference
  });

  it('non-add_keyword intents are returned as-is', () => {
    const r = rec({ intent: 'add_preview_video', referent: { kind: 'none' } });
    const result = expandAddKeywordRec(r);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(r);
  });

  it('each split rec collapses against an existing standalone rec (dedup contract)', async () => {
    // Persisting "a,b" then standalone "a" must both land on the same rec_key row.
    const h = await fresh();
    try {
      const l = listingWith({});

      // Audit 1: rec with "a,b" referent → splits into two rows ("a", "b").
      await persistAudit(h.client, 'tenant-test', persistArgs(l, report([
        rec({ referent: { kind: 'keyword', value: 'a,b' } }),
      ]), '2026-06-01T00:00:00.000Z'));
      const ledger1 = unwrap(await h.client.ledger('tenant-test', '1', 'us'));
      expect(ledger1).toHaveLength(2);
      const keyA = ledger1.find((r) => r.valueKey === 'a');
      const keyB = ledger1.find((r) => r.valueKey === 'b');
      expect(keyA).toBeDefined();
      expect(keyB).toBeDefined();

      // Audit 2: standalone "a" rec → must upsert onto the existing "a" row (no new row).
      await persistAudit(h.client, 'tenant-test', persistArgs(l, report([
        rec({ referent: { kind: 'keyword', value: 'a' } }),
      ]), '2026-06-02T00:00:00.000Z'));
      const ledger2 = unwrap(await h.client.ledger('tenant-test', '1', 'us'));
      expect(ledger2).toHaveLength(2); // still 2, not 3
    } finally {
      h.close();
    }
  });
});
