import { describe, it, expect } from 'vitest';
import type { StorageClient } from './storage-client';
import type { ListingSnapshot } from '../domain/snapshot';
import type { LedgerRecommendation } from '../domain/recommendation';
import type { IdentityVersion } from '../domain/identity';
import { AppListingSchema, type AppListing } from '../domain/listing';

/**
 * The engine-agnostic `StorageClient` conformance suite.
 *
 * This is the *same suite* §F/6a says the future Postgres client must pass: it
 * is written against the `StorageClient` interface and a `makeClient` factory,
 * never against SQL. To certify a new engine, call `storageClientConformance`
 * with a factory for it — nothing else changes.
 */
export interface ConformanceHarness {
  /** A fresh, empty, migrated store. */
  client: StorageClient;
  /** Release resources (close the DB). */
  close: () => void;
}

// ── Minimal valid domain fixtures (synthetic — no live data needed) ──────────

function listing(appId = 'app1', country = 'us'): AppListing {
  return AppListingSchema.parse({
    appId,
    country,
    url: `https://apps.apple.com/${country}/app/id${appId}`,
    name: 'Test App',
    developer: 'Test Dev',
    iconUrl: null,
    primaryGenre: 'Productivity',
    genres: ['Productivity'],
    price: 0,
    formattedPrice: 'Free',
    subtitle: null,
    promotionalText: null,
    description: 'A test app.',
    releaseNotes: null,
    version: '1.0.0',
    screenshotUrls: [],
    ipadScreenshotUrls: [],
    hasPreviewVideo: false,
    averageRating: 4.5,
    ratingCount: 100,
    currentVersionRating: 4.5,
    currentVersionRatingCount: 10,
    contentRating: '4+',
    releaseDate: null,
    currentVersionReleaseDate: null,
    reviews: [],
    competitors: [],
    provenance: { itunes: true, crawler: false, reviews: false, competitors: false },
  });
}

function report(appId = 'app1', country = 'us') {
  return {
    app: {
      appId,
      country,
      url: `https://apps.apple.com/${country}/app/id${appId}`,
      name: 'Test App',
      developer: 'Test Dev',
      iconUrl: null,
      primaryGenre: 'Productivity',
      averageRating: 4.5,
      ratingCount: 100,
    },
    generatedAt: '2026-06-24T00:00:00.000Z',
    headline: 'A solid listing.',
    overallScore: 72,
    dimensions: [],
    quickWins: [],
    highImpact: [],
    strategic: [],
    competitorComparison: { summary: 'n/a', rows: [] },
    limitations: [],
  };
}

function snapshot(over: Partial<ListingSnapshot> = {}): ListingSnapshot {
  const appId = over.appId ?? 'app1';
  const country = over.country ?? 'us';
  return {
    id: over.id ?? 'snap-1',
    appId,
    country,
    fetchedAt: over.fetchedAt ?? '2026-06-24T00:00:00.000Z',
    listing: over.listing ?? listing(appId, country),
    signals: over.signals ?? { ok: true },
    report: over.report ?? (report(appId, country) as ListingSnapshot['report']),
    rubricVersion: over.rubricVersion ?? 'rubric-abc',
    promptHash: over.promptHash ?? 'prompt-xyz',
    modelId: over.modelId ?? 'gemini-2.5-flash',
    // Optional blobs — passed through explicitly so round-trip tests can set them.
    visionResult: over.visionResult,
    candidateResult: over.candidateResult,
    themeResult: over.themeResult,
    functionCompetitorSeeds: over.functionCompetitorSeeds,
    competitorMiningResult: over.competitorMiningResult,
  };
}

function rec(over: Partial<LedgerRecommendation> = {}): LedgerRecommendation {
  return {
    id: over.id ?? 'rec-1',
    appId: over.appId ?? 'app1',
    country: over.country ?? 'us',
    recKey: over.recKey ?? 'key-1',
    valueKey: over.valueKey ?? 'tracker',
    taxonomyVersion: over.taxonomyVersion ?? null,
    dimension: over.dimension ?? 'keywords',
    intent: over.intent ?? 'add_keyword',
    targetField: over.targetField ?? 'subtitle',
    title: over.title ?? 'Add "tracker" to the subtitle',
    body: over.body ?? 'It is a high-intent term you do not rank for.',
    beforeText: over.beforeText ?? null,
    afterText: over.afterText ?? null,
    evidence: over.evidence ?? [{ kind: 'listing_field', field: 'subtitle', snapshotId: 'snap-1' }],
    status: over.status ?? 'proposed',
    supersededBy: over.supersededBy ?? null,
    firstSeenAt: over.firstSeenAt ?? '2026-06-24T00:00:00.000Z',
    lastSeenAt: over.lastSeenAt ?? '2026-06-24T00:00:00.000Z',
    appliedAt: over.appliedAt ?? null,
    proofRegime: over.proofRegime ?? 'correlational',
  };
}

function identity(over: Partial<IdentityVersion> = {}): IdentityVersion {
  return {
    id: over.id ?? 'id-1',
    appId: over.appId ?? 'app1',
    country: over.country ?? 'us',
    version: over.version ?? 0,
    stage: over.stage ?? 'lite',
    category: over.category ?? 'Productivity',
    categoryBand: over.categoryBand ?? 'high',
    niche: over.niche ?? 'to-do list',
    nicheBand: over.nicheBand ?? 'medium',
    audience: over.audience ?? null,
    tally: over.tally ?? [
      {
        family: 'developer',
        value: 'Test Dev',
        sourceTier: 'observed_on_store',
        agrees: true,
        fetchedAt: '2026-06-24T00:00:00.000Z',
      },
    ],
    divergence: over.divergence ?? 'none',
    escalate: over.escalate ?? false,
    source: over.source ?? 'resolved',
    overrodeEvidence: over.overrodeEvidence ?? null,
    createdAt: over.createdAt ?? '2026-06-24T00:00:00.000Z',
  };
}

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error}`);
  return r.value;
};

/** Run the full contract against a freshly-made client from `makeClient`. */
export function storageClientConformance(
  engineName: string,
  makeClient: () => Promise<ConformanceHarness>,
): void {
  describe(`StorageClient conformance — ${engineName}`, () => {
    // ── Snapshots ────────────────────────────────────────────────────────
    it('round-trips a snapshot through put/latest, preserving domain types', async () => {
      const h = await makeClient();
      try {
        unwrap(await h.client.putSnapshot(snapshot()));
        const got = unwrap(await h.client.latestSnapshot('app1', 'us'));
        expect(got).not.toBeNull();
        expect(got?.id).toBe('snap-1');
        // Nested domain objects survive serialisation intact.
        expect(got?.listing.name).toBe('Test App');
        expect(got?.report.overallScore).toBe(72);
        expect(got?.modelId).toBe('gemini-2.5-flash');
      } finally {
        h.close();
      }
    });

    it('latestSnapshot returns the most recent by fetched_at', async () => {
      const h = await makeClient();
      try {
        unwrap(await h.client.putSnapshot(snapshot({ id: 'old', fetchedAt: '2026-06-01T00:00:00.000Z' })));
        unwrap(await h.client.putSnapshot(snapshot({ id: 'new', fetchedAt: '2026-06-20T00:00:00.000Z' })));
        const got = unwrap(await h.client.latestSnapshot('app1', 'us'));
        expect(got?.id).toBe('new');
      } finally {
        h.close();
      }
    });

    it('latestSnapshot returns null when there is no history', async () => {
      const h = await makeClient();
      try {
        expect(unwrap(await h.client.latestSnapshot('nobody', 'us'))).toBeNull();
      } finally {
        h.close();
      }
    });

    it('isolates snapshots by (app_id, country)', async () => {
      const h = await makeClient();
      try {
        unwrap(await h.client.putSnapshot(snapshot({ id: 's-us', country: 'us' })));
        unwrap(await h.client.putSnapshot(snapshot({ id: 's-gb', country: 'gb' })));
        expect(unwrap(await h.client.latestSnapshot('app1', 'us'))?.id).toBe('s-us');
        expect(unwrap(await h.client.latestSnapshot('app1', 'gb'))?.id).toBe('s-gb');
      } finally {
        h.close();
      }
    });

    // ── Snapshot optional blobs (visionResult / candidateResult) ────────────
    it('round-trips visionResult through put/latest (B1 regression guard)', async () => {
      const h = await makeClient();
      try {
        const vr = { screenshotSetVerdict: { coarseScore: 8, confidence: 'observed', critiques: [], competitorComparison: { value: null } } };
        unwrap(await h.client.putSnapshot(snapshot({ visionResult: vr })));
        const got = unwrap(await h.client.latestSnapshot('app1', 'us'));
        expect(got?.visionResult).toEqual(vr);
      } finally {
        h.close();
      }
    });

    it('round-trips candidateResult through put/latest (C4 regression guard)', async () => {
      const h = await makeClient();
      try {
        const cr = { candidates: [{ term: 'charging', normalizedKey: 'charging', source: 'description', volumeLabel: 'popularity unavailable', volumeAvailable: false }], gap: [], popularityAvailable: false };
        unwrap(await h.client.putSnapshot(snapshot({ candidateResult: cr })));
        const got = unwrap(await h.client.latestSnapshot('app1', 'us'));
        expect(got?.candidateResult).toEqual(cr);
      } finally {
        h.close();
      }
    });

    it('round-trips themeResult through put/latest (D2 regression guard)', async () => {
      const h = await makeClient();
      try {
        const tr = {
          themes: [
            { bucket: 'crash_stability', text: 'App crashes on launch', reviewIds: ['r1', 'r2'], isUnresolved: false },
          ],
          versionDelta: { olderVersion: '3.12.0', newerVersion: '3.13.0', olderAvgRating: 2.5, newerAvgRating: 3.8, delta: 1.3 },
          featureRequests: ['Offline mode'],
          taxonomyVersion: 'theme-taxonomy@1',
        };
        unwrap(await h.client.putSnapshot(snapshot({ themeResult: tr })));
        const got = unwrap(await h.client.latestSnapshot('app1', 'us'));
        expect(got?.themeResult).toEqual(tr);
      } finally {
        h.close();
      }
    });

    it('round-trips functionCompetitorSeeds through put/latest (D3 regression guard)', async () => {
      const h = await makeClient();
      try {
        const seeds = ['ev charging', 'electric vehicle'];
        unwrap(await h.client.putSnapshot(snapshot({ functionCompetitorSeeds: seeds })));
        const got = unwrap(await h.client.latestSnapshot('app1', 'us'));
        expect(got?.functionCompetitorSeeds).toEqual(seeds);
      } finally {
        h.close();
      }
    });

    it('round-trips competitorMiningResult through put/latest (F-K2 regression guard)', async () => {
      const h = await makeClient();
      try {
        const mining = { painPoints: [{ bucket: 'crash_stability', text: 'App crashes', reviewCount: 5, competitors: ['CompA'] }], competitorsCovered: ['CompA'], lowRatingReviewCount: 5 };
        unwrap(await h.client.putSnapshot(snapshot({ competitorMiningResult: mining })));
        const got = unwrap(await h.client.latestSnapshot('app1', 'us'));
        expect(got?.competitorMiningResult).toEqual(mining);
      } finally {
        h.close();
      }
    });

    it('leaves visionResult, candidateResult, themeResult, functionCompetitorSeeds, and competitorMiningResult undefined when absent', async () => {
      const h = await makeClient();
      try {
        unwrap(await h.client.putSnapshot(snapshot()));
        const got = unwrap(await h.client.latestSnapshot('app1', 'us'));
        expect(got?.visionResult).toBeUndefined();
        expect(got?.candidateResult).toBeUndefined();
        expect(got?.themeResult).toBeUndefined();
        expect(got?.functionCompetitorSeeds).toBeUndefined();
        expect(got?.competitorMiningResult).toBeUndefined();
      } finally {
        h.close();
      }
    });

    // ── Recommendations + dedup-by-rec_key ───────────────────────────────
    it('inserts a recommendation and reads it back from the ledger', async () => {
      const h = await makeClient();
      try {
        unwrap(await h.client.upsertRecommendation(rec()));
        const ledger = unwrap(await h.client.ledger('app1', 'us'));
        expect(ledger).toHaveLength(1);
        expect(ledger[0]!.recKey).toBe('key-1');
      } finally {
        h.close();
      }
    });

    it('upserts on rec_key — a re-raise is one row with bumped last_seen_at and refreshed evidence', async () => {
      const h = await makeClient();
      try {
        unwrap(await h.client.upsertRecommendation(rec({ id: 'rec-1', lastSeenAt: '2026-06-01T00:00:00.000Z' })));
        unwrap(
          await h.client.upsertRecommendation(
            rec({
              id: 'rec-2', // a different id, same logical rec_key
              recKey: 'key-1',
              lastSeenAt: '2026-06-20T00:00:00.000Z',
              body: 'Re-raised with fresher wording.',
              evidence: [{ kind: 'listing_field', field: 'subtitle', snapshotId: 'snap-2' }],
            }),
          ),
        );
        const ledger = unwrap(await h.client.ledger('app1', 'us'));
        expect(ledger).toHaveLength(1);
        expect(ledger[0]!.lastSeenAt).toBe('2026-06-20T00:00:00.000Z');
        expect(ledger[0]!.body).toBe('Re-raised with fresher wording.');
        expect(ledger[0]!.evidence[0]).toMatchObject({ snapshotId: 'snap-2' });
      } finally {
        h.close();
      }
    });

    it('keeps two different rec_keys as two distinct rows', async () => {
      const h = await makeClient();
      try {
        unwrap(await h.client.upsertRecommendation(rec({ id: 'r1', recKey: 'key-tracker', valueKey: 'tracker' })));
        unwrap(await h.client.upsertRecommendation(rec({ id: 'r2', recKey: 'key-budget', valueKey: 'budget' })));
        const ledger = unwrap(await h.client.ledger('app1', 'us'));
        expect(ledger).toHaveLength(2);
        expect(new Set(ledger.map((r) => r.recKey))).toEqual(new Set(['key-tracker', 'key-budget']));
      } finally {
        h.close();
      }
    });

    // ── Occurrences ──────────────────────────────────────────────────────
    it('records an occurrence and is idempotent on (rec_id, snapshot_id)', async () => {
      const h = await makeClient();
      try {
        unwrap(await h.client.upsertRecommendation(rec({ id: 'rec-1' })));
        unwrap(await h.client.putSnapshot(snapshot({ id: 'snap-1' })));
        unwrap(await h.client.recordOccurrence('rec-1', 'snap-1', false));
        // Running again must not throw on the composite primary key.
        unwrap(await h.client.recordOccurrence('rec-1', 'snap-1', true));
      } finally {
        h.close();
      }
    });

    // ── Identity ─────────────────────────────────────────────────────────
    it('appends identity versions and latestIdentity returns the highest version', async () => {
      const h = await makeClient();
      try {
        unwrap(await h.client.appendIdentity(identity({ id: 'v0', version: 0, category: 'Productivity' })));
        unwrap(await h.client.appendIdentity(identity({ id: 'v1', version: 1, category: 'Utilities', stage: 'full' })));
        const got = unwrap(await h.client.latestIdentity('app1', 'us'));
        expect(got?.version).toBe(1);
        expect(got?.category).toBe('Utilities');
        expect(got?.stage).toBe('full');
        // Tally (a nested array) survives the round-trip.
        expect(got?.tally[0]?.family).toBe('developer');
      } finally {
        h.close();
      }
    });

    it('latestIdentity prefers the full row even when a newer lite row exists', async () => {
      const h = await makeClient();
      try {
        unwrap(await h.client.appendIdentity(identity({ id: 'v0', version: 0 })));
        unwrap(await h.client.appendIdentity(identity({ id: 'v1', version: 1, stage: 'full', category: 'Navigation' })));
        unwrap(await h.client.appendIdentity(identity({ id: 'v2', version: 2, stage: 'lite', category: 'Updated' })));
        const got = unwrap(await h.client.latestIdentity('app1', 'us'));
        // v2 is newest by version but full row (v1) should win.
        expect(got?.stage).toBe('full');
        expect(got?.version).toBe(1);
        expect(got?.category).toBe('Navigation');
      } finally {
        h.close();
      }
    });

    it('maxIdentityVersion returns the true MAX regardless of stage', async () => {
      const h = await makeClient();
      try {
        expect(unwrap(await h.client.maxIdentityVersion('app1', 'us'))).toBe(-1); // empty
        unwrap(await h.client.appendIdentity(identity({ id: 'v0', version: 0 })));
        unwrap(await h.client.appendIdentity(identity({ id: 'v1', version: 1, stage: 'full' })));
        unwrap(await h.client.appendIdentity(identity({ id: 'v2', version: 2, stage: 'lite' })));
        expect(unwrap(await h.client.maxIdentityVersion('app1', 'us'))).toBe(2);
      } finally {
        h.close();
      }
    });

    it('latestIdentity returns null when none exists', async () => {
      const h = await makeClient();
      try {
        expect(unwrap(await h.client.latestIdentity('nobody', 'us'))).toBeNull();
      } finally {
        h.close();
      }
    });

    it('round-trips a populated overrodeEvidence marker through append/latestIdentity', async () => {
      const h = await makeClient();
      try {
        const marker = {
          category: 'Electric vehicle companion',
          niche: 'EV companion',
          functionTerms: ['truck'],
        };
        unwrap(
          await h.client.appendIdentity(
            identity({ id: 'id-override', source: 'human_confirmed', overrodeEvidence: marker }),
          ),
        );
        const got = unwrap(await h.client.latestIdentity('app1', 'us'));
        expect(got).not.toBeNull();
        expect(got?.overrodeEvidence).toEqual(marker);
      } finally {
        h.close();
      }
    });

    it('round-trips a null overrodeEvidence marker through append/latestIdentity', async () => {
      const h = await makeClient();
      try {
        unwrap(
          await h.client.appendIdentity(
            identity({ id: 'id-no-override', source: 'resolved', overrodeEvidence: null }),
          ),
        );
        const got = unwrap(await h.client.latestIdentity('app1', 'us'));
        expect(got).not.toBeNull();
        expect(got?.overrodeEvidence).toBeNull();
      } finally {
        h.close();
      }
    });

    // ── Competitor tombstones (app-scoped, version-independent) ───────────
    it('tombstones a competitor and reports it in the app-scoped set, idempotently', async () => {
      const h = await makeClient();
      try {
        unwrap(await h.client.tombstoneCompetitor('app1', 'us', 'comp-99'));
        unwrap(await h.client.tombstoneCompetitor('app1', 'us', 'comp-99')); // idempotent
        unwrap(await h.client.tombstoneCompetitor('app1', 'us', 'comp-7'));
        const set = unwrap(await h.client.tombstones('app1', 'us'));
        expect(set).toEqual(new Set(['comp-99', 'comp-7']));
        // Different app shares nothing.
        expect(unwrap(await h.client.tombstones('other', 'us')).size).toBe(0);
      } finally {
        h.close();
      }
    });
  });
}
