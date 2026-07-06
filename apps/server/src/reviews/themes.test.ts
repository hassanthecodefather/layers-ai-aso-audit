/**
 * §F P4 Acceptance Tests: Theme Analysis (Task D2)
 *
 * Tests cover:
 * 1. Per-version delta — null when < 2 versions have ≥5 reviews
 * 2. Per-version delta — computed when ≥2 versions qualify (rivian fixture)
 * 3. Empty reviews → empty result
 * 4. LLM validation failure → graceful empty result
 * 5. Distinct themes produce distinct value_keys
 * 6. fix_complaint_theme / respond_to_reviews are no longer single-instance
 * 7. 'other' bucket → isUnresolved: true
 * 8. Named bucket → isUnresolved: false
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Review } from '../domain/listing';
import { AppListingSchema } from '../domain/listing';
import type { LlmProvider } from '../llm/provider';
import type { ListingSnapshot } from '../domain/snapshot';
import { analyzeThemes, selectThemeResult } from './themes';
import { valueKeyFor } from '../memory/dedup';
import { SINGLE_INSTANCE_INTENTS } from '../domain/recommendation';

const DIR = dirname(fileURLToPath(import.meta.url));
const rivianSample: Review[] = JSON.parse(
  readFileSync(join(DIR, '__fixtures__/rivian.reviews.sample1.json'), 'utf8'),
) as Review[];

// ── Stub helpers ─────────────────────────────────────────────────────────────

/** Stub LlmProvider — model() is never called in tests (we use _generateOverride) */
const stubLlm: LlmProvider = {
  id: 'stub',
  modelId: 'stub-model',
  endpoint: 'http://stub',
  model: () => { throw new Error('model() should not be called in tests'); },
  reachable: async () => true,
  verifyModel: async () => ({ ok: true, detail: 'stub' }),
};

/** Build a stub generator that returns JSON as the model response. */
function makeStubGenerator(response: object): (prompt: string) => Promise<string> {
  return async (_prompt: string) => JSON.stringify(response);
}

/** Build a stub generator that returns an invalid/non-JSON string. */
function makeInvalidGenerator(response: string): (prompt: string) => Promise<string> {
  return async (_prompt: string) => response;
}

// ── Review fixtures ───────────────────────────────────────────────────────────

function makeReview(overrides: Partial<Review> & { appVersion?: string | null }): Review {
  return {
    author: 'Test User',
    rating: 3,
    title: 'Test',
    body: 'Test body',
    updated: null,
    id: undefined,
    appVersion: overrides.appVersion,
    ...overrides,
  };
}

/** Generate N reviews all for the same version */
function reviewsForVersion(version: string, count: number, rating = 3): Review[] {
  return Array.from({ length: count }, (_, i) =>
    makeReview({ id: `rev-${version}-${i}`, appVersion: version, rating }),
  );
}

// ── Test 1: Per-version delta — null when < 2 versions have ≥5 reviews ───────

describe('analyzeThemes — version delta null when < 2 versions qualify', () => {
  it('returns versionDelta === null when only one version has ≥2 reviews', async () => {
    // One version with 3 reviews, another with only 1 (below minimum of 2)
    const reviews: Review[] = [
      ...reviewsForVersion('3.13.0', 3, 4),
      ...reviewsForVersion('3.12.1', 1, 2),
    ];

    const result = await analyzeThemes(
      reviews,
      stubLlm,
      makeStubGenerator({ themes: [], featureRequests: [] }),
    );

    expect(result.versionDelta).toBeNull();
  });

  it('returns versionDelta === null when no reviews have a version', async () => {
    const reviews: Review[] = Array.from({ length: 10 }, (_, i) =>
      makeReview({ id: `r${i}`, appVersion: null }),
    );

    const result = await analyzeThemes(
      reviews,
      stubLlm,
      makeStubGenerator({ themes: [], featureRequests: [] }),
    );

    expect(result.versionDelta).toBeNull();
  });
});

// ── Test 2: Per-version delta — computed when ≥2 versions qualify ─────────────

describe('analyzeThemes — version delta computed from rivian fixture', () => {
  it('returns non-null versionDelta with olderVersion, newerVersion, and delta', async () => {
    // The rivian fixture has reviews across 8 distinct versions, several with ≥5 reviews
    const reviews = rivianSample as Review[];

    const result = await analyzeThemes(
      reviews,
      stubLlm,
      makeStubGenerator({ themes: [], featureRequests: [] }),
    );

    expect(result.versionDelta).not.toBeNull();
    expect(result.versionDelta!.olderVersion).toBeTruthy();
    expect(result.versionDelta!.newerVersion).toBeTruthy();
    expect(typeof result.versionDelta!.delta).toBe('number');
    // newerVersion should be lexicographically greater than olderVersion
    expect(
      result.versionDelta!.newerVersion.localeCompare(result.versionDelta!.olderVersion),
    ).toBeGreaterThan(0);
  });

  it('versionDelta has valid avg ratings between 1 and 5', async () => {
    const reviews = rivianSample as Review[];

    const result = await analyzeThemes(
      reviews,
      stubLlm,
      makeStubGenerator({ themes: [], featureRequests: [] }),
    );

    expect(result.versionDelta).not.toBeNull();
    expect(result.versionDelta!.olderAvgRating).toBeGreaterThanOrEqual(1);
    expect(result.versionDelta!.olderAvgRating).toBeLessThanOrEqual(5);
    expect(result.versionDelta!.newerAvgRating).toBeGreaterThanOrEqual(1);
    expect(result.versionDelta!.newerAvgRating).toBeLessThanOrEqual(5);
  });
});

// ── Test 3: Empty reviews → empty result ─────────────────────────────────────

describe('analyzeThemes — empty reviews returns empty result', () => {
  it('returns the canonical empty result when reviews array is empty', async () => {
    const result = await analyzeThemes([], stubLlm);

    expect(result).toEqual({
      themes: [],
      versionDelta: null,
      featureRequests: [],
      sampleSize: 0,
      taxonomyVersion: 'theme-taxonomy@1',
    });
  });
});

// ── Test 4: LLM validation failure → graceful empty result ───────────────────

describe('analyzeThemes — graceful degradation on LLM failure', () => {
  it('returns empty themes when LLM returns invalid JSON', async () => {
    const reviews: Review[] = reviewsForVersion('3.13.0', 3);

    const result = await analyzeThemes(
      reviews,
      stubLlm,
      makeInvalidGenerator('not json at all'),
    );

    expect(result.themes).toEqual([]);
    expect(result.taxonomyVersion).toBe('theme-taxonomy@1');
  });

  it('returns empty themes when LLM returns wrong schema shape', async () => {
    const reviews: Review[] = reviewsForVersion('3.13.0', 3);

    const result = await analyzeThemes(
      reviews,
      stubLlm,
      makeStubGenerator({ wrong: 'shape', nothemes: true }),
    );

    expect(result.themes).toEqual([]);
  });

  it('returns empty themes when generator throws', async () => {
    const reviews: Review[] = reviewsForVersion('3.13.0', 3);

    const throwingGenerator = async (_prompt: string): Promise<string> => {
      throw new Error('LLM unavailable');
    };

    const result = await analyzeThemes(reviews, stubLlm, throwingGenerator);

    expect(result.themes).toEqual([]);
  });
});

// ── Test 5: Distinct themes produce distinct value_keys (§F P4) ──────────────

describe('valueKeyFor — distinct theme buckets produce distinct value_keys', () => {
  it('crash_stability and login_auth produce different value_keys', () => {
    const crash = valueKeyFor('fix_complaint_theme', {
      kind: 'theme',
      bucket: 'crash_stability',
      text: 'App crashes frequently',
    });
    const login = valueKeyFor('fix_complaint_theme', {
      kind: 'theme',
      bucket: 'login_auth',
      text: 'Cannot log in',
    });

    expect(crash).toBe('crash_stability');
    expect(login).toBe('login_auth');
    expect(crash).not.toBe(login);
  });

  it('distinct review IDs produce distinct value_keys', () => {
    const r1 = valueKeyFor('respond_to_reviews', {
      kind: 'reviewId',
      value: '14209690246',
    });
    const r2 = valueKeyFor('respond_to_reviews', {
      kind: 'reviewId',
      value: '14199210988',
    });

    expect(r1).not.toBe(r2);
  });

  it('theme bucket value_key is the bucket string verbatim (no normalization)', () => {
    const key = valueKeyFor('fix_complaint_theme', {
      kind: 'theme',
      bucket: 'ui_ux_confusion',
      text: 'confusing interface',
    });
    expect(key).toBe('ui_ux_confusion');
  });
});

// ── Test 6: fix_complaint_theme / respond_to_reviews are no longer single-instance

describe('SINGLE_INSTANCE_INTENTS — Phase D graduation', () => {
  it('fix_complaint_theme is no longer single-instance', () => {
    expect(SINGLE_INSTANCE_INTENTS.has('fix_complaint_theme')).toBe(false);
  });

  it('respond_to_reviews is no longer single-instance', () => {
    expect(SINGLE_INSTANCE_INTENTS.has('respond_to_reviews')).toBe(false);
  });
});

// ── Test 7: 'other' bucket → isUnresolved: true ───────────────────────────────

describe('analyzeThemes — other bucket sets isUnresolved: true', () => {
  it('marks isUnresolved=true when the LLM returns bucket "other"', async () => {
    const reviews: Review[] = reviewsForVersion('3.13.0', 3);

    const result = await analyzeThemes(
      reviews,
      stubLlm,
      makeStubGenerator({
        themes: [
          { bucket: 'other', summary: 'Something weird happened', memberReviewIds: ['123'], exemplarReviewIds: ['123'] },
        ],
        featureRequests: [],
      }),
    );

    expect(result.themes).toHaveLength(1);
    const theme = result.themes[0];
    expect(theme?.isUnresolved).toBe(true);
    expect(theme?.bucket).toBe('other');
    expect(theme?.summary).toBe('Something weird happened');
    expect(theme?.count).toBe(1);
    expect(theme?.exemplarReviewIds).toEqual(['123']);
  });
});

// ── Test 8: Named bucket → isUnresolved: false ───────────────────────────────

describe('analyzeThemes — named bucket sets isUnresolved: false', () => {
  it('marks isUnresolved=false for a named taxonomy bucket', async () => {
    const reviews: Review[] = reviewsForVersion('3.13.0', 3);

    const result = await analyzeThemes(
      reviews,
      stubLlm,
      makeStubGenerator({
        themes: [
          {
            bucket: 'crash_stability',
            summary: 'App crashes when searching for chargers',
            memberReviewIds: ['14209690246', '14199210988'],
            exemplarReviewIds: ['14209690246', '14199210988'],
          },
        ],
        featureRequests: ['Offline mode'],
      }),
    );

    expect(result.themes).toHaveLength(1);
    const theme = result.themes[0];
    expect(theme?.isUnresolved).toBe(false);
    expect(theme?.bucket).toBe('crash_stability');
    expect(theme?.summary).toBe('App crashes when searching for chargers');
    expect(theme?.count).toBe(2);
    expect(theme?.exemplarReviewIds).toEqual(['14209690246', '14199210988']);
    expect(result.featureRequests).toEqual(['Offline mode']);
  });
});

// ── Test 9: selectThemeResult reuse ─────────────────────────────────────────

const STORED_THEME_RESULT = {
  themes: [
    { bucket: 'crash_stability', summary: 'App crashes on launch', count: 2, exemplarReviewIds: ['r1', 'r2'], isUnresolved: false },
  ],
  versionDelta: null,
  featureRequests: ['Offline mode'],
  sampleSize: 2,
  taxonomyVersion: 'theme-taxonomy@1' as const,
};

function makeSnapshot(overrides: {
  reviews?: Review[];
  themeResult?: unknown;
}): ListingSnapshot {
  const reviews = overrides.reviews ?? [];
  return {
    id: 'snap-1',
    appId: 'app1',
    country: 'us',
    fetchedAt: '2026-06-24T00:00:00.000Z',
    listing: AppListingSchema.parse({
      appId: 'app1',
      country: 'us',
      url: 'https://apps.apple.com/us/app/id1',
      name: 'Test App',
      developer: 'Dev',
      iconUrl: null,
      primaryGenre: 'Productivity',
      genres: ['Productivity'],
      price: 0,
      formattedPrice: 'Free',
      subtitle: null,
      promotionalText: null,
      description: 'desc',
      releaseNotes: null,
      version: '1.0',
      screenshotUrls: [],
      ipadScreenshotUrls: [],
      hasPreviewVideo: false,
      averageRating: 4,
      ratingCount: 10,
      currentVersionRating: 4,
      currentVersionRatingCount: 5,
      contentRating: '4+',
      releaseDate: null,
      currentVersionReleaseDate: null,
      reviews,
      competitors: [],
      provenance: { itunes: true, crawler: false, reviews: false, competitors: false },
    }),
    signals: null,
    report: {
      app: { appId: 'app1', country: 'us', url: '', name: 'Test App', developer: 'Dev', iconUrl: null, primaryGenre: 'Productivity', averageRating: 4, ratingCount: 10 },
      generatedAt: '2026-06-24T00:00:00.000Z',
      headline: '',
      overallScore: 70,
      dimensions: [],
      quickWins: [],
      highImpact: [],
      strategic: [],
      competitorComparison: { summary: '', rows: [] },
      limitations: [],
    },
    rubricVersion: 'v1',
    promptHash: 'h1',
    modelId: 'stub',
    themeResult: overrides.themeResult,
  };
}

describe('selectThemeResult — reuse logic', () => {
  it('returns null when priorSnapshot is null', () => {
    const reviews: Review[] = [makeReview({ id: 'r1' })];
    expect(selectThemeResult(reviews, null)).toBeNull();
  });

  it('returns null when themeResult is absent from snapshot', () => {
    const snap = makeSnapshot({ reviews: [makeReview({ id: 'r1' })] });
    const reviews: Review[] = [makeReview({ id: 'r1' })];
    expect(selectThemeResult(reviews, snap)).toBeNull();
  });

  it('returns null when themeResult has wrong schema shape', () => {
    const snap = makeSnapshot({ reviews: [makeReview({ id: 'r1' })], themeResult: { wrong: 'shape' } });
    const reviews: Review[] = [makeReview({ id: 'r1' })];
    expect(selectThemeResult(reviews, snap)).toBeNull();
  });

  it('returns null when review IDs differ from prior snapshot', () => {
    const snap = makeSnapshot({ reviews: [makeReview({ id: 'r1' })], themeResult: STORED_THEME_RESULT });
    const reviews: Review[] = [makeReview({ id: 'r2' })]; // different id
    expect(selectThemeResult(reviews, snap)).toBeNull();
  });

  it('returns null when current review count differs', () => {
    const snap = makeSnapshot({ reviews: [makeReview({ id: 'r1' })], themeResult: STORED_THEME_RESULT });
    const reviews: Review[] = [makeReview({ id: 'r1' }), makeReview({ id: 'r2' })];
    expect(selectThemeResult(reviews, snap)).toBeNull();
  });

  it('returns stored result when review IDs match', () => {
    const snap = makeSnapshot({ reviews: [makeReview({ id: 'r1' }), makeReview({ id: 'r2' })], themeResult: STORED_THEME_RESULT });
    const reviews: Review[] = [makeReview({ id: 'r1' }), makeReview({ id: 'r2' })];
    const result = selectThemeResult(reviews, snap);
    expect(result).not.toBeNull();
    expect(result?.themes).toHaveLength(1);
    expect(result?.themes[0]?.bucket).toBe('crash_stability');
    expect(result?.featureRequests).toEqual(['Offline mode']);
    expect(result?.taxonomyVersion).toBe('theme-taxonomy@1');
  });

  it('returns stored result regardless of review order', () => {
    const snap = makeSnapshot({ reviews: [makeReview({ id: 'r1' }), makeReview({ id: 'r2' })], themeResult: STORED_THEME_RESULT });
    // Same reviews, different order
    const reviews: Review[] = [makeReview({ id: 'r2' }), makeReview({ id: 'r1' })];
    expect(selectThemeResult(reviews, snap)).not.toBeNull();
  });
});

// ── New suite: parseThemeResponse guards ──────────────────────────────────────

describe('analyzeThemes — code-side guards in parseThemeResponse', () => {
  const reviews = reviewsForVersion('3.13.0', 5);

  it('one-entry-per-bucket: single bucket in output', async () => {
    const result = await analyzeThemes(reviews, stubLlm, makeStubGenerator({
      themes: [
        { bucket: 'crash_stability', summary: 'Crashes on launch', memberReviewIds: ['r1', 'r2'], exemplarReviewIds: ['r1'] },
      ],
      featureRequests: [],
    }));
    expect(result.themes).toHaveLength(1);
    expect(result.themes[0]!.bucket).toBe('crash_stability');
    expect(result.themes[0]!.summary).toBe('Crashes on launch');
    expect(result.themes[0]!.count).toBe(2);
    expect(result.themes[0]!.exemplarReviewIds).toEqual(['r1']);
    expect(result.themes[0]!.isUnresolved).toBe(false);
  });

  it('duplicate-bucket merge: two entries for same bucket merged into one', async () => {
    const result = await analyzeThemes(reviews, stubLlm, makeStubGenerator({
      themes: [
        { bucket: 'ads_intrusive', summary: 'Too many ads', memberReviewIds: ['r1', 'r2'], exemplarReviewIds: ['r1'] },
        { bucket: 'ads_intrusive', summary: 'Ads every song', memberReviewIds: ['r3'], exemplarReviewIds: ['r3'] },
      ],
      featureRequests: [],
    }));
    // Must merge into one entry
    expect(result.themes).toHaveLength(1);
    expect(result.themes[0]!.bucket).toBe('ads_intrusive');
    // count = union of memberReviewIds
    expect(result.themes[0]!.count).toBe(3);
  });

  it('memberReviewId dedup: duplicate IDs across entries are counted once', async () => {
    const result = await analyzeThemes(reviews, stubLlm, makeStubGenerator({
      themes: [
        { bucket: 'ads_intrusive', summary: 'Too many ads', memberReviewIds: ['r1', 'r2'], exemplarReviewIds: ['r1'] },
        { bucket: 'ads_intrusive', summary: 'Ads every song', memberReviewIds: ['r1', 'r3'], exemplarReviewIds: ['r3'] },
      ],
      featureRequests: [],
    }));
    // r1 appears in both; count must be 3 (r1, r2, r3), not 4
    expect(result.themes[0]!.count).toBe(3);
  });

  it('exemplar cap: caps exemplarReviewIds at 3', async () => {
    const result = await analyzeThemes(reviews, stubLlm, makeStubGenerator({
      themes: [
        { bucket: 'performance_speed', summary: 'App is slow', memberReviewIds: ['r1','r2','r3','r4','r5'], exemplarReviewIds: ['r1','r2','r3','r4','r5'] },
      ],
      featureRequests: [],
    }));
    expect(result.themes[0]!.exemplarReviewIds.length).toBeLessThanOrEqual(3);
  });

  it('count correctness: count equals deduplicated memberReviewIds length', async () => {
    const result = await analyzeThemes(reviews, stubLlm, makeStubGenerator({
      themes: [
        { bucket: 'ui_ux_confusion', summary: 'Confusing UI', memberReviewIds: ['a', 'b', 'b', 'c'], exemplarReviewIds: ['a'] },
      ],
      featureRequests: [],
    }));
    // 'b' is duplicate → count = 3
    expect(result.themes[0]!.count).toBe(3);
  });

  it('sampleSize equals the number of reviews passed in', async () => {
    const fiveReviews = reviewsForVersion('3.13.0', 5);
    const result = await analyzeThemes(fiveReviews, stubLlm, makeStubGenerator({
      themes: [],
      featureRequests: [],
    }));
    expect(result.sampleSize).toBe(5);
  });
});
