import { describe, it, expect } from 'vitest';
import {
  DIMENSION_IDS,
  type AuditDraft,
  type Confidence,
  type DimensionId,
  type Recommendation,
} from '../domain/audit';
import type { AppSummary } from '../domain/listing';
import { assembleReport } from './aggregate';

const APP: AppSummary = {
  appId: '1',
  country: 'us',
  url: 'https://apps.apple.com/us/app/id1',
  name: 'Test App',
  developer: 'Test Dev',
  iconUrl: null,
  primaryGenre: 'Productivity',
  averageRating: 4.5,
  ratingCount: 1000,
};

function dimension(id: DimensionId, score: number, confidence: Confidence = 'observed') {
  return { id, score, confidence, findings: 'finding', evidence: ['evidence'] };
}

function rec(category: Recommendation['category']): Recommendation {
  return {
    category,
    dimension: 'title',
    intent: 'rebalance_title_subtitle',
    referent: { kind: 'none' },
    title: 't',
    rationale: 'r',
    evidence: 'e',
    before: null,
    after: null,
  };
}

function makeDraft(overrides: Partial<AuditDraft> = {}): AuditDraft {
  return {
    headline: 'A solid listing with room to grow.',
    dimensions: DIMENSION_IDS.map((id) => dimension(id, 10)),
    recommendations: [],
    competitorComparison: { summary: 'summary', rows: [] },
    limitations: [],
    ...overrides,
  };
}

describe('assembleReport — overall score', () => {
  it('normalises a perfect audit to 100', () => {
    const report = assembleReport(APP, makeDraft());
    expect(report.overallScore).toBe(100);
  });

  it('normalises a uniform 5/10 audit to 50', () => {
    const draft = makeDraft({
      dimensions: DIMENSION_IDS.map((id) => dimension(id, 5)),
    });
    expect(assembleReport(APP, draft).overallScore).toBe(50);
  });

  it('weightedPoints sum to the overall score', () => {
    const draft = makeDraft({
      dimensions: DIMENSION_IDS.map((id, i) => dimension(id, i)),
    });
    const report = assembleReport(APP, draft);
    const sum = report.dimensions.reduce((s, d) => s + d.weightedPoints, 0);
    expect(Math.round(sum)).toBe(report.overallScore);
  });
});

describe('assembleReport — unavailable dimensions', () => {
  it('excludes an unavailable dimension from the weighted total', () => {
    // Subtitle unavailable, every other dimension perfect → still 100.
    const draft = makeDraft({
      dimensions: DIMENSION_IDS.map((id) =>
        id === 'subtitle'
          ? dimension(id, 0, 'unavailable')
          : dimension(id, 10),
      ),
    });
    const report = assembleReport(APP, draft);
    expect(report.overallScore).toBe(100);
    const subtitle = report.dimensions.find((d) => d.id === 'subtitle');
    expect(subtitle?.weightedPoints).toBe(0);
  });
});

describe('assembleReport — missing dimensions', () => {
  it('synthesises any dimension the agent omitted as unavailable', () => {
    const draft = makeDraft({
      dimensions: DIMENSION_IDS.filter((id) => id !== 'icon').map((id) =>
        dimension(id, 8),
      ),
    });
    const report = assembleReport(APP, draft);
    expect(report.dimensions).toHaveLength(10);
    const icon = report.dimensions.find((d) => d.id === 'icon');
    expect(icon?.confidence).toBe('unavailable');
  });
});

describe('assembleReport — recommendation grouping', () => {
  it('splits recommendations into the three categories', () => {
    const draft = makeDraft({
      recommendations: [
        rec('quick-win'),
        rec('quick-win'),
        rec('high-impact'),
        rec('strategic'),
      ],
    });
    const report = assembleReport(APP, draft);
    expect(report.quickWins).toHaveLength(2);
    expect(report.highImpact).toHaveLength(1);
    expect(report.strategic).toHaveLength(1);
  });
});

describe('assembleReport — dimension metadata', () => {
  it('attaches the rubric label and weight to each dimension', () => {
    const report = assembleReport(APP, makeDraft());
    const title = report.dimensions.find((d) => d.id === 'title');
    expect(title?.label).toBe('Title');
    expect(title?.weight).toBe(20);
  });

  it('keeps dimensions in canonical score-card order', () => {
    const report = assembleReport(APP, makeDraft());
    expect(report.dimensions.map((d) => d.id)).toEqual([...DIMENSION_IDS]);
  });
});
