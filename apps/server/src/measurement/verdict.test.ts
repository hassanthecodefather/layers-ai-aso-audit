import { describe, it, expect } from 'vitest';
import { computeVerdict } from './verdict';
import type { ReportRow } from '../asc/types';

function row(over: Partial<ReportRow>): ReportRow {
  return { date: '2026-06-01', impressions: 0, downloads: 0, conversionRate: 0, territory: 'US', ...over };
}

describe('computeVerdict', () => {
  it('computes deltaPercent correctly for all three metrics', () => {
    const baseline = [
      row({ impressions: 100, downloads: 10, conversionRate: 5 }),
      row({ impressions: 100, downloads: 10, conversionRate: 5 }),
    ];
    const after = [
      row({ impressions: 150, downloads: 12, conversionRate: 6 }),
      row({ impressions: 150, downloads: 12, conversionRate: 6 }),
    ];
    const v = computeVerdict(baseline, after);

    // impressions: before 200, after 300 → +50%
    expect(v.metrics.impressions.before).toBe(200);
    expect(v.metrics.impressions.after).toBe(300);
    expect(v.metrics.impressions.deltaPercent).toBeCloseTo(50, 5);

    // downloads: before 20, after 24 → +20%
    expect(v.metrics.downloads.before).toBe(20);
    expect(v.metrics.downloads.after).toBe(24);
    expect(v.metrics.downloads.deltaPercent).toBeCloseTo(20, 5);

    // conversionRate: avg before 5, avg after 6 → +20%
    expect(v.metrics.conversionRate.before).toBeCloseTo(5, 5);
    expect(v.metrics.conversionRate.after).toBeCloseTo(6, 5);
    expect(v.metrics.conversionRate.deltaPercent).toBeCloseTo(20, 5);

    expect(v.windowDays).toBe(28);
    expect(v.regime).toBe('correlational');
  });

  it('returns deltaPercent: 0 for all metrics when baseline is empty (zero-baseline guard)', () => {
    const after = [row({ impressions: 150, downloads: 12, conversionRate: 6 })];
    const v = computeVerdict([], after);
    expect(v.metrics.impressions.before).toBe(0);
    expect(v.metrics.impressions.deltaPercent).toBe(0);
    expect(v.metrics.downloads.deltaPercent).toBe(0);
    expect(v.metrics.conversionRate.deltaPercent).toBe(0);
  });

  it('mixedAuthorship flag defaults to false and passes through when true', () => {
    expect(computeVerdict([], []).mixedAuthorship).toBe(false);
    expect(computeVerdict([], [], true).mixedAuthorship).toBe(true);
  });

  it('disclaimer text matches spec exactly', () => {
    const v = computeVerdict([], []);
    expect(v.disclaimer).toBe(
      'Directional only — not causal. Metadata reindex ~4 weeks; competitor and algorithm shifts are not controlled for.',
    );
  });
});
