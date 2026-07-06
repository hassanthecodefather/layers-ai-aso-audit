import {
  DIMENSION_IDS,
  type AuditDraft,
  type AuditReport,
  type DimensionId,
  type DimensionScore,
  type Recommendation,
  type ScoredDimension,
  type ThemeResult,
} from '../domain/audit';
import type { AppSummary, Review } from '../domain/listing';
import { rubricFor } from './rubric';
import type { ListingSignals } from './signals';
import { deriveConfidence, codeScore, coarseOrdinalScore } from './dimension-scorer';
import { replayOverallScore } from './replay';
import { assignProofRegime } from './proof-regime';
import type { VisionResult } from '../vision/types';
import type { ThemeAnalysisResult } from '../reviews/themes';

/**
 * Turn the LLM's `AuditDraft` into a finished `AuditReport`.
 *
 * This is the deliberate code/LLM split: the agent supplies per-dimension
 * scores (0-10) and prose; *this function* does every piece of arithmetic —
 * applying weights, normalising to 0-100, grouping recommendations. Pure and
 * unit-tested, so the headline number is never at the mercy of a model doing
 * mental math.
 *
 * Normalisation: only dimensions the agent could actually assess
 * (`confidence !== 'unavailable'`) count toward the total, and the score is
 * `Σ(score·weight) / Σ(weight)` over those. This handles both the task's
 * 110-point weight column and the case where Firecrawl is absent and three
 * dimensions drop out — the result is always a fair 0-100.
 */

const clamp = (n: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, n));

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function assembleReport(
  app: AppSummary,
  draft: AuditDraft,
  signals?: ListingSignals,
  visionResult?: VisionResult,
  themeResult?: ThemeAnalysisResult | null,
  reviews?: Review[],
): AuditReport {
  const byId = new Map<DimensionId, DimensionScore>();
  for (const d of draft.dimensions) byId.set(d.id, d);

  // Every dimension, in canonical (score-card) order — synthesising a
  // placeholder for any the agent omitted.
  const raw: DimensionScore[] = DIMENSION_IDS.map(
    (id) =>
      byId.get(id) ?? {
        id,
        score: 0,
        confidence: 'unavailable' as const,
        findings: 'Not assessed — the agent returned no score for this dimension.',
        evidence: [],
      },
  );

  // When signals are provided, override confidence and score with code-derived
  // values — these are deterministic and must not come from the model.
  if (signals) {
    for (const d of raw) {
      d.confidence = deriveConfidence(d.id, signals, visionResult);
      const coded = codeScore(d.id, signals, visionResult);
      if (coded !== null) {
        d.score = coded;
      } else {
        // For mixed dimensions (title/subtitle), quantize the model's free 0-10
        // to {0, 5, 10}, eliminating ±1-3 run-to-run score drift.
        const quantized = coarseOrdinalScore(d.id, d.score, signals);
        if (quantized !== null) d.score = quantized;
      }
    }
  }

  const assessableWeight = raw
    .filter((d) => d.confidence !== 'unavailable')
    .reduce((sum, d) => sum + rubricFor(d.id).weight, 0);

  const dimensions: ScoredDimension[] = raw.map((d) => {
    const rubric = rubricFor(d.id);
    const score = clamp(d.score, 0, 10);
    const counts = d.confidence !== 'unavailable' && assessableWeight > 0;
    const weightedPoints = counts
      ? round1((score / 10) * (rubric.weight / assessableWeight) * 100)
      : 0;
    return {
      ...d,
      score,
      label: rubric.label,
      weight: rubric.weight,
      weightedPoints,
    };
  });

  // Delegate to the canonical normalization in replay.ts — single definition of
  // the weighted-average formula used by both live assembly and rubric-weight replay.
  const overallScore = replayOverallScore(dimensions, (id) => rubricFor(id).weight);

  const inCategory = (c: Recommendation['category']): Recommendation[] =>
    draft.recommendations
      .filter((r) => r.category === c)
      .map((r) => ({ ...r, proofRegime: assignProofRegime(r.intent) }));

  // Build lookup map from review ID → { text, rating }
  const reviewById = new Map<string, { text: string; rating: number }>();
  for (const r of (reviews ?? [])) {
    if (r.id) reviewById.set(r.id, { text: r.body ?? '', rating: r.rating });
  }

  const sampleSize = themeResult?.sampleSize ?? 0;

  const themeResultWire: ThemeResult = themeResult
    ? {
        themes: [...themeResult.themes]
          .sort((a, b) => b.count - a.count)
          .map((t) => ({
            bucket: t.bucket,
            summary: t.summary,
            count: t.count,
            sharePct: sampleSize > 0 ? t.count / sampleSize : 0,
            exemplars: t.exemplarReviewIds
              .map((id) => reviewById.get(id))
              .filter((r): r is { text: string; rating: number } => r !== undefined),
            isUnresolved: t.isUnresolved,
          })),
        versionDelta: themeResult.versionDelta,
        featureRequests: themeResult.featureRequests,
        sampleSize,
        taxonomyVersion: themeResult.taxonomyVersion,
      }
    : null;

  return {
    app,
    generatedAt: new Date().toISOString(),
    headline: draft.headline,
    overallScore,
    dimensions,
    quickWins: inCategory('quick-win'),
    highImpact: inCategory('high-impact'),
    strategic: inCategory('strategic'),
    competitorComparison: draft.competitorComparison,
    limitations: draft.limitations,
    themeResult: themeResultWire,
  };
}
