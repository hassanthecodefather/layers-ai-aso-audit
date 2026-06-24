import { describe, it, expect } from 'vitest';
import type { AppListing } from '../domain/listing';
import { computeSignals, words } from './signals';

/** Build an AppListing with sensible defaults; override per test. */
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
    description: 'Line one.\nLine two.\nLine three.\nLine four.',
    releaseNotes: 'Bug fixes and improvements.',
    version: '1.0.0',
    screenshotUrls: [],
    ipadScreenshotUrls: [],
    hasPreviewVideo: false,
    averageRating: 4.5,
    ratingCount: 1000,
    currentVersionRating: 4.2,
    currentVersionRatingCount: 50,
    contentRating: '4+',
    releaseDate: '2020-01-01T00:00:00Z',
    currentVersionReleaseDate: '2024-01-01T00:00:00Z',
    reviews: [],
    competitors: [],
    provenance: { itunes: true, crawler: false, reviews: false, competitors: false },
    ...overrides,
  };
}

describe('words', () => {
  it('lowercases, dedupes and drops words shorter than 3 chars', () => {
    expect(words('Run a 5K Run NOW').sort()).toEqual(['now', 'run']);
  });
});

describe('computeSignals — title', () => {
  it('measures length and utilisation against the 30-char limit', () => {
    const s = computeSignals(makeListing({ name: 'Habit Tracker' })); // 13 chars
    expect(s.title.length).toBe(13);
    expect(s.title.limit).toBe(30);
    expect(s.title.utilizationPct).toBe(43);
    expect(s.title.overLimit).toBe(false);
  });

  it('flags a title over the 30-char limit', () => {
    const s = computeSignals(
      makeListing({ name: 'A Very Long Title That Exceeds Apple Limit' }),
    );
    expect(s.title.overLimit).toBe(true);
  });
});

describe('computeSignals — subtitle', () => {
  it('is not observable without Firecrawl', () => {
    const s = computeSignals(makeListing({ subtitle: null }));
    expect(s.subtitle.observable).toBe(false);
    expect(s.subtitle.length).toBe(0);
  });

  it('detects words wasted by repeating the title', () => {
    const s = computeSignals(
      makeListing({
        name: 'Calm Meditation',
        subtitle: 'Meditation and sleep',
        provenance: {
          itunes: true,
          crawler: true,
          reviews: false,
          competitors: false,
        },
      }),
    );
    expect(s.subtitle.observable).toBe(true);
    expect(s.subtitle.wordsSharedWithTitle).toEqual(['meditation']);
  });
});

describe('computeSignals — screenshots', () => {
  it('counts iPhone slots and caps the "of 10" figure', () => {
    const s = computeSignals(
      makeListing({ screenshotUrls: Array(12).fill('x') }),
    );
    expect(s.screenshots.iphoneCount).toBe(12);
    expect(s.screenshots.slotsUsedOf10).toBe(10);
  });
});

describe('computeSignals — ratings', () => {
  it('averages the review sample and computes the negative share', () => {
    const reviews = [
      { author: 'a', rating: 5, title: '', body: '', updated: null },
      { author: 'b', rating: 1, title: '', body: '', updated: null },
      { author: 'c', rating: 2, title: '', body: '', updated: null },
      { author: 'd', rating: 4, title: '', body: '', updated: null },
    ];
    const s = computeSignals(makeListing({ reviews }));
    expect(s.ratings.reviewSampleSize).toBe(4);
    expect(s.ratings.reviewSampleAverage).toBe(3);
    expect(s.ratings.negativeReviewShare).toBe(0.5);
  });

  it('returns null sample stats when there are no reviews', () => {
    const s = computeSignals(makeListing({ reviews: [] }));
    expect(s.ratings.reviewSampleAverage).toBeNull();
    expect(s.ratings.negativeReviewShare).toBeNull();
  });
});

describe('computeSignals — keyword field', () => {
  it('is always marked not observable', () => {
    const s = computeSignals(makeListing());
    expect(s.keywordField.observable).toBe(false);
  });
});
