import { describe, it, expect } from 'vitest';
import type { AppListing } from '../domain/listing';
import type { ListingSignals } from './signals';
import { DIMENSION_IDS } from '../domain/audit';
import {
  deriveConfidence,
  codeScore,
  coarseOrdinalScore,
  dimensionInputHash,
  allDimensionHashes,
  visionUsable,
} from './dimension-scorer';
import type { VisionResult } from '../vision/types';
import { runLinter } from '../keywords/linter';

// ── VisionResult builders ────────────────────────────────────────────────────

function makeVisionResult(critiques: VisionResult['screenshotSetVerdict']['critiques']): VisionResult {
  return {
    screenshotSetVerdict: {
      critiques,
      competitorComparison: { value: '', confidence: 'observed' },
      coarseScore: 5,
      confidence: 'observed',
      modelId: 'gemini-2.5-flash',
    },
    iconVerdict: null,
  };
}

const REAL_CRITIQUE: VisionResult['screenshotSetVerdict']['critiques'][number] = {
  url: 'https://example.com/ss1.png',
  slot: 1,
  valuePropClarity: { value: 'Clear', confidence: 'observed' },
  readability: { value: 'Good', confidence: 'observed' },
  cohesion: { value: 'Strong', confidence: 'observed' },
};

// ── Minimal listing builder ──────────────────────────────────────────────────

function makeListing(overrides: Partial<AppListing> = {}): AppListing {
  return {
    appId: '1',
    country: 'us',
    url: 'https://apps.apple.com/us/app/id1',
    name: 'Test App',
    developer: 'Test Dev',
    bundleId: null,
    sellerUrl: null,
    iconUrl: 'https://example.com/icon.png',
    primaryGenre: 'Productivity',
    genres: ['Productivity'],
    price: 0,
    formattedPrice: 'Free',
    subtitle: null,
    promotionalText: null,
    description: 'A great app.',
    releaseNotes: 'Bug fixes.',
    version: '1.0.0',
    screenshotUrls: [],
    ipadScreenshotUrls: [],
    hasPreviewVideo: false,
    crawledScreenshotCount: 0,
    averageRating: 4.5,
    ratingCount: 1000,
    currentVersionRating: 4.2,
    currentVersionRatingCount: 50,
    contentRating: '4+',
    releaseDate: '2020-01-01T00:00:00Z',
    currentVersionReleaseDate: '2024-01-01T00:00:00Z',
    reviews: [],
    competitors: [],
    provenance: { itunes: true, crawler: false, reviews: false, competitors: false, observedFromCache: false },
    ...overrides,
  };
}

// ── Minimal signals builder ──────────────────────────────────────────────────

function makeSignals(overrides: Partial<ListingSignals> = {}): ListingSignals {
  return {
    title: {
      value: 'Test App',
      length: 8,
      limit: 30,
      utilizationPct: 27,
      overLimit: false,
    },
    subtitle: {
      observable: false,
      value: null,
      length: 0,
      limit: 30,
      utilizationPct: 0,
      wordsSharedWithTitle: [],
    },
    keywordField: { observable: false, note: 'not public' },
    description: {
      charCount: 12,
      lineCount: 1,
      aboveFold: 'A great app.',
    },
    screenshots: {
      iphoneCount: 0,
      ipadCount: 0,
      slotsUsedOf10: 0,
    },
    previewVideo: {
      observable: false,
      present: false,
    },
    ratings: {
      allTimeAverage: 4.5,
      allTimeCount: 1000,
      currentVersionAverage: 4.2,
      currentVersionCount: 50,
      reviewSampleSize: 0,
      reviewSampleAverage: null,
      negativeReviewShare: null,
    },
    icon: { present: true },
    conversion: {
      promotionalTextObservable: false,
      hasPromotionalText: false,
      hasReleaseNotes: true,
      releaseNotesLength: 10,
      daysSinceLastUpdate: 180,
    },
    competitive: { competitorCount: 0 },
    keywordLinter: runLinter({ title: 'Test App', subtitle: null, keywordField: null }),
    ...overrides,
  };
}

// ── deriveConfidence ─────────────────────────────────────────────────────────

describe('deriveConfidence — subtitle', () => {
  it('returns "unavailable" when subtitle is not observable', () => {
    const signals = makeSignals({ subtitle: { observable: false, value: null, length: 0, limit: 30, utilizationPct: 0, wordsSharedWithTitle: [] } });
    expect(deriveConfidence('subtitle', signals)).toBe('unavailable');
  });

  it('returns "observed" when subtitle is observable', () => {
    const signals = makeSignals({ subtitle: { observable: true, value: 'Sub', length: 3, limit: 30, utilizationPct: 10, wordsSharedWithTitle: [] } });
    expect(deriveConfidence('subtitle', signals)).toBe('observed');
  });
});

describe('deriveConfidence — previewVideo', () => {
  it('returns "unavailable" when previewVideo is not observable', () => {
    const signals = makeSignals({ previewVideo: { observable: false, present: false } });
    expect(deriveConfidence('previewVideo', signals)).toBe('unavailable');
  });

  it('returns "inferred" when observable (existence seen; quality needs vision/P2)', () => {
    const signals = makeSignals({ previewVideo: { observable: true, present: true } });
    expect(deriveConfidence('previewVideo', signals)).toBe('inferred');
  });
});

describe('deriveConfidence — keywordField', () => {
  it('always returns "inferred" (iOS keyword field is never public)', () => {
    const signals = makeSignals();
    expect(deriveConfidence('keywordField', signals)).toBe('inferred');
  });
});

describe('deriveConfidence — title', () => {
  it('returns "observed"', () => {
    expect(deriveConfidence('title', makeSignals())).toBe('observed');
  });
});

describe('deriveConfidence — conversion', () => {
  it('returns "inferred" when promotionalText is not observable', () => {
    const signals = makeSignals({
      conversion: {
        promotionalTextObservable: false,
        hasPromotionalText: false,
        hasReleaseNotes: true,
        releaseNotesLength: 10,
        daysSinceLastUpdate: 180,
      },
    });
    expect(deriveConfidence('conversion', signals)).toBe('inferred');
  });

  it('returns "observed" when promotionalText is observable', () => {
    const signals = makeSignals({
      conversion: {
        promotionalTextObservable: true,
        hasPromotionalText: false,
        hasReleaseNotes: true,
        releaseNotesLength: 10,
        daysSinceLastUpdate: 180,
      },
    });
    expect(deriveConfidence('conversion', signals)).toBe('observed');
  });
});

describe('deriveConfidence — screenshots', () => {
  it('returns "inferred" when no vision result', () => {
    expect(deriveConfidence('screenshots', makeSignals())).toBe('inferred');
  });

  it('returns "observed" when vision produced real critiques', () => {
    const v = makeVisionResult([REAL_CRITIQUE]);
    expect(deriveConfidence('screenshots', makeSignals(), v)).toBe('observed');
  });

  it('returns "inferred" when vision result has empty critiques (parse failure)', () => {
    const v = makeVisionResult([]);
    expect(deriveConfidence('screenshots', makeSignals(), v)).toBe('inferred');
  });
});

describe('deriveConfidence — remaining observed dimensions', () => {
  it('description → "observed"', () => {
    expect(deriveConfidence('description', makeSignals())).toBe('observed');
  });
  it('ratings → "observed" (average is genuinely observed; themes/responses → P4)', () => {
    expect(deriveConfidence('ratings', makeSignals())).toBe('observed');
  });
  it('icon → "observed"', () => {
    expect(deriveConfidence('icon', makeSignals())).toBe('observed');
  });
  it('competitive → "observed"', () => {
    expect(deriveConfidence('competitive', makeSignals())).toBe('observed');
  });
});

// ── codeScore ────────────────────────────────────────────────────────────────

describe('codeScore — previewVideo', () => {
  it('returns null when not observable (crawler absent)', () => {
    const signals = makeSignals({ previewVideo: { observable: false, present: false } });
    expect(codeScore('previewVideo', signals)).toBeNull();
  });

  it('returns 8 when observable and present', () => {
    const signals = makeSignals({ previewVideo: { observable: true, present: true } });
    expect(codeScore('previewVideo', signals)).toBe(8);
  });

  it('returns 0 when observable but absent', () => {
    const signals = makeSignals({ previewVideo: { observable: true, present: false } });
    expect(codeScore('previewVideo', signals)).toBe(0);
  });
});

describe('codeScore — screenshots', () => {
  it('returns slotsUsedOf10 = 6 when no vision result', () => {
    const signals = makeSignals({ screenshots: { iphoneCount: 6, ipadCount: 0, slotsUsedOf10: 6 } });
    expect(codeScore('screenshots', signals)).toBe(6);
  });

  it('returns slotsUsedOf10 = 10 when no vision result', () => {
    const signals = makeSignals({ screenshots: { iphoneCount: 10, ipadCount: 4, slotsUsedOf10: 10 } });
    expect(codeScore('screenshots', signals)).toBe(10);
  });

  it('returns vision coarseScore when critiques are present', () => {
    const signals = makeSignals({ screenshots: { iphoneCount: 7, ipadCount: 0, slotsUsedOf10: 7 } });
    const v = makeVisionResult([REAL_CRITIQUE]);
    v.screenshotSetVerdict.coarseScore = 5;
    expect(codeScore('screenshots', signals, v)).toBe(5);
  });

  it('falls back to slotsUsedOf10 when vision critiques are empty (parse failure)', () => {
    const signals = makeSignals({ screenshots: { iphoneCount: 7, ipadCount: 0, slotsUsedOf10: 7 } });
    const v = makeVisionResult([]);           // parse failure → empty critiques
    v.screenshotSetVerdict.coarseScore = 5;   // fabricated default that must NOT be returned
    expect(codeScore('screenshots', signals, v)).toBe(7);
  });
});

describe('codeScore — ratings (deterministic: average + recent trend)', () => {
  const ratings = (over: Partial<ListingSignals['ratings']>): ListingSignals =>
    makeSignals({
      ratings: {
        allTimeAverage: 4.5,
        allTimeCount: 1000,
        currentVersionAverage: 4.5,
        currentVersionCount: 50,
        reviewSampleSize: 0,
        reviewSampleAverage: null,
        negativeReviewShare: null,
        ...over,
      },
    });

  it('maps the all-time average (0–5★) to 0–10: 4.5★ → 9', () => {
    expect(codeScore('ratings', ratings({ currentVersionAverage: 4.5 }))).toBe(9);
  });

  it('nudges -1 on a declining current-version trend (≥0.3★ below all-time)', () => {
    expect(codeScore('ratings', ratings({ allTimeAverage: 4.5, currentVersionAverage: 4.0 }))).toBe(8);
  });

  it('nudges +1 on an improving current-version trend (≥0.3★ above all-time)', () => {
    expect(codeScore('ratings', ratings({ allTimeAverage: 4.0, currentVersionAverage: 4.5 }))).toBe(9);
  });

  it('no nudge for a trend within ±0.3★', () => {
    expect(codeScore('ratings', ratings({ allTimeAverage: 4.5, currentVersionAverage: 4.3 }))).toBe(9);
  });

  it('returns null when there is no rating data yet (brand-new app)', () => {
    expect(
      codeScore('ratings', ratings({ allTimeAverage: null, currentVersionAverage: null })),
    ).toBeNull();
  });

  it('is deterministic — same input → same score, no model call', () => {
    const s = ratings({});
    expect(codeScore('ratings', s)).toBe(codeScore('ratings', s));
  });
});

describe('codeScore — model-judgment dimensions return null', () => {
  it('title → null', () => {
    expect(codeScore('title', makeSignals())).toBeNull();
  });
  it('description → null', () => {
    expect(codeScore('description', makeSignals())).toBeNull();
  });
  it('keywordField → null', () => {
    expect(codeScore('keywordField', makeSignals())).toBeNull();
  });
  it('icon → null', () => {
    expect(codeScore('icon', makeSignals())).toBeNull();
  });
  it('conversion → null', () => {
    expect(codeScore('conversion', makeSignals())).toBeNull();
  });
  it('competitive → null', () => {
    expect(codeScore('competitive', makeSignals())).toBeNull();
  });
});

// ── coarseOrdinalScore ───────────────────────────────────────────────────────

describe('coarseOrdinalScore — title', () => {
  const title = (utilizationPct: number) =>
    makeSignals({
      title: { value: 'X', length: Math.round(utilizationPct * 0.3), limit: 30, utilizationPct, overLimit: false },
    });

  it('returns 0 for model score 0-1 only (truly terrible title)', () => {
    expect(coarseOrdinalScore('title', 0, title(80))).toBe(0);
    expect(coarseOrdinalScore('title', 1, title(80))).toBe(0);
  });

  it('returns 5 for model score 2-7 — brand-only short names (Rivian, Spotify) land here', () => {
    expect(coarseOrdinalScore('title', 2, title(20))).toBe(5); // brand-only, 20% util
    expect(coarseOrdinalScore('title', 4, title(23))).toBe(5); // Spotify-like (7/30)
    expect(coarseOrdinalScore('title', 7, title(80))).toBe(5);
  });

  it('returns 10 for model score 8-10 (keyword-optimized title)', () => {
    expect(coarseOrdinalScore('title', 8, title(80))).toBe(10);
    expect(coarseOrdinalScore('title', 10, title(80))).toBe(10);
  });
});

describe('coarseOrdinalScore — subtitle', () => {
  const sub = (observable: boolean, utilizationPct: number) =>
    makeSignals({
      subtitle: { observable, value: 'Sub', length: 10, limit: 30, utilizationPct, wordsSharedWithTitle: [] },
    });

  it('returns null when subtitle is not observable (confidence will be unavailable)', () => {
    expect(coarseOrdinalScore('subtitle', 7, sub(false, 33))).toBeNull();
  });

  it('snaps to 5 for model score 3-7 when observable', () => {
    expect(coarseOrdinalScore('subtitle', 6, sub(true, 50))).toBe(5);
  });

  it('snaps to 10 for model score 8+ when observable', () => {
    expect(coarseOrdinalScore('subtitle', 9, sub(true, 50))).toBe(10);
  });

  it('snaps score 0-2 to 0 even when observable and short', () => {
    expect(coarseOrdinalScore('subtitle', 2, sub(true, 10))).toBe(0);
  });
});

describe('coarseOrdinalScore — other dimensions return null', () => {
  it('description → null', () => { expect(coarseOrdinalScore('description', 7, makeSignals())).toBeNull(); });
  it('keywordField → null', () => { expect(coarseOrdinalScore('keywordField', 7, makeSignals())).toBeNull(); });
  it('screenshots → null', () => { expect(coarseOrdinalScore('screenshots', 7, makeSignals())).toBeNull(); });
  it('previewVideo → null', () => { expect(coarseOrdinalScore('previewVideo', 7, makeSignals())).toBeNull(); });
  it('ratings → null', () => { expect(coarseOrdinalScore('ratings', 7, makeSignals())).toBeNull(); });
  it('icon → null', () => { expect(coarseOrdinalScore('icon', 7, makeSignals())).toBeNull(); });
  it('conversion → null', () => { expect(coarseOrdinalScore('conversion', 7, makeSignals())).toBeNull(); });
});

describe('coarseOrdinalScore — competitive snaps to ordinal', () => {
  it('score 2 → 0 (poor)', () => { expect(coarseOrdinalScore('competitive', 2, makeSignals())).toBe(0); });
  it('score 7 → 5 (acceptable)', () => { expect(coarseOrdinalScore('competitive', 7, makeSignals())).toBe(5); });
  it('score 9 → 10 (excellent)', () => { expect(coarseOrdinalScore('competitive', 9, makeSignals())).toBe(10); });
});

// ── visionUsable ─────────────────────────────────────────────────────────────

describe('visionUsable', () => {
  it('returns false when visionResult is undefined', () => {
    expect(visionUsable(undefined)).toBe(false);
  });

  it('returns false when critiques array is empty (parse failure)', () => {
    expect(visionUsable(makeVisionResult([]))).toBe(false);
  });

  it('returns true when critiques are present', () => {
    expect(visionUsable(makeVisionResult([REAL_CRITIQUE]))).toBe(true);
  });
});

// ── dimensionInputHash ────────────────────────────────────────────────────────

describe('dimensionInputHash — stability', () => {
  it('returns the same hash for the same inputs (title)', () => {
    const listing = makeListing({ name: 'My App' });
    const signals = makeSignals();
    const h1 = dimensionInputHash('title', listing, signals);
    const h2 = dimensionInputHash('title', listing, signals);
    expect(h1).toBe(h2);
  });

  it('changes when title name changes', () => {
    const listing1 = makeListing({ name: 'My App' });
    const listing2 = makeListing({ name: 'My App v2' });
    const signals = makeSignals();
    expect(dimensionInputHash('title', listing1, signals)).not.toBe(
      dimensionInputHash('title', listing2, signals),
    );
  });

  it('title hash change does not affect subtitle hash', () => {
    const listing1 = makeListing({ name: 'My App', subtitle: 'Sub' });
    const listing2 = makeListing({ name: 'My App v2', subtitle: 'Sub' });
    const signals = makeSignals();
    expect(dimensionInputHash('subtitle', listing1, signals)).toBe(
      dimensionInputHash('subtitle', listing2, signals),
    );
  });

  it('returns a 16-character hex string', () => {
    const hash = dimensionInputHash('title', makeListing(), makeSignals());
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ── allDimensionHashes ────────────────────────────────────────────────────────

describe('allDimensionHashes', () => {
  it('returns a record with all 10 DimensionId keys', () => {
    const hashes = allDimensionHashes(makeListing(), makeSignals());
    expect(Object.keys(hashes).sort()).toEqual([...DIMENSION_IDS].sort());
  });

  it('all values are 16-char hex strings', () => {
    const hashes = allDimensionHashes(makeListing(), makeSignals());
    for (const [, hash] of Object.entries(hashes)) {
      expect(hash).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('is deterministic — same result on second call', () => {
    const listing = makeListing();
    const signals = makeSignals();
    const h1 = allDimensionHashes(listing, signals);
    const h2 = allDimensionHashes(listing, signals);
    expect(h1).toEqual(h2);
  });
});
