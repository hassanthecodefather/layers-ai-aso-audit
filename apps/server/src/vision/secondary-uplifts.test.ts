/**
 * §F P2 Acceptance Tests: Secondary Uplifts
 *
 * TDD: these tests are written FIRST and run RED before implementation.
 *
 * Tests:
 * 1. Promote-panel fires only on non-panoramic sets
 * 2. Duplicate message flag
 * 3. Cross-device slot counts are pure code (no LLM)
 * 4. PPO treatment count
 */

import { describe, it, expect } from 'vitest';
import type { AppListing } from '../domain/listing';
import type { ScreenshotSetRawResult } from './client';

// ── §F P2 Test 1: Promote-panel fires only on non-panoramic sets ─────────────
describe('runSecondaryUplifts — promote-panel', () => {
  it('includes a promote-panel suggestion for non-panoramic sets and omits it for panoramic sets', async () => {
    const { runSecondaryUplifts } = await import('./secondary-uplifts');
    const { StubVisionClient } = await import('./client');

    const nonPanoramicResult: ScreenshotSetRawResult = {
      roles: [
        { slot: 1, roleTag: 'hero', valueProp: 'Great value prop' },
        { slot: 2, roleTag: 'feature-1', valueProp: 'Feature highlight' },
        { slot: 3, roleTag: 'feature-2', valueProp: 'Another feature' },
        { slot: 4, roleTag: 'social-proof', valueProp: 'Testimonials' },
        { slot: 5, roleTag: 'cta', valueProp: 'Call to action' },
      ],
      hasDuplicateMessages: false,
      duplicateSlots: [],
      isPanoramicSet: false,
      treatmentCount: 2,
      strongestSlotForPromotion: 4, // slot 4 is the strongest, should be promoted
    };

    const panoramicResult: ScreenshotSetRawResult = {
      roles: [
        { slot: 1, roleTag: 'panorama-part-1', valueProp: 'Left panel' },
        { slot: 2, roleTag: 'panorama-part-2', valueProp: 'Middle panel' },
        { slot: 3, roleTag: 'panorama-part-3', valueProp: 'Right panel' },
      ],
      hasDuplicateMessages: false,
      duplicateSlots: [],
      isPanoramicSet: true, // panoramic — no reordering
      treatmentCount: 1,
      strongestSlotForPromotion: null,
    };

    const nonPanoramicStub = new StubVisionClient(
      { critiques: [], competitorComparison: '', suggestedCoarseScore: 5 },
      { pHashDistance: 32, confusable: 'Unknown', categoryCohesion: 'Unknown' },
      nonPanoramicResult,
    );

    const panoramicStub = new StubVisionClient(
      { critiques: [], competitorComparison: '', suggestedCoarseScore: 5 },
      { pHashDistance: 32, confusable: 'Unknown', categoryCohesion: 'Unknown' },
      panoramicResult,
    );

    const listing = makeListing({
      screenshotUrls: ['https://example.com/ss1.jpg', 'https://example.com/ss2.jpg',
        'https://example.com/ss3.jpg', 'https://example.com/ss4.jpg', 'https://example.com/ss5.jpg'],
    });

    const nonPanoramicUplifts = await runSecondaryUplifts(listing, nonPanoramicStub);
    const panoramicUplifts = await runSecondaryUplifts(listing, panoramicStub);

    // Non-panoramic: promote-panel suggestion should be present
    expect(nonPanoramicUplifts.screenshotSetAnalysis.promoteCandidateSlot).toBe(4);
    // Panoramic: no promote-panel suggestion
    expect(panoramicUplifts.screenshotSetAnalysis.promoteCandidateSlot).toBeNull();
  });
});

// ── §F P2 Test 2: Duplicate message flag ──────────────────────────────────────
describe('runSecondaryUplifts — duplicate message flag', () => {
  it('includes a duplicate-message finding when hasDuplicateMessages is true', async () => {
    const { runSecondaryUplifts } = await import('./secondary-uplifts');
    const { StubVisionClient } = await import('./client');

    const duplicateResult: ScreenshotSetRawResult = {
      roles: [
        { slot: 1, roleTag: 'hero', valueProp: 'Save time' },
        { slot: 2, roleTag: 'feature-1', valueProp: 'Save time' }, // duplicate!
      ],
      hasDuplicateMessages: true,
      duplicateSlots: [1, 2],
      isPanoramicSet: false,
      treatmentCount: 1,
      strongestSlotForPromotion: null,
    };

    const stubClient = new StubVisionClient(
      { critiques: [], competitorComparison: '', suggestedCoarseScore: 5 },
      { pHashDistance: 32, confusable: 'Unknown', categoryCohesion: 'Unknown' },
      duplicateResult,
    );

    const listing = makeListing({
      screenshotUrls: ['https://example.com/ss1.jpg', 'https://example.com/ss2.jpg'],
    });

    const result = await runSecondaryUplifts(listing, stubClient);

    expect(result.screenshotSetAnalysis.hasDuplicateMessages).toBe(true);
    expect(result.screenshotSetAnalysis.duplicateSlots).toEqual([1, 2]);
  });
});

// ── §F P2 Test 3: Cross-device slot counts are pure code (no LLM) ─────────────
describe('computeDeviceMatrix — pure function, no LLM', () => {
  it('returns slot counts from listing data without calling any model', async () => {
    const { computeDeviceMatrix } = await import('./secondary-uplifts');

    const listing = makeListing({
      screenshotUrls: Array.from({ length: 7 }, (_, i) => `https://example.com/iphone-ss${i + 1}.jpg`),
      ipadScreenshotUrls: Array.from({ length: 3 }, (_, i) => `https://example.com/ipad-ss${i + 1}.jpg`),
    });

    const matrix = computeDeviceMatrix(listing);

    expect(matrix).toEqual({
      iphone: { slotsUsed: 7, maxSlots: 10 },
      ipad: { slotsUsed: 3, maxSlots: 10 },
      ipadMissing: true, // gap is 4 (≥3)
    });
  });
});

// ── §F P2 Test 4: PPO treatment count ────────────────────────────────────────
describe('runSecondaryUplifts — PPO treatment count', () => {
  it('includes ppoBriefRecommendation with exceeded=true when treatmentCount > 3', async () => {
    const { runSecondaryUplifts } = await import('./secondary-uplifts');
    const { StubVisionClient } = await import('./client');

    const highTreatmentResult: ScreenshotSetRawResult = {
      roles: [
        { slot: 1, roleTag: 'hero', valueProp: 'Main value prop' },
      ],
      hasDuplicateMessages: false,
      duplicateSlots: [],
      isPanoramicSet: false,
      treatmentCount: 4, // exceeds the ≤3 limit
      strongestSlotForPromotion: null,
    };

    const stubClient = new StubVisionClient(
      { critiques: [], competitorComparison: '', suggestedCoarseScore: 5 },
      { pHashDistance: 32, confusable: 'Unknown', categoryCohesion: 'Unknown' },
      highTreatmentResult,
    );

    const listing = makeListing({
      screenshotUrls: ['https://example.com/ss1.jpg'],
    });

    const result = await runSecondaryUplifts(listing, stubClient);

    expect(result.ppoBrief.treatmentCount).toBe(4);
    expect(result.ppoBrief.exceeded).toBe(true);
    expect(result.ppoBrief.maxTreatments).toBe(3);
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeListing(
  overrides: Partial<{
    screenshotUrls: string[];
    ipadScreenshotUrls: string[];
    iconUrl: string | null;
  }> = {},
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
    ipadScreenshotUrls: overrides.ipadScreenshotUrls ?? [],
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
    },
  };
}
