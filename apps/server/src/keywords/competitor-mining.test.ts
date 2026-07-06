import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mineCompetitorReviews, formatCompetitorMiningForPrompt } from './competitor-mining';
import type { Competitor } from '../domain/listing';
import type { Review } from '../domain/listing';
import type { LlmProvider } from '../llm';
import type { ThemeAnalysisResult } from '../reviews/themes';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeCompetitor(overrides: Partial<Competitor> = {}): Competitor {
  return {
    appId: '123456789',
    name: 'CompetitorApp',
    developer: 'Competitor Inc.',
    primaryGenre: 'Utilities',
    averageRating: 3.2,
    ratingCount: 500,
    formattedPrice: 'Free',
    screenshotCount: 5,
    hasPreviewVideo: false,
    ...overrides,
  };
}

let _reviewCounter = 0;
function makeReview(rating: number, body = 'Review body'): Review {
  return {
    author: 'User',
    rating,
    title: 'Title',
    body,
    updated: null,
    id: `review-${++_reviewCounter}`,
    appVersion: '1.0',
  };
}

const STUB_THEME_RESULT: ThemeAnalysisResult = {
  themes: [
    {
      bucket: 'crash_stability',
      summary: 'App crashes on startup frequently',
      count: 2,
      exemplarReviewIds: ['r1', 'r2'],
      isUnresolved: false,
    },
    {
      bucket: 'battery_resource',
      summary: 'Drains battery too fast',
      count: 1,
      exemplarReviewIds: ['r3'],
      isUnresolved: false,
    },
  ],
  versionDelta: null,
  featureRequests: [],
  sampleSize: 3,
  taxonomyVersion: 'theme-taxonomy@1',
};

const EMPTY_THEME_RESULT: ThemeAnalysisResult = {
  themes: [],
  versionDelta: null,
  featureRequests: [],
  sampleSize: 0,
  taxonomyVersion: 'theme-taxonomy@1',
};

// Stub LLM — never used because _analyzeOverride is always provided in tests
const stubLlm = {} as LlmProvider;

// Stub fetchReviews that returns a mix of ratings
function stubFetch(reviews: Review[]) {
  return vi.fn().mockResolvedValue(reviews);
}

// Always-empty fetch stub (simulates no low-rating reviews)
const emptyFetch = vi.fn().mockResolvedValue([makeReview(5), makeReview(4)]);

// Always-failing fetch stub (simulates network error)
const failingFetch = vi.fn().mockRejectedValue(new Error('Network error'));

beforeEach(() => {
  _reviewCounter = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── mineCompetitorReviews ─────────────────────────────────────────────────────

describe('mineCompetitorReviews', () => {
  it('returns null when competitors list is empty', async () => {
    const result = await mineCompetitorReviews([], 'us', stubLlm);
    expect(result).toBeNull();
  });

  it('returns pain points from competitor 1–2★ reviews', async () => {
    const competitor = makeCompetitor({ name: 'RivalApp' });
    const reviews = [
      makeReview(1, 'Crashes constantly'),
      makeReview(2, 'Uses all battery'),
      makeReview(5, 'Love it'),   // filtered — 5★
      makeReview(4, 'Great app'), // filtered — 4★
    ];
    const fetchStub = stubFetch(reviews);
    const analyzeStub = vi.fn().mockResolvedValue(STUB_THEME_RESULT);

    const result = await mineCompetitorReviews([competitor], 'us', stubLlm, analyzeStub, fetchStub);

    expect(result).not.toBeNull();
    expect(result!.painPoints).toHaveLength(2);
    expect(result!.painPoints[0]!.bucket).toBe('crash_stability');
    expect(result!.competitorsCovered).toContain('RivalApp');
    expect(result!.lowRatingReviewCount).toBe(2); // only 1★ + 2★
  });

  it('only passes 1–2★ reviews to analyzeThemes', async () => {
    const competitor = makeCompetitor({ name: 'RivalApp' });
    const reviews = [
      makeReview(1, 'Terrible'),
      makeReview(2, 'Bad'),
      makeReview(3, 'Mediocre'), // filtered — 3★
      makeReview(5, 'Excellent'), // filtered — 5★
    ];
    const fetchStub = stubFetch(reviews);

    let capturedReviews: Review[] = [];
    const analyzeStub = vi.fn().mockImplementation(async (received: Review[]) => {
      capturedReviews = received;
      return STUB_THEME_RESULT;
    });

    await mineCompetitorReviews([competitor], 'us', stubLlm, analyzeStub, fetchStub);

    expect(capturedReviews).toHaveLength(2);
    for (const r of capturedReviews) {
      expect(r.rating).toBeLessThanOrEqual(2);
    }
  });

  it('returns null when all competitor reviews are high-rating (no low-rating)', async () => {
    const competitor = makeCompetitor({ name: 'PerfectApp' });
    const analyzeStub = vi.fn().mockResolvedValue(STUB_THEME_RESULT);

    const result = await mineCompetitorReviews(
      [competitor], 'us', stubLlm, analyzeStub, emptyFetch,
    );

    expect(result).toBeNull();
    expect(analyzeStub).not.toHaveBeenCalled();
  });

  it('returns null when analyzeThemes returns no themes', async () => {
    const competitor = makeCompetitor({ name: 'MixedApp' });
    const fetchStub = stubFetch([makeReview(1, 'Bad')]);
    const analyzeStub = vi.fn().mockResolvedValue(EMPTY_THEME_RESULT);

    const result = await mineCompetitorReviews([competitor], 'us', stubLlm, analyzeStub, fetchStub);

    expect(result).toBeNull();
  });

  it('silently skips competitors whose fetch fails, continues with others', async () => {
    const badCompetitor = makeCompetitor({ appId: '1', name: 'BadApp' });
    const goodCompetitor = makeCompetitor({ appId: '2', name: 'GoodApp' });

    let callCount = 0;
    const mixedFetch = vi.fn().mockImplementation(async ({ appId }: { appId: string }) => {
      callCount++;
      if (appId === '1') throw new Error('fetch failed');
      return [makeReview(1, 'Crash'), makeReview(2, 'Slow')];
    });
    const analyzeStub = vi.fn().mockResolvedValue(STUB_THEME_RESULT);

    const result = await mineCompetitorReviews(
      [badCompetitor, goodCompetitor], 'us', stubLlm, analyzeStub, mixedFetch,
    );

    expect(result).not.toBeNull();
    expect(result!.competitorsCovered).toContain('GoodApp');
    expect(result!.competitorsCovered).not.toContain('BadApp');
  });

  it('limits to 3 competitors (MAX_COMPETITORS)', async () => {
    const competitors = ['A', 'B', 'C', 'D'].map((name, i) =>
      makeCompetitor({ appId: String(i + 1), name }),
    );
    const fetchStub = vi.fn().mockResolvedValue([makeReview(1, 'Bad')]);
    const analyzeStub = vi.fn().mockResolvedValue(STUB_THEME_RESULT);

    const result = await mineCompetitorReviews(
      competitors, 'us', stubLlm, analyzeStub, fetchStub,
    );

    // fetch is called at most 3 times (MAX_COMPETITORS = 3), not 4
    expect(fetchStub).toHaveBeenCalledTimes(3);
    expect(result!.competitorsCovered.length).toBeLessThanOrEqual(3);
  });

  it('aggregates reviews from multiple competitors in one analyzeThemes call', async () => {
    const competitors = [
      makeCompetitor({ appId: '1', name: 'AppA' }),
      makeCompetitor({ appId: '2', name: 'AppB' }),
    ];
    const fetchStub = vi.fn().mockResolvedValue([
      makeReview(1, 'Crash'), makeReview(2, 'Slow'),
    ]);

    let receivedCount = 0;
    const analyzeStub = vi.fn().mockImplementation(async (reviews: Review[]) => {
      receivedCount = reviews.length;
      return STUB_THEME_RESULT;
    });

    await mineCompetitorReviews(competitors, 'us', stubLlm, analyzeStub, fetchStub);

    // 2 competitors × 2 low-rating reviews each = 4 total passed to analyzeThemes
    expect(receivedCount).toBe(4);
    // analyzeThemes called once, not per competitor
    expect(analyzeStub).toHaveBeenCalledTimes(1);
  });

  it('annotates every pain point with contributor competitor names', async () => {
    const competitor = makeCompetitor({ name: 'Rival' });
    const fetchStub = stubFetch([makeReview(1, 'Bad')]);
    const analyzeStub = vi.fn().mockResolvedValue(STUB_THEME_RESULT);

    const result = await mineCompetitorReviews(
      [competitor], 'us', stubLlm, analyzeStub, fetchStub,
    );

    for (const pt of result!.painPoints) {
      expect(pt.competitors).toContain('Rival');
    }
  });
});

// ── formatCompetitorMiningForPrompt ───────────────────────────────────────────

describe('formatCompetitorMiningForPrompt', () => {
  it('returns empty string for null', () => {
    expect(formatCompetitorMiningForPrompt(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(formatCompetitorMiningForPrompt(undefined)).toBe('');
  });

  it('returns empty string when no pain points', () => {
    expect(formatCompetitorMiningForPrompt({
      painPoints: [],
      competitorsCovered: ['AppA'],
      lowRatingReviewCount: 5,
    })).toBe('');
  });

  it('includes low-rating review count and competitor names', () => {
    const section = formatCompetitorMiningForPrompt({
      painPoints: [
        { bucket: 'crash_stability', text: 'Crashes on startup', reviewCount: 3, competitors: ['AppA'] },
      ],
      competitorsCovered: ['AppA', 'AppB'],
      lowRatingReviewCount: 42,
    });

    expect(section).toContain('42');
    expect(section).toContain('AppA');
    expect(section).toContain('AppB');
    expect(section).toContain('provenance: observed');
  });

  it('includes each pain point bucket and description', () => {
    const section = formatCompetitorMiningForPrompt({
      painPoints: [
        { bucket: 'crash_stability', text: 'Crashes on startup', reviewCount: 5, competitors: ['X'] },
        { bucket: 'battery_resource', text: 'Battery drain', reviewCount: 2, competitors: ['X'] },
      ],
      competitorsCovered: ['X'],
      lowRatingReviewCount: 7,
    });

    expect(section).toContain('crash_stability');
    expect(section).toContain('Crashes on startup');
    expect(section).toContain('battery_resource');
    expect(section).toContain('Battery drain');
  });

  it('includes recommendation instruction mentioning add_keyword', () => {
    const section = formatCompetitorMiningForPrompt({
      painPoints: [
        { bucket: 'crash_stability', text: 'Crashes', reviewCount: 1, competitors: ['A'] },
      ],
      competitorsCovered: ['A'],
      lowRatingReviewCount: 1,
    });

    expect(section).toContain('add_keyword');
  });
});
