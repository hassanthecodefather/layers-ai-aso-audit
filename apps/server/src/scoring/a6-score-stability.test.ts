/**
 * A6 score stability — end-to-end mock tests.
 *
 * These tests simulate changing one listing field at a time and assert that
 * only the affected dimension's score moves. No LLM is involved — the "model"
 * is a simple helper that returns a draft with specified scores.
 *
 * Three sections:
 *  1. assembleReport code overrides — previewVideo, screenshots, confidence
 *  2. Dimension hash isolation — changing field X only changes X's hash
 *  3. Per-dimension reuse — single-field edit moves only that dimension's score
 */

import { describe, it, expect } from 'vitest';
import type { AppListing, AppSummary } from '../domain/listing';
import {
  DIMENSION_IDS,
  type AuditDraft,
  type DimensionId,
  type ScoredDimension,
} from '../domain/audit';
import type { ListingSignals } from './signals';
import { computeSignals } from './signals';
import { assembleReport } from './aggregate';
import { allDimensionHashes } from './dimension-scorer';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const APP: AppSummary = {
  appId: '123',
  country: 'us',
  url: 'https://apps.apple.com/us/app/rivian/id123',
  name: 'Rivian',
  developer: 'Rivian Automotive',
  iconUrl: 'https://example.com/icon.png',
  primaryGenre: 'Automotive',
  averageRating: 4.5,
  ratingCount: 12000,
};

function makeListing(overrides: Partial<AppListing> = {}): AppListing {
  return {
    appId: '123',
    country: 'us',
    url: 'https://apps.apple.com/us/app/rivian/id123',
    name: 'Rivian',
    developer: 'Rivian Automotive',
    bundleId: 'com.rivian.ios',
    sellerUrl: 'https://rivian.com',
    iconUrl: 'https://example.com/icon-old.png',
    primaryGenre: 'Automotive',
    genres: ['Automotive'],
    price: 0,
    formattedPrice: 'Free',
    subtitle: 'EV Companion',
    promotionalText: null,
    description: 'The Rivian app lets you control your EV.',
    releaseNotes: 'Bug fixes.',
    version: '2.4.1',
    screenshotUrls: ['s1', 's2', 's3', 's4', 's5', 's6'],
    ipadScreenshotUrls: [],
    hasPreviewVideo: false,
    crawledScreenshotCount: 0,
    averageRating: 4.5,
    ratingCount: 12000,
    currentVersionRating: 4.3,
    currentVersionRatingCount: 200,
    contentRating: '4+',
    releaseDate: '2021-01-01T00:00:00Z',
    currentVersionReleaseDate: '2024-06-01T00:00:00Z',
    reviews: [
      { author: 'user1', rating: 5, title: 'Great', body: 'Love this app', updated: null },
      { author: 'user2', rating: 4, title: 'Good', body: 'Works well', updated: null },
      { author: 'user3', rating: 2, title: 'Buggy', body: 'Sometimes crashes', updated: null },
    ],
    competitors: [
      {
        appId: '456',
        name: 'Tesla',
        developer: 'Tesla',
        primaryGenre: 'Automotive',
        averageRating: 4.8,
        ratingCount: 50000,
        formattedPrice: 'Free',
        screenshotCount: 10,
        hasPreviewVideo: true,
      },
    ],
    provenance: { itunes: true, crawler: true, reviews: true, competitors: true, observedFromCache: false },
    ...overrides,
  };
}

/**
 * Simulate a model draft — all dimensions score at `defaultScore` unless
 * overridden. The model always claims `confidence: 'observed'` (code overrides
 * it in assembleReport when signals are provided).
 */
function makeDraft(scoreOverrides: Partial<Record<DimensionId, number>> = {}, defaultScore = 7): AuditDraft {
  return {
    headline: 'Solid listing with room to grow.',
    dimensions: DIMENSION_IDS.map(id => ({
      id,
      score: scoreOverrides[id] ?? defaultScore,
      confidence: 'observed' as const,
      findings: `Model findings for ${id}.`,
      evidence: [`Evidence for ${id}`],
    })),
    recommendations: [],
    competitorComparison: { summary: 'Average', rows: [] },
    limitations: [],
  };
}

/**
 * Replicate the per-dimension reuse logic from audit-workflow.ts scoreStep.
 * Given a fresh model draft and a prior snapshot, replace unchanged dimensions
 * with cached scores from the prior report.
 */
function applyPerDimensionReuse(
  freshDraft: AuditDraft,
  currentListing: AppListing,
  currentSignals: ListingSignals,
  priorListing: AppListing,
  priorDimensions: ScoredDimension[],
): AuditDraft {
  const priorSignals = computeSignals(priorListing);
  const currentHashes = allDimensionHashes(currentListing, currentSignals);
  const priorHashes = allDimensionHashes(priorListing, priorSignals);
  const priorById = new Map(priorDimensions.map(d => [d.id, d]));

  return {
    ...freshDraft,
    dimensions: freshDraft.dimensions.map(d => {
      if (currentHashes[d.id] === priorHashes[d.id]) {
        const cached = priorById.get(d.id);
        if (cached) {
          return {
            id: d.id,
            score: cached.score,
            confidence: cached.confidence,
            findings: cached.findings,
            evidence: cached.evidence,
          };
        }
      }
      return d;
    }),
  };
}

// ── Section 1: assembleReport code overrides ─────────────────────────────────

describe('assembleReport — code overrides win over model scores', () => {
  it('screenshots: code-scores slotsUsedOf10=6, ignores model score of 9', () => {
    const listing = makeListing({ screenshotUrls: ['s1', 's2', 's3', 's4', 's5', 's6'] });
    const signals = computeSignals(listing);
    const report = assembleReport(APP, makeDraft({ screenshots: 9 }), signals);
    expect(report.dimensions.find(d => d.id === 'screenshots')!.score).toBe(6);
  });

  it('screenshots: 10 slots → score 10, ignores model score of 4', () => {
    const listing = makeListing({
      screenshotUrls: ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10'],
    });
    const signals = computeSignals(listing);
    const report = assembleReport(APP, makeDraft({ screenshots: 4 }), signals);
    expect(report.dimensions.find(d => d.id === 'screenshots')!.score).toBe(10);
  });

  it('screenshots: 0 slots → score 0, ignores model score of 8', () => {
    const listing = makeListing({ screenshotUrls: [] });
    const signals = computeSignals(listing);
    const report = assembleReport(APP, makeDraft({ screenshots: 8 }), signals);
    expect(report.dimensions.find(d => d.id === 'screenshots')!.score).toBe(0);
  });

  it('previewVideo absent, observable (crawler=true): code-scores 0, ignores model score of 5', () => {
    const listing = makeListing({ hasPreviewVideo: false });
    const signals = computeSignals(listing); // crawler=true from base listing
    const report = assembleReport(APP, makeDraft({ previewVideo: 5 }), signals);
    expect(report.dimensions.find(d => d.id === 'previewVideo')!.score).toBe(0);
  });

  it('previewVideo present, observable: code-scores 8, ignores model score of 3', () => {
    const listing = makeListing({ hasPreviewVideo: true });
    const signals = computeSignals(listing);
    const report = assembleReport(APP, makeDraft({ previewVideo: 3 }), signals);
    expect(report.dimensions.find(d => d.id === 'previewVideo')!.score).toBe(8);
  });

  it('previewVideo not observable (crawler=false): confidence=unavailable, model score ignored', () => {
    const listing = makeListing({
      hasPreviewVideo: false,
      provenance: { itunes: true, crawler: false, reviews: false, competitors: false, observedFromCache: false },
    });
    const signals = computeSignals(listing);
    const report = assembleReport(APP, makeDraft({ previewVideo: 7 }), signals);
    const dim = report.dimensions.find(d => d.id === 'previewVideo')!;
    expect(dim.confidence).toBe('unavailable');
    expect(dim.weightedPoints).toBe(0); // excluded from total
  });

  it('subtitle not crawled: confidence=unavailable, excluded from weighted total', () => {
    const listing = makeListing({
      provenance: { itunes: true, crawler: false, reviews: false, competitors: false, observedFromCache: false },
    });
    const signals = computeSignals(listing);
    const report = assembleReport(APP, makeDraft(), signals);
    const dim = report.dimensions.find(d => d.id === 'subtitle')!;
    expect(dim.confidence).toBe('unavailable');
    expect(dim.weightedPoints).toBe(0);
  });

  it('subtitle crawled: confidence=observed', () => {
    const listing = makeListing({ subtitle: 'EV Companion' }); // base has crawler=true
    const signals = computeSignals(listing);
    const report = assembleReport(APP, makeDraft(), signals);
    expect(report.dimensions.find(d => d.id === 'subtitle')!.confidence).toBe('observed');
  });

  it('keywordField: always confidence=inferred regardless of model claim', () => {
    const listing = makeListing();
    const signals = computeSignals(listing);
    const report = assembleReport(APP, makeDraft(), signals);
    expect(report.dimensions.find(d => d.id === 'keywordField')!.confidence).toBe('inferred');
  });

  it('without signals: model scores and confidence are preserved unchanged', () => {
    const report = assembleReport(APP, makeDraft({ screenshots: 9 })); // no signals arg
    expect(report.dimensions.find(d => d.id === 'screenshots')!.score).toBe(9);
    expect(report.dimensions.find(d => d.id === 'keywordField')!.confidence).toBe('observed');
  });

  // ── ratings code-scoring ──

  it('ratings: code-scores (allTimeAverage/5)*10, ignores model score', () => {
    const listing = makeListing({ averageRating: 4.5, currentVersionRating: 4.5 });
    const signals = computeSignals(listing);
    const report = assembleReport(APP, makeDraft({ ratings: 3 }), signals);
    expect(report.dimensions.find(d => d.id === 'ratings')!.score).toBe(9);
  });

  it('ratings: declining current-version trend (≥0.3★ below all-time) nudges score -1', () => {
    const listing = makeListing({ averageRating: 4.5, currentVersionRating: 4.0 });
    const signals = computeSignals(listing);
    const report = assembleReport(APP, makeDraft({ ratings: 5 }), signals);
    expect(report.dimensions.find(d => d.id === 'ratings')!.score).toBe(8);
  });

  it('ratings: null average (brand-new app) preserves model score', () => {
    const listing = makeListing({ averageRating: null as unknown as number, ratingCount: 0 });
    const signals = computeSignals(listing);
    const report = assembleReport(APP, makeDraft({ ratings: 5 }), signals);
    expect(report.dimensions.find(d => d.id === 'ratings')!.score).toBe(5);
  });

  // ── title/subtitle coarse-ordinal ──

  it('title: model score 6 snaps to 5 (acceptable), not free 0-10', () => {
    const listing = makeListing({ name: 'Rivian EV App' }); // 13 chars = 43 %
    const signals = computeSignals(listing);
    const report = assembleReport(APP, makeDraft({ title: 6 }), signals);
    expect(report.dimensions.find(d => d.id === 'title')!.score).toBe(5);
  });

  it('title: model score 9 snaps to 10 (excellent)', () => {
    const listing = makeListing({ name: 'Rivian EV App' });
    const signals = computeSignals(listing);
    const report = assembleReport(APP, makeDraft({ title: 9 }), signals);
    expect(report.dimensions.find(d => d.id === 'title')!.score).toBe(10);
  });

  it('title: nearly-empty field (< 20 % utilization) forced to 0 regardless of model', () => {
    const listing = makeListing({ name: 'App' }); // 3 chars = 10 %
    const signals = computeSignals(listing);
    const report = assembleReport(APP, makeDraft({ title: 9 }), signals);
    expect(report.dimensions.find(d => d.id === 'title')!.score).toBe(0);
  });

  it('subtitle (observable): model score 9 snaps to 10', () => {
    const listing = makeListing({ subtitle: 'EV Companion' }); // base has crawler=true
    const signals = computeSignals(listing);
    const report = assembleReport(APP, makeDraft({ subtitle: 9 }), signals);
    expect(report.dimensions.find(d => d.id === 'subtitle')!.score).toBe(10);
  });

  it('subtitle (observable): model score 4 snaps to 5', () => {
    const listing = makeListing({ subtitle: 'EV Companion' });
    const signals = computeSignals(listing);
    const report = assembleReport(APP, makeDraft({ subtitle: 4 }), signals);
    expect(report.dimensions.find(d => d.id === 'subtitle')!.score).toBe(5);
  });
});

// ── Section 2: dimension hash isolation ──────────────────────────────────────

describe('dimension hash isolation — only affected dimensions change', () => {
  it('changing title: title + keywordField hashes change, 8 others unchanged', () => {
    const base = makeListing({ name: 'Rivian' });
    const changed = makeListing({ name: 'Rivian: EV Owner App' });
    const bh = allDimensionHashes(base, computeSignals(base));
    const ch = allDimensionHashes(changed, computeSignals(changed));

    expect(ch.title).not.toBe(bh.title);
    expect(ch.keywordField).not.toBe(bh.keywordField); // keywordField depends on name

    for (const id of ['subtitle', 'description', 'screenshots', 'previewVideo', 'ratings', 'icon', 'conversion', 'competitive'] as const) {
      expect(ch[id]).toBe(bh[id]);
    }
  });

  it('changing subtitle: subtitle + keywordField hashes change, 8 others unchanged', () => {
    const base = makeListing({ subtitle: 'EV Companion' });
    const changed = makeListing({ subtitle: 'EV Charging & Control' });
    const bh = allDimensionHashes(base, computeSignals(base));
    const ch = allDimensionHashes(changed, computeSignals(changed));

    expect(ch.subtitle).not.toBe(bh.subtitle);
    expect(ch.keywordField).not.toBe(bh.keywordField); // keywordField depends on subtitle too

    for (const id of ['title', 'description', 'screenshots', 'previewVideo', 'ratings', 'icon', 'conversion', 'competitive'] as const) {
      expect(ch[id]).toBe(bh[id]);
    }
  });

  it('changing description: only description hash changes', () => {
    const base = makeListing({ description: 'The Rivian app.' });
    const changed = makeListing({ description: 'The Rivian app. Now with charging updates.' });
    const bh = allDimensionHashes(base, computeSignals(base));
    const ch = allDimensionHashes(changed, computeSignals(changed));

    expect(ch.description).not.toBe(bh.description);

    for (const id of ['title', 'subtitle', 'keywordField', 'screenshots', 'previewVideo', 'ratings', 'icon', 'conversion', 'competitive'] as const) {
      expect(ch[id]).toBe(bh[id]);
    }
  });

  it('adding a screenshot: only screenshots hash changes', () => {
    const base = makeListing({ screenshotUrls: ['s1', 's2', 's3', 's4', 's5', 's6'] });
    const changed = makeListing({ screenshotUrls: ['s1', 's2', 's3', 's4', 's5', 's6', 's7'] });
    const bh = allDimensionHashes(base, computeSignals(base));
    const ch = allDimensionHashes(changed, computeSignals(changed));

    expect(ch.screenshots).not.toBe(bh.screenshots);

    for (const id of ['title', 'subtitle', 'keywordField', 'description', 'previewVideo', 'ratings', 'icon', 'conversion', 'competitive'] as const) {
      expect(ch[id]).toBe(bh[id]);
    }
  });

  it('adding preview video: only previewVideo hash changes', () => {
    const base = makeListing({ hasPreviewVideo: false });
    const changed = makeListing({ hasPreviewVideo: true });
    const bh = allDimensionHashes(base, computeSignals(base));
    const ch = allDimensionHashes(changed, computeSignals(changed));

    expect(ch.previewVideo).not.toBe(bh.previewVideo);

    for (const id of ['title', 'subtitle', 'keywordField', 'description', 'screenshots', 'ratings', 'icon', 'conversion', 'competitive'] as const) {
      expect(ch[id]).toBe(bh[id]);
    }
  });

  it('changing average rating: only ratings hash changes', () => {
    const base = makeListing({ averageRating: 4.5 });
    const changed = makeListing({ averageRating: 4.1 });
    const bh = allDimensionHashes(base, computeSignals(base));
    const ch = allDimensionHashes(changed, computeSignals(changed));

    expect(ch.ratings).not.toBe(bh.ratings);

    for (const id of ['title', 'subtitle', 'keywordField', 'description', 'screenshots', 'previewVideo', 'icon', 'conversion', 'competitive'] as const) {
      expect(ch[id]).toBe(bh[id]);
    }
  });

  it('changing icon URL: only icon hash changes', () => {
    const base = makeListing({ iconUrl: 'https://example.com/icon-old.png' });
    const changed = makeListing({ iconUrl: 'https://example.com/icon-new.png' });
    const bh = allDimensionHashes(base, computeSignals(base));
    const ch = allDimensionHashes(changed, computeSignals(changed));

    expect(ch.icon).not.toBe(bh.icon);

    for (const id of ['title', 'subtitle', 'keywordField', 'description', 'screenshots', 'previewVideo', 'ratings', 'conversion', 'competitive'] as const) {
      expect(ch[id]).toBe(bh[id]);
    }
  });

  it('adding promotional text: only conversion hash changes', () => {
    const base = makeListing({ promotionalText: null });
    const changed = makeListing({ promotionalText: 'Summer sale — try free!' });
    const bh = allDimensionHashes(base, computeSignals(base));
    const ch = allDimensionHashes(changed, computeSignals(changed));

    expect(ch.conversion).not.toBe(bh.conversion);

    for (const id of ['title', 'subtitle', 'keywordField', 'description', 'screenshots', 'previewVideo', 'ratings', 'icon', 'competitive'] as const) {
      expect(ch[id]).toBe(bh[id]);
    }
  });

  it('adding a competitor: only competitive hash changes', () => {
    const base = makeListing({ competitors: [] });
    const changed = makeListing({
      competitors: [{
        appId: '789', name: 'Lucid', developer: 'Lucid Motors',
        primaryGenre: 'Automotive', averageRating: 4.6, ratingCount: 3000,
        formattedPrice: 'Free', screenshotCount: 8, hasPreviewVideo: false,
      }],
    });
    const bh = allDimensionHashes(base, computeSignals(base));
    const ch = allDimensionHashes(changed, computeSignals(changed));

    expect(ch.competitive).not.toBe(bh.competitive);

    for (const id of ['title', 'subtitle', 'keywordField', 'description', 'screenshots', 'previewVideo', 'ratings', 'icon', 'conversion'] as const) {
      expect(ch[id]).toBe(bh[id]);
    }
  });
});

// ── Section 3: per-dimension reuse simulation ─────────────────────────────────

describe('per-dimension reuse — single-field edit moves only that dimension', () => {
  it('title change: title gets fresh model score, all others stay cached', () => {
    const listingV1 = makeListing({ name: 'Rivian' });
    const signalsV1 = computeSignals(listingV1);
    const reportV1 = assembleReport(APP, makeDraft({}, 7), signalsV1);

    const listingV2 = makeListing({ name: 'Rivian: EV Owner App' });
    const signalsV2 = computeSignals(listingV2);
    // Fresh model draft: title=4, keywordField=5, everything else=3
    const freshDraft = makeDraft({ title: 4, keywordField: 5 }, 3);

    const mergedDraft = applyPerDimensionReuse(freshDraft, listingV2, signalsV2, listingV1, reportV1.dimensions);
    const mergedReport = assembleReport(APP, mergedDraft, signalsV2);

    // title fresh model=4 → coarseOrdinal(4) = 5
    expect(mergedReport.dimensions.find(d => d.id === 'title')!.score).toBe(5);
    // keywordField fresh model=5 → no coarseOrdinal → 5
    expect(mergedReport.dimensions.find(d => d.id === 'keywordField')!.score).toBe(5);

    // Unchanged dimensions: cached V1 scores (model=7, no coarseOrdinal for these)
    for (const id of ['description', 'icon', 'conversion'] as const) {
      expect(mergedReport.dimensions.find(d => d.id === id)!.score).toBe(7);
    }
    // competitive cached model=7 → coarseOrdinal(7) = 5 (snapped to ordinal)
    expect(mergedReport.dimensions.find(d => d.id === 'competitive')!.score).toBe(5);
    // ratings is code-scored (4.5★ → 9), independent of model/cache
    expect(mergedReport.dimensions.find(d => d.id === 'ratings')!.score).toBe(9);
  });

  it('subtitle change: subtitle + keywordField get fresh scores, rest cached', () => {
    const listingV1 = makeListing({ subtitle: 'EV Companion' });
    const signalsV1 = computeSignals(listingV1);
    const reportV1 = assembleReport(APP, makeDraft({}, 7), signalsV1);

    const listingV2 = makeListing({ subtitle: 'EV Charging & Control' });
    const signalsV2 = computeSignals(listingV2);
    const freshDraft = makeDraft({ subtitle: 2, keywordField: 6 }, 1);

    const mergedDraft = applyPerDimensionReuse(freshDraft, listingV2, signalsV2, listingV1, reportV1.dimensions);
    const mergedReport = assembleReport(APP, mergedDraft, signalsV2);

    // subtitle fresh model=2 → coarseOrdinal(2) = 0
    expect(mergedReport.dimensions.find(d => d.id === 'subtitle')!.score).toBe(0);
    // keywordField fresh model=6 → no coarseOrdinal → 6
    expect(mergedReport.dimensions.find(d => d.id === 'keywordField')!.score).toBe(6);

    // title cached from V1: Rivian = 6/30 = 20% utilization → floor → 0
    expect(mergedReport.dimensions.find(d => d.id === 'title')!.score).toBe(0);
    // description/icon/conversion: cached model=7, no coarseOrdinal → 7
    for (const id of ['description', 'icon', 'conversion'] as const) {
      expect(mergedReport.dimensions.find(d => d.id === id)!.score).toBe(7);
    }
    // competitive cached model=7 → coarseOrdinal(7) = 5 (snapped to ordinal)
    expect(mergedReport.dimensions.find(d => d.id === 'competitive')!.score).toBe(5);
    // ratings is code-scored (4.5★ → 9)
    expect(mergedReport.dimensions.find(d => d.id === 'ratings')!.score).toBe(9);
  });

  it('screenshot count change: screenshots gets code score (10), rest cached', () => {
    const listingV1 = makeListing({ screenshotUrls: ['s1', 's2', 's3', 's4', 's5', 's6'] });
    const signalsV1 = computeSignals(listingV1);
    const reportV1 = assembleReport(APP, makeDraft({}, 7), signalsV1);
    // V1 screenshots score = 6 (slotsUsedOf10=6, code-scored)

    const listingV2 = makeListing({
      screenshotUrls: ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10'],
    });
    const signalsV2 = computeSignals(listingV2);
    const freshDraft = makeDraft({ screenshots: 3 }, 1); // model says 3, code wins

    const mergedDraft = applyPerDimensionReuse(freshDraft, listingV2, signalsV2, listingV1, reportV1.dimensions);
    const mergedReport = assembleReport(APP, mergedDraft, signalsV2);

    // screenshots changed → fresh, but code overrides model's 3 → score = 10
    expect(mergedReport.dimensions.find(d => d.id === 'screenshots')!.score).toBe(10);

    // title cached from V1: Rivian = 6/30 = 20% utilization → floor → 0
    expect(mergedReport.dimensions.find(d => d.id === 'title')!.score).toBe(0);
    // description cached: model=7, no coarseOrdinal → 7
    expect(mergedReport.dimensions.find(d => d.id === 'description')!.score).toBe(7);
  });

  it('preview video added: previewVideo gets code score 8, rest cached', () => {
    const listingV1 = makeListing({ hasPreviewVideo: false });
    const signalsV1 = computeSignals(listingV1);
    const reportV1 = assembleReport(APP, makeDraft({ previewVideo: 0 }, 7), signalsV1);
    // V1 previewVideo score = 0 (absent, code-scored)

    const listingV2 = makeListing({ hasPreviewVideo: true });
    const signalsV2 = computeSignals(listingV2);
    const freshDraft = makeDraft({ previewVideo: 6 }, 1); // model says 6, code gives 8

    const mergedDraft = applyPerDimensionReuse(freshDraft, listingV2, signalsV2, listingV1, reportV1.dimensions);
    const mergedReport = assembleReport(APP, mergedDraft, signalsV2);

    // previewVideo changed → fresh, code overrides model's 6 → score = 8
    expect(mergedReport.dimensions.find(d => d.id === 'previewVideo')!.score).toBe(8);

    // icon unchanged → cached 7; ratings is code-scored (4.5★ → 9)
    expect(mergedReport.dimensions.find(d => d.id === 'ratings')!.score).toBe(9);
    expect(mergedReport.dimensions.find(d => d.id === 'icon')!.score).toBe(7);
  });

  it('description change: only description gets fresh score', () => {
    const listingV1 = makeListing({ description: 'Short description.' });
    const signalsV1 = computeSignals(listingV1);
    const reportV1 = assembleReport(APP, makeDraft({}, 7), signalsV1);

    const listingV2 = makeListing({ description: 'A much longer and more detailed description about the app.' });
    const signalsV2 = computeSignals(listingV2);
    const freshDraft = makeDraft({ description: 9 }, 1);

    const mergedDraft = applyPerDimensionReuse(freshDraft, listingV2, signalsV2, listingV1, reportV1.dimensions);
    const mergedReport = assembleReport(APP, mergedDraft, signalsV2);

    expect(mergedReport.dimensions.find(d => d.id === 'description')!.score).toBe(9);
    // title cached from V1: Rivian = 6/30 = 20% utilization → floor → 0
    expect(mergedReport.dimensions.find(d => d.id === 'title')!.score).toBe(0);
    expect(mergedReport.dimensions.find(d => d.id === 'ratings')!.score).toBe(9); // code-scored
  });

  it('no changes at all: every dimension uses cached score, fresh model ignored', () => {
    const listing = makeListing();
    const signals = computeSignals(listing);
    const reportV1 = assembleReport(APP, makeDraft({}, 7), signals);

    // Same listing, fresh model gives completely different scores
    const freshDraft = makeDraft({}, 2);
    const mergedDraft = applyPerDimensionReuse(freshDraft, listing, signals, listing, reportV1.dimensions);
    const mergedReport = assembleReport(APP, mergedDraft, signals);

    // title cached from V1: Rivian = 6/30 = 20% utilization → floor → 0
    expect(mergedReport.dimensions.find(d => d.id === 'title')!.score).toBe(0);
    expect(mergedReport.dimensions.find(d => d.id === 'description')!.score).toBe(7);
    // ratings/screenshots are code-scored from signals (not cached model output)
    expect(mergedReport.dimensions.find(d => d.id === 'ratings')!.score).toBe(9);
    // screenshots: code-scored from signals (6 slots)
    expect(mergedReport.dimensions.find(d => d.id === 'screenshots')!.score).toBe(6);
  });
});
