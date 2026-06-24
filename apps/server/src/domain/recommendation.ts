import { z } from 'zod';

/**
 * The recommendation ledger's domain model (Build Appendix §A `aso_recommendations`,
 * §C dedup, §D evidence). These are the *domain* types that cross the
 * `StorageClient` seam — no SQL, no vendor schema — so the LibSQL↔Postgres swap
 * stays a config change.
 */

/**
 * The fixed intent taxonomy (spec §C). A closed enum: belief-accumulation
 * counts against it, and it is one of the four components of `rec_key`.
 */
export const INTENT_TAGS = [
  'add_keyword',
  'remove_wasted_term',
  'rebalance_title_subtitle',
  'reposition_identity',
  'improve_icon_legibility',
  'reorder_screenshots',
  'add_preview_video',
  'localise_storefront',
  'respond_to_reviews',
  'fix_complaint_theme',
  'improve_description_hook',
  'enable_promo_text',
] as const;
export const IntentTagSchema = z.enum(INTENT_TAGS);
export type IntentTag = z.infer<typeof IntentTagSchema>;

/**
 * Intents that name a *single* opportunity per listing — there is only ever
 * one "add a preview video" suggestion — so their `value_key` is empty (spec
 * §C). Every other intent is multi-instance and must carry a discriminating
 * `value_key` or two distinct suggestions would collide on one `rec_key`.
 */
export const SINGLE_INSTANCE_INTENTS: ReadonlySet<IntentTag> = new Set<IntentTag>([
  'add_preview_video',
  'enable_promo_text',
  'rebalance_title_subtitle',
  'reposition_identity',
  'improve_icon_legibility',
]);

/** The canonical complaint-theme taxonomy (spec §C) — `value_key` for `fix_complaint_theme`. */
export const COMPLAINT_THEMES = [
  'crash_stability',
  'login_auth',
  'pricing_subscription',
  'ads_intrusive',
  'performance_speed',
  'battery_resource',
  'data_loss_sync',
  'ui_ux_confusion',
  'onboarding',
  'notifications',
  'privacy_permissions',
  'customer_support',
  'device_compat',
  'content_quality',
  'other',
] as const;
export const ComplaintThemeSchema = z.enum(COMPLAINT_THEMES);
export type ComplaintTheme = z.infer<typeof ComplaintThemeSchema>;

/** A recommendation's lifecycle status (spec §A). */
export const RecStatusSchema = z.enum([
  'proposed',
  'applied',
  'dismissed',
  'superseded',
]);
export type RecStatus = z.infer<typeof RecStatusSchema>;

/**
 * Which proof regime a recommendation's effect can ever be measured under
 * (the "connect-to-measure honesty" map). Observable-now is the only one
 * available in beta; the rest name what a later phase unlocks.
 */
export const ProofRegimeSchema = z.enum([
  'ppo_causal', // a PPO A/B test (visual changes) — North Star
  'funnel_asc', // App Store Connect funnel — P7
  'correlational', // public keyword-rank / rating drift — available now, directional
  'observable_now', // directly visible in the next public listing snapshot
]);
export type ProofRegime = z.infer<typeof ProofRegimeSchema>;

/**
 * The clickable evidence chip (spec §D). Every claim carries ≥1, frozen into
 * the snapshot, so a chip resolves deterministically into *that date's* source
 * data. `unavailable` is a first-class value, never an empty string.
 */
export const EvidenceRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('signal'), signalId: z.string(), snapshotId: z.string() }),
  z.object({ kind: z.literal('listing_field'), field: z.string(), snapshotId: z.string() }),
  z.object({ kind: z.literal('review'), reviewId: z.string(), snapshotId: z.string() }),
  z.object({ kind: z.literal('competitor'), competitorAppId: z.string(), field: z.string() }),
  z.object({
    kind: z.literal('unavailable'),
    reason: z.enum(['not_observed', 'capped', 'script_unsupported']),
  }),
]);
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

/**
 * One row of the suggestion ledger. Mirrors `aso_recommendations` (§A) in
 * domain terms, and is the `Recommendation` named in the §B `StorageClient`
 * contract — renamed here to `LedgerRecommendation` only to avoid colliding
 * with the report-facing `Recommendation` in `domain/audit.ts`, which is a
 * different (user-facing, un-persisted) concept. `recKey` is computed (see
 * `memory/dedup.ts`), not free text.
 */
export const LedgerRecommendationSchema = z.object({
  id: z.string(),
  appId: z.string(),
  country: z.string(),
  recKey: z.string(),
  /** Normalized candidate; '' for single-instance intents (spec §C). */
  valueKey: z.string(),
  /** Complaint-theme taxonomy version (fix_complaint_theme only); traceability, NOT in rec_key. */
  taxonomyVersion: z.string().nullable(),
  dimension: z.string(),
  intent: IntentTagSchema,
  targetField: z.string().nullable(),
  title: z.string(),
  body: z.string(),
  beforeText: z.string().nullable(),
  afterText: z.string().nullable(),
  evidence: z.array(EvidenceRefSchema),
  status: RecStatusSchema,
  supersededBy: z.string().nullable(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  appliedAt: z.string().nullable(),
  proofRegime: ProofRegimeSchema,
});
export type LedgerRecommendation = z.infer<typeof LedgerRecommendationSchema>;
