import { describe, it, expect } from 'vitest';
import { generateCandidates, formatCandidatesForPrompt } from './candidates';
import { StubAsaClient } from './asa-client';
import { runLinter } from './linter';
import type { AppListing } from '../domain/listing';

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
    provenance: { itunes: true, crawler: false, reviews: false, competitors: false },
    ...overrides,
  };
}

function makeLinter(title: string, subtitle: string | null = null) {
  return runLinter({ title, subtitle, keywordField: null });
}

// ── Stub path: honest "popularity unavailable" ────────────────────────────────

describe('stub ASA client — honest unavailable (not fabricated zero)', () => {
  it('popularityAvailable is false under the stub', async () => {
    const listing = makeListing();
    const result = await generateCandidates(listing, makeLinter('Rivian'), new StubAsaClient());
    expect(result.popularityAvailable).toBe(false);
  });

  it('all candidate volumeLabels = "popularity unavailable"', async () => {
    const listing = makeListing({
      description: 'Control your electric vehicle from your phone.',
    });
    const result = await generateCandidates(listing, makeLinter('Rivian'), new StubAsaClient());
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
    const result = await generateCandidates(listing, makeLinter('Rivian'), new StubAsaClient());
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
    const result = await generateCandidates(listing, makeLinter('Rivian'), new StubAsaClient());
    const vehicleKeys = result.candidates.filter((c) => c.normalizedKey === 'vehicle');
    expect(vehicleKeys.length).toBeLessThanOrEqual(1);
  });

  it('does not produce duplicate candidates for the same normalized key', async () => {
    const listing = makeListing({
      description: 'Monitor charging. Manage charge sessions.',
    });
    const result = await generateCandidates(listing, makeLinter('Rivian'), new StubAsaClient());
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
    const result = await generateCandidates(listing, makeLinter('Rivian'), new StubAsaClient());
    const rivian = result.gap.find((g) => g.normalizedKey === 'rivian');
    expect(rivian?.gapCategory).toBe('yours_only');
  });

  it('classifies a competitor name term absent from your title/subtitle as theirs_only', async () => {
    const listing = makeListing({
      name: 'Rivian',
      competitors: [competitor],
    });
    const result = await generateCandidates(listing, makeLinter('Rivian'), new StubAsaClient());
    const tesla = result.gap.find((g) => g.normalizedKey === 'tesla');
    expect(tesla?.gapCategory).toBe('theirs_only');
  });

  it('classifies a term present in both as shared', async () => {
    const listing = makeListing({
      name: 'Rivian Electric',
      subtitle: null,
      competitors: [{ ...competitor, name: 'Electric Vehicle Control' }],
    });
    const result = await generateCandidates(listing, makeLinter('Rivian Electric'), new StubAsaClient());
    const electric = result.gap.find((g) => g.normalizedKey === 'electric');
    expect(electric?.gapCategory).toBe('shared');
  });

  it('labels all gap rows as confidence "inferred"', async () => {
    const listing = makeListing({ competitors: [competitor] });
    const result = await generateCandidates(listing, makeLinter('Rivian'), new StubAsaClient());
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
    const result = await generateCandidates(listing, makeLinter('Rivian'), new StubAsaClient());
    const rivianCand = result.candidates.find(
      (c) => c.normalizedKey === 'rivian' && c.source === 'description',
    );
    expect(rivianCand).toBeUndefined();
  });

  it('does not suggest wasted words', async () => {
    const listing = makeListing({
      description: 'The best free app for vehicle management.',
    });
    const result = await generateCandidates(listing, makeLinter('Rivian'), new StubAsaClient());
    const wastedKeys = new Set(['best', 'free', 'app', 'the']);
    const wastedCandidates = result.candidates.filter((c) => wastedKeys.has(c.normalizedKey));
    expect(wastedCandidates).toHaveLength(0);
  });

  it('suggests meaningful description terms as source=description candidates', async () => {
    const listing = makeListing({
      description: 'Monitor charging and control your vehicle remotely.',
    });
    const result = await generateCandidates(listing, makeLinter('Rivian'), new StubAsaClient());
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
    const linter = makeLinter('Rivian');
    const r1 = await generateCandidates(listing, linter, new StubAsaClient());
    const r2 = await generateCandidates(listing, linter, new StubAsaClient());
    expect(r1).toEqual(r2);
  });
});

// ── formatCandidatesForPrompt ─────────────────────────────────────────────────

describe('formatCandidatesForPrompt', () => {
  it('notes that popularity data is unavailable under the stub', async () => {
    const listing = makeListing({
      description: 'Control your electric vehicle.',
    });
    const result = await generateCandidates(listing, makeLinter('Rivian'), new StubAsaClient());
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
    const result = await generateCandidates(listing, makeLinter('Rivian'), new StubAsaClient());
    const text = formatCandidatesForPrompt(result);
    // "tesla" or "model" should appear in the gap section
    expect(text.toLowerCase()).toMatch(/tesla|model/);
  });
});
