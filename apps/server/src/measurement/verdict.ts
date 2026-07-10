import type { ReportRow } from '../asc/types';
import type { VerdictJson, VerdictMetrics } from './types';

const DISCLAIMER =
  'Directional only — not causal. Metadata reindex ~4 weeks; competitor and algorithm shifts are not controlled for.';

function sum(rows: ReportRow[], pick: (r: ReportRow) => number): number {
  return rows.reduce((acc, r) => acc + pick(r), 0);
}

function avg(rows: ReportRow[], pick: (r: ReportRow) => number): number {
  if (rows.length === 0) return 0;
  return sum(rows, pick) / rows.length;
}

function metric(before: number, after: number): VerdictMetrics {
  const deltaPercent = before === 0 ? 0 : ((after - before) / before) * 100;
  return { before, after, deltaPercent };
}

export function computeVerdict(
  baseline: ReportRow[],
  after: ReportRow[],
  mixedAuthorship = false,
): VerdictJson {
  return {
    regime: 'correlational',
    windowDays: 28,
    metrics: {
      impressions: metric(
        sum(baseline, (r) => r.impressions),
        sum(after, (r) => r.impressions),
      ),
      downloads: metric(
        sum(baseline, (r) => r.downloads),
        sum(after, (r) => r.downloads),
      ),
      conversionRate: metric(
        avg(baseline, (r) => r.conversionRate),
        avg(after, (r) => r.conversionRate),
      ),
    },
    mixedAuthorship,
    disclaimer: DISCLAIMER,
  };
}
