/**
 * §F P2 Acceptance Tests: Vision Pass — Gemini Vision over Screenshots + Icon
 *
 * TDD: these tests are written FIRST and run RED before implementation.
 */

import { describe, it, expect } from 'vitest';
import type { VisionResult } from './types';
import type { AppListing } from '../domain/listing';
import type { ListingSignals } from '../scoring/signals';
import { runLinter } from '../keywords/linter';
import type { ListingSnapshot } from '../domain/snapshot';

// ── §F P2 Test 1: Confidence-labelled critique ────────────────────────────────
describe('runVision — confidence labels', () => {
  it('screenshotSetVerdict.confidence is observed, pHashDistance.confidence is inferred (no competitors), confusable.confidence is inferred', async () => {
    // Import lazily inside the test so the RED run catches missing modules
    const { runVision } = await import('./analyze');
    const { StubVisionClient } = await import('./client');

    const stubClient = new StubVisionClient(
      {
        critiques: [
          {
            slot: 1,
            valuePropClarity: 'Clear value prop in first frame',
            readability: 'Good readability',
            cohesion: 'Cohesive design',
          },
        ],
        competitorComparison: 'Better than competitors',
        suggestedCoarseScore: 10,
      },
      {
        pHashDistance: 5,
        confusable: 'Not confusable with competitors',
        categoryCohesion: 'Fits the productivity category',
      },
    );

    const listing = makeListing({
      screenshotUrls: ['https://example.com/ss1.jpg'],
      iconUrl: 'https://example.com/icon.png',
    });

    // Use a no-op image fetcher so no real HTTP is made
    const noopFetcher = async (_url: string): Promise<Buffer> =>
      Buffer.alloc(100, 0x42); // 100 bytes of 0x42

    const result = await runVision(listing, stubClient, noopFetcher);

    // §F P2 Test 1 assertions
    expect(result.screenshotSetVerdict.confidence).toBe('observed');
    expect(result.iconVerdict).not.toBeNull();
    // pHashDistance: 'inferred' because no competitor icon URLs are available — placeholder 64 returned.
    expect(result.iconVerdict!.pHashDistance.confidence).toBe('inferred');
    expect(result.iconVerdict!.confusable.confidence).toBe('inferred');
  });
});

// ── §F P2 Test 2: Reuse — zero LLM calls when URLs match ─────────────────────
describe('selectVisionResult — reuse logic', () => {
  it('returns prior VisionResult when screenshot + icon URLs match, without calling the vision client', async () => {
    const { selectVisionResult } = await import('./select');
    const { StubVisionClient } = await import('./client');

    const stubClient = new StubVisionClient(
      {
        critiques: [],
        competitorComparison: 'ok',
        suggestedCoarseScore: 5,
      },
      {
        pHashDistance: 3,
        confusable: 'Not confusable',
        categoryCohesion: 'Good',
      },
    );

    const listing = makeListing({
      screenshotUrls: ['https://example.com/ss1.jpg', 'https://example.com/ss2.jpg'],
      iconUrl: 'https://example.com/icon.png',
    });

    const signals = makeSignals(listing.screenshotUrls.length);

    const priorVisionResult: VisionResult = {
      screenshotSetVerdict: {
        critiques: [],
        competitorComparison: { value: 'ok', confidence: 'observed' },
        coarseScore: 5,
        confidence: 'observed',
        modelId: 'gemini-2.5-flash',
      },
      iconVerdict: {
        pHashDistance: { value: 3, confidence: 'observed' },
        confusable: { value: 'Not confusable', confidence: 'inferred' },
        categoryCohesion: { value: 'Good', confidence: 'inferred' },
        confidence: 'observed',
        modelId: 'gemini-2.5-flash',
      },
    };

    const priorSnap = makePriorSnapshot(listing, signals, priorVisionResult);

    // selectVisionResult should return the prior result WITHOUT calling the client
    const result = selectVisionResult(listing, signals, priorSnap);

    expect(result).not.toBeNull();
    expect(result!.screenshotSetVerdict.coarseScore).toBe(5);
    // The stub client was never invoked — callCount stays at 0
    expect(stubClient.callCount).toBe(0);
  });

  it('returns null when no prior snapshot exists, forcing vision re-run', async () => {
    const { selectVisionResult } = await import('./select');

    const listing = makeListing({
      screenshotUrls: ['https://example.com/ss1.jpg'],
      iconUrl: 'https://example.com/icon.png',
    });
    const signals = makeSignals(1);

    const result = selectVisionResult(listing, signals, null);
    expect(result).toBeNull();
  });
});

// ── §F P2 Test 3: pHash / confusability confidence labels ────────────────────
describe('runVision — pHash and confusable confidence labels', () => {
  it('IconVerdict.pHashDistance.confidence is inferred (no competitors) and confusable.confidence is inferred', async () => {
    const { runVision } = await import('./analyze');
    const { StubVisionClient } = await import('./client');

    const stubClient = new StubVisionClient(
      {
        critiques: [
          { slot: 1, valuePropClarity: 'ok', readability: 'ok', cohesion: 'ok' },
        ],
        competitorComparison: 'comparable',
        suggestedCoarseScore: 5,
      },
      {
        pHashDistance: 12,
        confusable: 'Not confusable',
        categoryCohesion: 'Fits category',
      },
    );

    const listing = makeListing({
      screenshotUrls: ['https://example.com/ss1.jpg'],
      iconUrl: 'https://example.com/icon.png',
    });

    const noopFetcher = async (_url: string): Promise<Buffer> =>
      Buffer.alloc(200, 0x10);

    const result = await runVision(listing, stubClient, noopFetcher);

    expect(result.iconVerdict).not.toBeNull();
    // pHashDistance: 'inferred' when no competitor icons are available (placeholder 64 returned).
    // When real competitor icon URLs are present, it would be 'observed' (computed from pixels).
    expect(result.iconVerdict!.pHashDistance.confidence).toBe('inferred');
    // confusable is a vision model judgment → 'inferred'
    expect(result.iconVerdict!.confusable.confidence).toBe('inferred');
    // categoryCohesion is also a vision judgment → 'inferred'
    expect(result.iconVerdict!.categoryCohesion.confidence).toBe('inferred');
  });
});

// ── B-follow-up: empty screenshotUrls defeats the visionUsable guard ──────────
describe('runVision — empty screenshotUrls (B-follow-up)', () => {
  it('skips the model call and emits empty critiques when screenshotUrls is empty', async () => {
    const { runVision } = await import('./analyze');
    const { StubVisionClient } = await import('./client');
    const { visionUsable } = await import('../scoring/dimension-scorer');

    // Stub returns non-empty critiques — simulating Gemini's placeholder
    // response ("No screenshots provided") when given an empty URL list.
    // The short-circuit must prevent the call entirely.
    const stubClient = new StubVisionClient(
      {
        critiques: [
          { slot: 1, valuePropClarity: 'No screenshots provided', readability: 'N/A', cohesion: 'N/A' },
        ],
        competitorComparison: '',
        suggestedCoarseScore: 0,
      },
      { pHashDistance: 0, confusable: 'N/A', categoryCohesion: 'N/A' },
    );

    // Build the listing directly so iconUrl is literally null (makeListing's
    // ?? operator coerces null to the default URL, which would trigger icon
    // analysis and increment callCount via analyzeIcon).
    const listing: AppListing = {
      ...makeListing({ screenshotUrls: [] }),
      iconUrl: null,
    };
    const noopFetcher = async (_url: string): Promise<Buffer> => Buffer.alloc(0);

    const result = await runVision(listing, stubClient, noopFetcher);

    // No model call — the short-circuit must have fired.
    expect(stubClient.callCount).toBe(0);

    // visionUsable must be false so downstream falls back to slotsUsedOf10.
    expect(visionUsable(result)).toBe(false);

    // Confidence must stay inferred — not observed.
    expect(result.screenshotSetVerdict.confidence).toBe('inferred');

    // critiques are empty (the short-circuit result, not the stub's canned data).
    expect(result.screenshotSetVerdict.critiques).toHaveLength(0);
  });

  it('codeScore falls back to slotsUsedOf10 when visionUsable is false', async () => {
    const { codeScore, visionUsable } = await import('../scoring/dimension-scorer');

    // A listing with 7 slots used but an unusable vision result (empty critiques).
    const signals = makeSignals(7);
    const unusableVision: VisionResult = {
      screenshotSetVerdict: {
        critiques: [],
        competitorComparison: { value: '', confidence: 'inferred' },
        coarseScore: 0,
        confidence: 'inferred',
        modelId: 'gemini-2.5-flash',
      },
      iconVerdict: null,
    };

    expect(visionUsable(unusableVision)).toBe(false);
    // Score must be the honest slot count (7), not the placeholder 0.
    expect(codeScore('screenshots', signals, unusableVision)).toBe(7);
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeListing(
  overrides: Partial<{ screenshotUrls: string[]; iconUrl: string | null }> = {},
): AppListing {
  return {
    appId: 'test-app-1',
    country: 'us',
    url: 'https://apps.apple.com/us/app/test/id123',
    name: 'Test App',
    developer: 'Test Dev',
    iconUrl: overrides.iconUrl ?? 'https://example.com/icon.png',
    primaryGenre: 'Productivity',
    genres: ['Productivity'],
    price: 0,
    formattedPrice: 'Free',
    bundleId: 'com.example.testapp',
    sellerUrl: 'https://example.com',
    subtitle: null,
    promotionalText: null,
    description: 'A test app for testing.',
    releaseNotes: null,
    version: '1.0.0',
    screenshotUrls: overrides.screenshotUrls ?? ['https://example.com/ss1.jpg'],
    ipadScreenshotUrls: [],
    hasPreviewVideo: false,
    crawledScreenshotCount: 0,
    averageRating: 4.5,
    ratingCount: 100,
    currentVersionRating: 4.5,
    currentVersionRatingCount: 50,
    contentRating: '4+',
    releaseDate: '2020-01-01',
    currentVersionReleaseDate: '2024-01-01',
    reviews: [],
    competitors: [],
    provenance: {
      itunes: true,
      crawler: false,
      reviews: false,
      competitors: false,
      observedFromCache: false,
    },
  };
}

function makeSignals(screenshotCount: number): ListingSignals {
  return {
    title: { value: 'Test App', length: 8, limit: 30, utilizationPct: 27, overLimit: false },
    subtitle: { observable: false, value: null, length: 0, limit: 30, utilizationPct: 0, wordsSharedWithTitle: [] },
    keywordField: { observable: false, note: 'Not available' },
    description: { charCount: 20, lineCount: 1, aboveFold: 'A test app' },
    screenshots: { iphoneCount: screenshotCount, ipadCount: 0, slotsUsedOf10: screenshotCount },
    previewVideo: { observable: false, present: false },
    ratings: {
      allTimeAverage: 4.5,
      allTimeCount: 100,
      currentVersionAverage: 4.5,
      currentVersionCount: 50,
      reviewSampleSize: 0,
      reviewSampleAverage: null,
      negativeReviewShare: null,
    },
    icon: { present: true },
    conversion: {
      promotionalTextObservable: false,
      hasPromotionalText: false,
      hasReleaseNotes: false,
      releaseNotesLength: 0,
      daysSinceLastUpdate: 180,
    },
    competitive: { competitorCount: 0 },
    keywordLinter: runLinter({ title: 'Test App', subtitle: null, keywordField: null }),
  };
}

function makePriorSnapshot(
  listing: AppListing,
  signals: ListingSignals,
  visionResult: VisionResult,
): ListingSnapshot {
  return {
    id: 'snap-prior-1',
    appId: listing.appId,
    country: listing.country,
    fetchedAt: '2024-01-01T00:00:00.000Z',
    listing,
    signals,
    report: {
      app: {
        appId: listing.appId,
        country: listing.country,
        url: listing.url,
        name: listing.name,
        developer: listing.developer,
        iconUrl: listing.iconUrl,
        primaryGenre: listing.primaryGenre,
        averageRating: listing.averageRating,
        ratingCount: listing.ratingCount,
      },
      generatedAt: '2024-01-01T00:00:00.000Z',
      headline: 'Test headline',
      overallScore: 70,
      dimensions: [],
      quickWins: [],
      highImpact: [],
      strategic: [],
      competitorComparison: { summary: 'ok', rows: [] },
      limitations: [],
    },
    rubricVersion: 'test-rubric-v1',
    promptHash: 'test-prompt-hash',
    modelId: 'gemini-2.5-flash',
    visionResult,
  };
}
