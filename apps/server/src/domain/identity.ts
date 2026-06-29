import { z } from 'zod';

/**
 * Identity-resolution domain model (spec "ID · Identity Resolution", Build
 * Appendix §A `aso_identity_versions` + §E confidence tally → band). Types
 * only — the resolver logic (tally → band, divergence, escalation) lives in
 * `identity/resolve.ts`; this file is what crosses the `StorageClient` seam.
 */

/** A two-axis confidence band (spec §E). Never averaged across the two axes. */
export const ConfidenceBandSchema = z.enum(['high', 'medium', 'low']);
export type ConfidenceBand = z.infer<typeof ConfidenceBandSchema>;

/**
 * The independent signal families that vote on identity (spec ID / §E). Each
 * resolves to a citable source; weights differ by tier (see `SOURCE_TIER_WEIGHT`).
 */
export const SIGNAL_FAMILIES = [
  'developer', // the developer's name + their other apps
  'bundle_id', // reverse-DNS org segment (com.rivian.* → "rivian")
  'permissions', // permission / privacy labels, device capabilities
  'iap', // in-app-purchase names
  'marketing_domain', // the fetched, cited marketing/support page
  'cross_store', // a corroborating cross-store listing
  'reviews', // review vocabulary ("precondition my truck")
  'footprint', // off-store footprint (search / Wikipedia), cited
] as const;
export const SignalFamilySchema = z.enum(SIGNAL_FAMILIES);
export type SignalFamily = z.infer<typeof SignalFamilySchema>;

/**
 * The source tier of a signal, and its tally weight (spec §E):
 * observed-on-store = 2, fetched-and-cited = 2, cross-store = 1,
 * review-inferred = 1, world-knowledge = 0 (a prior; never counts alone).
 */
export const SOURCE_TIERS = [
  'observed_on_store',
  'fetched_and_cited',
  'cross_store',
  'review_inferred',
  'world_knowledge',
] as const;
export const SourceTierSchema = z.enum(SOURCE_TIERS);
export type SourceTier = z.infer<typeof SourceTierSchema>;

export const SOURCE_TIER_WEIGHT: Record<SourceTier, number> = {
  observed_on_store: 2,
  fetched_and_cited: 2,
  cross_store: 1,
  review_inferred: 1,
  world_knowledge: 0,
};

/** Tiers that are an app's own first-party, on-store signals (spec §E cap). */
export const ON_STORE_TIERS: ReadonlySet<SourceTier> = new Set<SourceTier>([
  'observed_on_store',
]);

/**
 * One signal family's contribution to the tally: what it said, how strongly it
 * counts (its tier), and when it was observed (the freshness the byte-identity
 * reuse check reads through to — spec ID "Reuse, don't recompute").
 */
export const SignalTallyEntrySchema = z.object({
  family: SignalFamilySchema,
  /** The citable value this family contributed (e.g. the matched domain). */
  value: z.string(),
  sourceTier: SourceTierSchema,
  /** Whether this family agrees with the resolved identity (counts toward S). */
  agrees: z.boolean(),
  fetchedAt: z.string(),
});
export type SignalTallyEntry = z.infer<typeof SignalTallyEntrySchema>;

/**
 * Ordinal divergence between the two citable category strings (spec ID
 * "Conflict yields low"): none (Games == Games), within-domain (a note, never
 * escalates), cross-domain (Travel vs vehicle — the only band that escalates).
 */
export const DivergenceSchema = z.enum(['none', 'within_domain', 'cross_domain']);
export type Divergence = z.infer<typeof DivergenceSchema>;

/** ID-lite (deterministic, no vision) vs ID-full (vision-grounded, P2). */
export const IdentityStageSchema = z.enum(['lite', 'full']);
export type IdentityStage = z.infer<typeof IdentityStageSchema>;

/** How the identity was set: resolved by the agent, or confirmed by a human. */
export const IdentitySourceSchema = z.enum(['resolved', 'human_confirmed']);
export type IdentitySource = z.infer<typeof IdentitySourceSchema>;

/**
 * One append-only identity version (spec §A `aso_identity_versions`). ID-lite
 * writes the first; ID-full augments later without rewriting ID-lite's
 * deterministic fields.
 */
export const IdentityVersionSchema = z.object({
  id: z.string(),
  appId: z.string(),
  country: z.string(),
  /** Monotonic per (appId, country). */
  version: z.number().int().nonnegative(),
  stage: IdentityStageSchema,
  category: z.string(),
  categoryBand: ConfidenceBandSchema,
  niche: z.string().nullable(),
  nicheBand: ConfidenceBandSchema.nullable(),
  /** ID-full only (audience segments + vocabulary); null at ID-lite. */
  audience: z.unknown().nullable(),
  tally: z.array(SignalTallyEntrySchema),
  /** The store-declared vs function-derived divergence that drove the band. */
  divergence: DivergenceSchema,
  /** Whether the gate fired (low/conflict → ask a human). */
  escalate: z.boolean(),
  source: IdentitySourceSchema,
  createdAt: z.string(),
});
export type IdentityVersion = z.infer<typeof IdentityVersionSchema>;
