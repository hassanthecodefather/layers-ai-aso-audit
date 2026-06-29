import { z } from 'zod';
import { AppSummarySchema } from './listing';
import { IntentTagSchema, ReferentSchema } from './recommendation';

/**
 * The ten ASO dimensions. The order here is the order they render in the
 * score card. Weights and human labels live in `scoring/rubric.ts` — this is
 * just the closed set of identifiers everything keys off.
 */
export const DIMENSION_IDS = [
  'title',
  'subtitle',
  'keywordField',
  'description',
  'screenshots',
  'previewVideo',
  'ratings',
  'icon',
  'conversion',
  'competitive',
] as const;

export const DimensionIdSchema = z.enum(DIMENSION_IDS);
export type DimensionId = z.infer<typeof DimensionIdSchema>;

/**
 * How much trust to place in a dimension's score:
 *  - `observed`    — scored from data we actually fetched.
 *  - `inferred`    — the raw field isn't public (e.g. the iOS keyword field);
 *                    scored from adjacent evidence and flagged as such.
 *  - `unavailable` — couldn't be assessed; excluded from the weighted total.
 */
export const ConfidenceSchema = z.enum(['observed', 'inferred', 'unavailable']);
export type Confidence = z.infer<typeof ConfidenceSchema>;

/** A per-dimension judgement, as returned by the auditor agent. */
export const DimensionScoreSchema = z.object({
  id: DimensionIdSchema,
  score: z.number().min(0).max(10),
  confidence: ConfidenceSchema,
  findings: z.string().describe('One or two sentences explaining the score.'),
  evidence: z
    .array(z.string())
    .describe('Concrete data points from the listing that justify the score.'),
});
export type DimensionScore = z.infer<typeof DimensionScoreSchema>;

/**
 * A single recommendation. `before`/`after` are required for any text change
 * (the task is explicit: "rewrite the title from X to Y because Z") and null
 * for non-text changes like "add a preview video".
 *
 * `intent` is a closed enum the model picks from; `referent` is the typed
 * discriminator that pins the rec's identity for dedup — `value_key` is always
 * derived from `referent.value` in code, never from the model's prose.
 */
export const RecommendationSchema = z.object({
  category: z.enum(['quick-win', 'high-impact', 'strategic']),
  dimension: DimensionIdSchema,
  intent: IntentTagSchema,
  referent: ReferentSchema,
  title: z.string().describe('The change, stated as an imperative.'),
  rationale: z.string().describe('Why it matters, citing the evidence.'),
  evidence: z.string().describe('The specific data point that prompted this.'),
  before: z.string().nullable(),
  after: z.string().nullable(),
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

export const CompetitorRowSchema = z.object({
  name: z.string(),
  rating: z.string().describe('e.g. "4.7 (1.2M)" or "—" if unknown.'),
  positioning: z.string().describe('One phrase on how they position.'),
  edge: z.string().describe('What this competitor does better, or "—".'),
});
export type CompetitorRow = z.infer<typeof CompetitorRowSchema>;

/**
 * The raw audit, exactly as the LLM produces it. The agent scores and writes
 * prose; it does **not** compute the overall number — weighting and the
 * 0-100 total are arithmetic, done in code (`scoring/aggregate.ts`) so they
 * are deterministic and unit-tested.
 */
export const AuditDraftSchema = z.object({
  headline: z
    .string()
    .describe('A one-sentence verdict on the listing overall.'),
  dimensions: z
    .array(DimensionScoreSchema)
    .describe('Exactly one entry per dimension, all ten.'),
  recommendations: z
    .array(RecommendationSchema)
    .describe('9-15 recommendations spread across the three categories.'),
  competitorComparison: z.object({
    summary: z.string(),
    rows: z.array(CompetitorRowSchema),
  }),
  limitations: z
    .array(z.string())
    .describe('What could not be assessed from public data, and why.'),
});
export type AuditDraft = z.infer<typeof AuditDraftSchema>;

// ── The finished report (assembled in code from the draft) ─────────────────

/** A dimension after the rubric weight and weighted contribution are applied. */
export const ScoredDimensionSchema = DimensionScoreSchema.extend({
  label: z.string(),
  weight: z.number(),
  /** Points this dimension contributes to the 0-100 total. */
  weightedPoints: z.number(),
});
export type ScoredDimension = z.infer<typeof ScoredDimensionSchema>;

/**
 * The finished audit. Defined as a schema (not just a type) so the workflow
 * can declare it as its output and Mastra validates the boundary.
 */
export const AuditReportSchema = z.object({
  app: AppSummarySchema,
  generatedAt: z.string(),
  headline: z.string(),
  /** Overall ASO score, 0-100, normalised across assessable dimensions. */
  overallScore: z.number(),
  dimensions: z.array(ScoredDimensionSchema),
  quickWins: z.array(RecommendationSchema),
  highImpact: z.array(RecommendationSchema),
  strategic: z.array(RecommendationSchema),
  competitorComparison: AuditDraftSchema.shape.competitorComparison,
  limitations: z.array(z.string()),
});
export type AuditReport = z.infer<typeof AuditReportSchema>;
