import type { AuditReport, DimensionId, ScoredDimension } from '../domain/audit';
import { rubricFor } from './rubric';

/**
 * Rubric-weight replay (spec P1 "Snapshot store + rubric replay").
 *
 * Given a stored report's per-dimension scores, recompute the overall 0-100
 * with a *different* weight column — exactly, instantly, and with **zero LLM
 * calls** (the model's judgement, the per-dimension scores, is already frozen
 * in the snapshot; only the deterministic weighting changes). This is the
 * "how would the score have moved if we retuned a weight?" answer.
 *
 * Re-*judging* an old listing with today's model is a different, LLM-bearing
 * action and is deliberately NOT this function.
 */

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const round1 = (n: number): number => Math.round(n * 10) / 10;

export type WeightFn = (id: DimensionId) => number;

/** The default weight column — the live RUBRIC. */
export const defaultWeightFn: WeightFn = (id) => rubricFor(id).weight;

/**
 * Recompute the overall score from frozen dimension scores under `weightFor`.
 * Mirrors `assembleReport`'s normalisation exactly: only assessable dimensions
 * (`confidence !== 'unavailable'`) count, and the total is Σ(score·weight)/Σweight.
 */
export function replayOverallScore(
  dimensions: readonly ScoredDimension[],
  weightFor: WeightFn = defaultWeightFn,
): number {
  const assessableWeight = dimensions
    .filter((d) => d.confidence !== 'unavailable')
    .reduce((sum, d) => sum + weightFor(d.id), 0);
  if (assessableWeight <= 0) return 0;

  const total = dimensions.reduce((sum, d) => {
    if (d.confidence === 'unavailable') return sum;
    const score = clamp(d.score, 0, 10);
    return sum + round1((score / 10) * (weightFor(d.id) / assessableWeight) * 100);
  }, 0);
  return clamp(Math.round(total), 0, 100);
}

/** Replay over a whole stored report. Pure — never calls the model. */
export function replayReportScore(
  report: AuditReport,
  weightFor: WeightFn = defaultWeightFn,
): number {
  return replayOverallScore(report.dimensions, weightFor);
}
