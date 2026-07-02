import { describe, it, expect } from 'vitest';
import { generateCandidates, formatCandidatesForPrompt, selectCandidateResult, suppressCompetitorGapTerms } from './candidates';
import type { CandidateResult } from './candidates';
import { StubAsaClient } from './asa-client';
import type { AppListing } from '../domain/listing';
import type { ListingSnapshot } from '../domain/snapshot';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeListing(overrides: Partial<AppListing> = {}): AppListing {
  return {
    appId: '1',
    country: 'us',
    url: 'https://apps.apple.com/us/app/id1',
    name: 'Rivian',
    developer: 'Rivian Automotive',
    bundleId: null,
    sellerUrl: null,
    iconUrl: null,
    primaryGenre: 'Utilities',
    genres: ['Utilities'],
    price: 0,
    formattedPrice: 'Free',
    subtitle: null,
    promotionalText: null,
    description: 'Control your electric vehicle from your phone. Monitor charging and range.',
    releaseNotes: null,
    version: '1.0',
    screenshotUrls: [],
    ipadScreenshotUrls: [],
    hasPreviewVideo: false,
    crawledScreenshotCount: 0,
    averageRating: 4.5,
    ratingCount: 1000,
    currentVersionRating: null,
    currentVersionRatingCount: null,
    contentRating: '4+',
    releaseDate: '2020-01-01T00:00:00Z',
    currentVersionReleaseDate: '2024-01-01T00:00:00Z',
    reviews: [],
    competitors: [],
    provenance: { itunes: true, crawler: false, reviews: false, competitors: false, observedFromCache: false },
    ...overrides,
  };
}

/** Minimal CandidateResult for reuse tests. */
const STUB_CANDIDATE_RESULT: CandidateResult = {
  candidates: [{ term: 'electric', normalizedKey: 'electric', source: 'description', volumeLabel: 'popularity unavailable', volumeAvailable: false }],
  gap: [],
  popularityAvailable: false,
};

/** Minimal snapshot carrying the listing and a stored candidateResult. */
function makeSnapshot(listing: AppListing, candidateResult?: unknown): ListingSnapshot {
  return {
    id: 'snap-1',
    appId: listing.appId,
    country: listing.country,
    fetchedAt: '2026-01-01T00:00:00Z',
    listing,
    signals: {},
    report: {} as ListingSnapshot['report'],
    rubricVersion: 'test-v1',
    promptHash: 'abc123',
    modelId: 'gemini',
    candidateResult,
  };
}

// ── Stub path: honest "popularity unavailable" ────────────────────────────────

describe('stub ASA client — honest unavailable (not fabricated zero)', () => {
  it('popularityAvailable is false under the stub', async () => {
    const listing = makeListing();
    const result = await generateCandidates(listing, new StubAsaClient());
    expect(result.popularityAvailable).toBe(false);
  });

  it('all candidate volumeLabels = "popularity unavailable"', async () => {
    const listing = makeListing({
      description: 'Control your electric vehicle from your phone.',
    });
    const result = await generateCandidates(listing, new StubAsaClient());
    for (const c of result.candidates) {
      expect(c.volumeLabel).toBe('popularity unavailable');
      expect(c.volumeAvailable).toBe(false);
      expect(c.popularity).toBeUndefined();
    }
  });

  it('all gap row volumeLabels = "popularity unavailable"', async () => {
    const listing = makeListing({
      competitors: [
        {
          appId: '2',
          name: 'Tesla',
          developer: 'Tesla',
          primaryGenre: 'Utilities',
          averageRating: 4.2,
          ratingCount: 500,
          formattedPrice: 'Free',
          screenshotCount: 5,
          hasPreviewVideo: false,
        },
      ],
    });
    const result = await generateCandidates(listing, new StubAsaClient());
    for (const g of result.gap) {
      expect(g.volumeLabel).toBe('popularity unavailable');
    }
  });
});

// ── Candidate deduplication uses the linter's plural rule ────────────────────

describe('candidate dedup — normalizeValueKey (same plural rule as linter)', () => {
  it('deduplicates plural/singular of same root across sources', async () => {
    // "vehicle" in description; "vehicles" in competitor name → collapse to one candidate
    const listing = makeListing({
      description: 'Control your electric vehicle remotely.',
      competitors: [
        {
          appId: '2',
          name: 'Electric Vehicles Control',
          developer: 'EV Corp',
          primaryGenre: 'Utilities',
          averageRating: 4.0,
          ratingCount: 100,
          formattedPrice: 'Free',
          screenshotCount: 3,
          hasPreviewVideo: false,
        },
      ],
    });
    const result = await generateCandidates(listing, new StubAsaClient());
    const vehicleKeys = result.candidates.filter((c) => c.normalizedKey === 'vehicle');
    expect(vehicleKeys.length).toBeLessThanOrEqual(1);
  });

  it('does not produce duplicate candidates for the same normalized key', async () => {
    const listing = makeListing({
      description: 'Monitor charging. Manage charge sessions.',
    });
    const result = await generateCandidates(listing, new StubAsaClient());
    const keys = result.candidates.map((c) => c.normalizedKey);
    const uniqueKeys = new Set(keys);
    expect(keys.length).toBe(uniqueKeys.size);
  });
});

// ── Gap analysis ──────────────────────────────────────────────────────────────

describe('gap analysis — yours_only / theirs_only / shared', () => {
  const competitor = {
    appId: '2',
    name: 'Tesla Model',
    developer: 'Tesla',
    primaryGenre: 'Utilities',
    averageRating: 4.0,
    ratingCount: 200,
    formattedPrice: 'Free',
    screenshotCount: 5,
    hasPreviewVideo: false,
  };

  it('classifies a title term absent from competitor names as yours_only', async () => {
    const listing = makeListing({
      name: 'Rivian',
      competitors: [competitor],
    });
    const result = await generateCandidates(listing, new StubAsaClient());
    const rivian = result.gap.find((g) => g.normalizedKey === 'rivian');
    expect(rivian?.gapCategory).toBe('yours_only');
  });

  it('classifies a competitor name term absent from your title/subtitle as theirs_only', async () => {
    const listing = makeListing({
      name: 'Rivian',
      competitors: [competitor],
    });
    const result = await generateCandidates(listing, new StubAsaClient());
    const tesla = result.gap.find((g) => g.normalizedKey === 'tesla');
    expect(tesla?.gapCategory).toBe('theirs_only');
  });

  it('classifies a term present in both as shared', async () => {
    const listing = makeListing({
      name: 'Rivian Electric',
      subtitle: null,
      competitors: [{ ...competitor, name: 'Electric Vehicle Control' }],
    });
    const result = await generateCandidates(listing, new StubAsaClient());
    const electric = result.gap.find((g) => g.normalizedKey === 'electric');
    expect(electric?.gapCategory).toBe('shared');
  });

  it('labels all gap rows as confidence "inferred"', async () => {
    const listing = makeListing({ competitors: [competitor] });
    const result = await generateCandidates(listing, new StubAsaClient());
    for (const g of result.gap) {
      expect(g.confidence).toBe('inferred');
    }
  });
});

// ── Description candidates ────────────────────────────────────────────────────

describe('description candidates', () => {
  it('does not suggest terms already in title', async () => {
    const listing = makeListing({
      name: 'Rivian',
      description: 'Rivian vehicle control application for charging management.',
    });
    const result = await generateCandidates(listing, new StubAsaClient());
    const rivianCand = result.candidates.find(
      (c) => c.normalizedKey === 'rivian' && c.source === 'description',
    );
    expect(rivianCand).toBeUndefined();
  });

  it('does not suggest wasted words', async () => {
    const listing = makeListing({
      description: 'The best free app for vehicle management.',
    });
    const result = await generateCandidates(listing, new StubAsaClient());
    const wastedKeys = new Set(['best', 'free', 'app', 'the']);
    const wastedCandidates = result.candidates.filter((c) => wastedKeys.has(c.normalizedKey));
    expect(wastedCandidates).toHaveLength(0);
  });

  it('suggests meaningful description terms as source=description candidates', async () => {
    const listing = makeListing({
      description: 'Monitor charging and control your vehicle remotely.',
    });
    const result = await generateCandidates(listing, new StubAsaClient());
    const sources = result.candidates.map((c) => c.source);
    expect(sources).toContain('description');
  });
});

// ── Determinism ────────────────────────────────────────────────────────────────

describe('determinism', () => {
  it('produces identical results on repeated calls', async () => {
    const listing = makeListing({
      description: 'Electric vehicle control for charging and monitoring.',
      competitors: [
        {
          appId: '2',
          name: 'Tesla',
          developer: 'Tesla',
          primaryGenre: 'Utilities',
          averageRating: 4.0,
          ratingCount: 100,
          formattedPrice: 'Free',
          screenshotCount: 5,
          hasPreviewVideo: false,
        },
      ],
    });
    const r1 = await generateCandidates(listing, new StubAsaClient());
    const r2 = await generateCandidates(listing, new StubAsaClient());
    expect(r1).toEqual(r2);
  });
});

// ── formatCandidatesForPrompt ─────────────────────────────────────────────────

describe('formatCandidatesForPrompt', () => {
  it('notes that popularity data is unavailable under the stub', async () => {
    const listing = makeListing({
      description: 'Control your electric vehicle.',
    });
    const result = await generateCandidates(listing, new StubAsaClient());
    const text = formatCandidatesForPrompt(result);
    expect(text).toContain('unavailable');
    expect(text).toContain('inferred');
  });

  it('lists theirs_only gap terms when competitors are present', async () => {
    const listing = makeListing({
      competitors: [
        {
          appId: '2',
          name: 'Tesla Model',
          developer: 'Tesla',
          primaryGenre: 'Utilities',
          averageRating: 4.0,
          ratingCount: 100,
          formattedPrice: 'Free',
          screenshotCount: 5,
          hasPreviewVideo: false,
        },
      ],
    });
    const result = await generateCandidates(listing, new StubAsaClient());
    const text = formatCandidatesForPrompt(result);
    // "tesla" or "model" should appear in the gap section
    expect(text.toLowerCase()).toMatch(/tesla|model/);
  });
});

// ── selectCandidateResult — reuse gate ────────────────────────────────────────

describe('selectCandidateResult', () => {
  it('returns null when there is no prior snapshot', () => {
    const listing = makeListing();
    expect(selectCandidateResult(listing, null)).toBeNull();
  });

  it('returns null when candidateResult is absent from the snapshot', () => {
    const listing = makeListing();
    const snap = makeSnapshot(listing, undefined);
    expect(selectCandidateResult(listing, snap)).toBeNull();
  });

  it('returns null when candidateResult in snapshot is invalid (schema drift)', () => {
    const listing = makeListing();
    const snap = makeSnapshot(listing, { not: 'a valid candidate result' });
    expect(selectCandidateResult(listing, snap)).toBeNull();
  });

  it('returns the stored result when listing text and competitors are unchanged', () => {
    const listing = makeListing({ description: 'Control your electric vehicle.' });
    const snap = makeSnapshot(listing, STUB_CANDIDATE_RESULT);
    const result = selectCandidateResult(listing, snap);
    expect(result).not.toBeNull();
    expect(result?.popularityAvailable).toBe(false);
    expect(result?.candidates).toHaveLength(1);
  });

  it('returns null when the listing name changes', () => {
    const listing = makeListing({ name: 'Rivian' });
    const snap = makeSnapshot(listing, STUB_CANDIDATE_RESULT);
    const changed = makeListing({ name: 'Rivian EV' });
    expect(selectCandidateResult(changed, snap)).toBeNull();
  });

  it('returns null when the description changes', () => {
    const listing = makeListing({ description: 'Control your electric vehicle.' });
    const snap = makeSnapshot(listing, STUB_CANDIDATE_RESULT);
    const changed = makeListing({ description: 'Monitor your EV remotely.' });
    expect(selectCandidateResult(changed, snap)).toBeNull();
  });

  it('returns null when the competitor set changes', () => {
    const listing = makeListing({ competitors: [] });
    const snap = makeSnapshot(listing, STUB_CANDIDATE_RESULT);
    const changed = makeListing({
      competitors: [{
        appId: '2', name: 'Tesla', developer: 'Tesla', primaryGenre: 'Utilities',
        averageRating: 4.0, ratingCount: 100, formattedPrice: 'Free',
        screenshotCount: 5, hasPreviewVideo: false,
      }],
    });
    expect(selectCandidateResult(changed, snap)).toBeNull();
  });

  it('treats competitor order as irrelevant (sorted comparison)', () => {
    const comp1 = { appId: '2', name: 'Tesla', developer: 'Tesla', primaryGenre: 'Utilities', averageRating: 4.0, ratingCount: 100, formattedPrice: 'Free', screenshotCount: 5, hasPreviewVideo: false };
    const comp2 = { appId: '3', name: 'Polestar', developer: 'Polestar', primaryGenre: 'Utilities', averageRating: 4.1, ratingCount: 200, formattedPrice: 'Free', screenshotCount: 6, hasPreviewVideo: false };
    const listing = makeListing({ competitors: [comp1, comp2] });
    const snap = makeSnapshot(listing, STUB_CANDIDATE_RESULT);
    // Reversed order — should still reuse
    const reversed = makeListing({ competitors: [comp2, comp1] });
    expect(selectCandidateResult(reversed, snap)).not.toBeNull();
  });
});

// ── suppressCompetitorGapTerms — C-FU2 divergence-aware filter ────────────────

const MIXED_CANDIDATE_RESULT: CandidateResult = {
  candidates: [{ term: 'charging', normalizedKey: 'charging', source: 'description', volumeLabel: 'popularity unavailable', volumeAvailable: false }],
  gap: [
    { term: 'rivian', normalizedKey: 'rivian', gapCategory: 'yours_only', confidence: 'inferred', volumeLabel: 'popularity unavailable', volumeAvailable: false },
    { term: 'expedia', normalizedKey: 'expedia', gapCategory: 'theirs_only', confidence: 'inferred', volumeLabel: 'popularity unavailable', volumeAvailable: false },
    { term: 'hotels', normalizedKey: 'hotel', gapCategory: 'theirs_only', confidence: 'inferred', volumeLabel: 'popularity unavailable', volumeAvailable: false },
    { term: 'travel', normalizedKey: 'travel', gapCategory: 'shared', confidence: 'inferred', volumeLabel: 'popularity unavailable', volumeAvailable: false },
  ],
  popularityAvailable: false,
};

describe('suppressCompetitorGapTerms', () => {
  it('removes theirs_only rows, keeps yours_only and shared', () => {
    const result = suppressCompetitorGapTerms(MIXED_CANDIDATE_RESULT);
    const categories = result.gap.map((g) => g.gapCategory);
    expect(categories).not.toContain('theirs_only');
    expect(categories).toContain('yours_only');
    expect(categories).toContain('shared');
  });

  it('does not mutate the original result', () => {
    const original = { ...MIXED_CANDIDATE_RESULT, gap: [...MIXED_CANDIDATE_RESULT.gap] };
    suppressCompetitorGapTerms(MIXED_CANDIDATE_RESULT);
    expect(MIXED_CANDIDATE_RESULT.gap).toHaveLength(original.gap.length);
  });

  it('keeps description candidates untouched', () => {
    const result = suppressCompetitorGapTerms(MIXED_CANDIDATE_RESULT);
    expect(result.candidates).toEqual(MIXED_CANDIDATE_RESULT.candidates);
  });

  it('is a no-op when there are no theirs_only rows', () => {
    const noCompetitors: CandidateResult = { ...MIXED_CANDIDATE_RESULT, gap: [] };
    const result = suppressCompetitorGapTerms(noCompetitors);
    expect(result.gap).toHaveLength(0);
    expect(result.candidates).toEqual(noCompetitors.candidates);
  });
});

// ── D3: competitorTokens reads competitor description ─────────────────────────

describe('D3 — competitorTokens includes tokens from competitor description', () => {
  it('extracts tokens from competitor description, not just name', async () => {
    const listing = makeListing({
      name: 'Rivian',
      competitors: [
        {
          appId: '2',
          name: 'ChargePoint',
          developer: 'ChargePoint Inc',
          primaryGenre: 'Utilities',
          averageRating: 4.0,
          ratingCount: 100,
          formattedPrice: 'Free',
          screenshotCount: 3,
          hasPreviewVideo: false,
          description: 'Find charging stations and manage your sessions remotely.',
        },
      ],
    });
    const result = await generateCandidates(listing, new StubAsaClient());

    // 'station' (from description 'stations') and 'session' should be extracted
    // as competitor-sourced tokens since they don't appear in the app title
    const competitorCandidates = result.candidates.filter((c) => c.source === 'competitor');
    const keys = competitorCandidates.map((c) => c.normalizedKey);
    // At minimum 'station' or 'session' from the competitor description should surface
    const hasDescriptionTokens = keys.some((k) => ['station', 'session', 'charging', 'manag', 'remot'].includes(k));
    expect(hasDescriptionTokens).toBe(true);
  });

  it('competitor description tokens appear as theirs_only gap rows when absent from title', async () => {
    const listing = makeListing({
      name: 'Rivian',
      subtitle: null,
      competitors: [
        {
          appId: '2',
          name: 'ChargePoint',
          developer: 'ChargePoint Inc',
          primaryGenre: 'Utilities',
          averageRating: 4.0,
          ratingCount: 100,
          formattedPrice: 'Free',
          screenshotCount: 3,
          hasPreviewVideo: false,
          description: 'Navigate charging infrastructure worldwide.',
        },
      ],
    });
    const result = await generateCandidates(listing, new StubAsaClient());

    // 'navigate' or 'infrastructure' from competitor description should be theirs_only
    const theirsOnly = result.gap.filter((g) => g.gapCategory === 'theirs_only');
    const keys = theirsOnly.map((g) => g.normalizedKey);
    // At least one description-derived token should appear in theirs_only
    const hasDescGapToken = keys.some((k) => ['navig', 'infrastructur', 'worldwide'].includes(k));
    expect(hasDescGapToken).toBe(true);
  });

  it('competitor without description works exactly as before (backward compat)', async () => {
    const listing = makeListing({
      name: 'Rivian',
      competitors: [
        {
          appId: '2',
          name: 'Tesla',
          developer: 'Tesla',
          primaryGenre: 'Utilities',
          averageRating: 4.0,
          ratingCount: 100,
          formattedPrice: 'Free',
          screenshotCount: 5,
          hasPreviewVideo: false,
          // no description field
        },
      ],
    });
    const result = await generateCandidates(listing, new StubAsaClient());
    const tesla = result.gap.find((g) => g.normalizedKey === 'tesla');
    expect(tesla?.gapCategory).toBe('theirs_only');
    // Should not throw, should return valid result
    expect(result.candidates).toBeDefined();
    expect(result.gap).toBeDefined();
  });
});
