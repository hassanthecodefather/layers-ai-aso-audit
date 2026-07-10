import { z } from 'zod';
import {
  type ConfidenceBand,
  type Divergence,
  type SignalTallyEntry,
  SignalTallyEntrySchema,
  ConfidenceBandSchema,
  DivergenceSchema,
  IdentitySourceSchema,
  SOURCE_TIER_WEIGHT,
  ON_STORE_TIERS,
  OverrodeEvidenceSchema,
} from '../domain/identity';
import type { RawIdentitySignals } from './signals';
import { divergenceBetween } from './domains';
import type { WebSearchProbe } from '../sources/websearch/websearch';

/**
 * The function-grounded interpretation of the signals — what the app actually
 * *does*, as opposed to its declared store category. Produced by the model
 * from the identity fact sheet (spec ID "Fed to the model as an authoritative
 * identity fact sheet"); injected as a stub in tests so the band logic below
 * is exercised deterministically.
 */
/** The 27 real Apple App Store primary categories (App Store Connect). */
export const APP_STORE_CATEGORIES = [
  'Books', 'Business', 'Developer Tools', 'Education', 'Entertainment',
  'Finance', 'Food & Drink', 'Games', 'Graphics & Design', 'Health & Fitness',
  'Lifestyle', 'Magazines & Newspapers', 'Medical', 'Music',
  'Navigation', 'News', 'Photo & Video', 'Productivity', 'Reference',
  'Shopping', 'Social Networking', 'Sports', 'Travel',
  'Utilities', 'Weather',
] as const;
export type AppStoreCategory = typeof APP_STORE_CATEGORIES[number];

export interface IdentityClassification {
  /** The function-derived category string (e.g. "Electric vehicle companion"). */
  functionCategory: string;
  /** The specific niche, or null if not resolvable without vision (ID-full). */
  functionNiche: string | null;
  /** Vocabulary that, if present in reviews, corroborates the function. */
  functionTerms: string[];
  /** The best-fit real Apple App Store primary category for this app's function. */
  suggestedCategory?: AppStoreCategory | null;
}

/**
 * The resolved identity, before it is stamped into an `IdentityVersion` row.
 * A zod schema (not just a type) so it can serialise as a workflow step output
 * across a `suspend()` boundary.
 */
export const ResolvedIdentitySchema = z.object({
  category: z.string(),
  categoryBand: ConfidenceBandSchema,
  niche: z.string().nullable(),
  nicheBand: ConfidenceBandSchema.nullable(),
  divergence: DivergenceSchema,
  /** Did the hard gate fire? (low/conflict → ask a human.) */
  escalate: z.boolean(),
  tally: z.array(SignalTallyEntrySchema),
  /** `resolved` by the agent, or `human_confirmed` — the sticky override tier. */
  source: IdentitySourceSchema.default('resolved'),
  /** The classifier's function vocabulary — used for structured competitor seeds. */
  functionTerms: z.array(z.string()).default([]),
  /** Best-fit real Apple App Store primary category for the app's function. */
  suggestedCategory: z.string().nullable().optional(),
  /** Set only on a contested human override (see OverrodeEvidenceSchema). */
  overrodeEvidence: OverrodeEvidenceSchema.nullable().default(null),
});
export type ResolvedIdentity = z.infer<typeof ResolvedIdentitySchema>;

export interface ResolveOptions {
  /** Below this many reviews, the review-vocabulary family doesn't vote. */
  minReviewSample?: number;
  /** When the signals were observed — the freshness reuse reads through to. */
  fetchedAt?: string;
  /**
   * Off-store footprint probe result from the web-search tier (spec ID §E).
   * `corroborated` adds a `fetched_and_cited` tally entry (weight=2, agrees=true).
   * `searched_and_empty` adds an entry with agrees=false — excluded from S and distinct,
   *   so it contributes nothing to the band score (arithmetically neutral, not a deduction).
   * `errored` is silently ignored — a tool error is not an identity signal.
   */
  footprintProbe?: WebSearchProbe;
}

/** Loose brand match: shared substring of ≥3 chars (rivian ↔ rivian.com). */
function brandMatch(a: string | null, b: string | null): boolean {
  if (!a || !b || a.length < 3 || b.length < 3) return false;
  return a.includes(b) || b.includes(a);
}

/**
 * Resolve identity from the deterministic signals + the model's function
 * classification, into a two-axis band with a citable tally (spec §E).
 *
 * The tally is a *weighted* count of agreeing signal families; the band is a
 * pure function of (S, distinct families, tier-2 presence, the on-store cap,
 * and the store-vs-function divergence). Conflict yields low, never an average.
 */
export function resolveIdentity(
  signals: RawIdentitySignals,
  classification: IdentityClassification,
  opts: ResolveOptions = {},
): ResolvedIdentity {
  const fetchedAt = opts.fetchedAt ?? '1970-01-01T00:00:00.000Z';
  const minReviewSample = opts.minReviewSample ?? 5;
  const tally: SignalTallyEntry[] = [];

  // developer — the strongest first-party on-store signal; it names the maker.
  tally.push({
    family: 'developer',
    value: signals.developer,
    sourceTier: 'observed_on_store',
    agrees: true,
    fetchedAt,
  });

  // bundle_id — reverse-DNS org corroborates only when it matches the
  // developer or the marketing domain (com.rivian.* + rivian.com). A vanity id
  // contributes nothing and says so.
  if (signals.bundleOrg) {
    const agrees =
      brandMatch(signals.bundleOrg, signals.developerSlug) ||
      brandMatch(signals.bundleOrg, signals.marketingDomain);
    tally.push({
      family: 'bundle_id',
      value: signals.bundleOrg,
      sourceTier: 'observed_on_store',
      agrees,
      fetchedAt,
    });
  }

  // marketing_domain — fetched-and-cited; corroborates when it matches the
  // bundle org or the developer.
  if (signals.marketingDomain) {
    const agrees =
      brandMatch(signals.marketingDomain, signals.bundleOrg) ||
      brandMatch(signals.marketingDomain, signals.developerSlug);
    tally.push({
      family: 'marketing_domain',
      value: signals.marketingDomain,
      sourceTier: 'fetched_and_cited',
      agrees,
      fetchedAt,
    });
  }

  // reviews — review-vocabulary; votes only above the min sample and only when
  // the users' own words corroborate the function ("precondition my truck").
  if (signals.reviewCount >= minReviewSample) {
    const hit = classification.functionTerms.some(
      (t) => t.length >= 3 && signals.reviewCorpus.includes(t.toLowerCase()),
    );
    tally.push({
      family: 'reviews',
      value: hit ? 'function vocabulary present' : 'no function vocabulary',
      sourceTier: 'review_inferred',
      agrees: hit,
      fetchedAt,
    });
  }

  // footprint — off-store web-search corroboration (spec ID §E "footprint family").
  // `corroborated` is an independent third-party signal (fetched_and_cited, weight=2).
  // `searched_and_empty` is an honest negative — agrees=false is excluded from S/distinct,
  // so it doesn't change the band score (neutral, not a deduction).
  // `errored` means the tool broke; we don't penalise for that.
  if (opts.footprintProbe && opts.footprintProbe.state !== 'errored') {
    const probe = opts.footprintProbe;
    tally.push({
      family: 'footprint',
      value:
        probe.state === 'corroborated'
          ? `Web search: ${probe.sources.length} off-store source${probe.sources.length === 1 ? '' : 's'}`
          : 'Web search: no off-store footprint found',
      sourceTier: 'fetched_and_cited',
      agrees: probe.state === 'corroborated',
      fetchedAt,
    });
  }

  const agreeing = tally.filter((t) => t.agrees);
  const S = agreeing.reduce((sum, t) => sum + SOURCE_TIER_WEIGHT[t.sourceTier], 0);
  const distinct = agreeing.length;
  const hasTier2 = agreeing.some((t) => SOURCE_TIER_WEIGHT[t.sourceTier] === 2);
  const onStoreOnly =
    agreeing.length > 0 && agreeing.every((t) => ON_STORE_TIERS.has(t.sourceTier));

  const divergence = divergenceBetween(
    signals.storeCategory,
    classification.functionCategory,
  );

  // Band (spec §E). Cross-domain conflict collapses to low regardless of S —
  // a confident-but-conflicting identity is exactly when we don't know.
  let categoryBand: ConfidenceBand;
  if (divergence === 'cross_domain') {
    categoryBand = 'low';
  } else if (S >= 4 && distinct >= 2 && hasTier2) {
    // The on-store cap applies *after* the tally: an app's own first-party
    // signals aren't independent corroboration, so cap at medium.
    categoryBand = onStoreOnly ? 'medium' : 'high';
  } else if (S >= 2) {
    categoryBand = 'medium';
  } else {
    categoryBand = 'low';
  }

  // Niche is inferred-only at ID-lite (no vision): present → medium, else low.
  const nicheBand: ConfidenceBand | null = classification.functionNiche
    ? 'medium'
    : 'low';

  // The hard gate (spec ID "Bands"): escalate when the category itself is low
  // (covers cross-domain conflict and S ≤ 1). A low niche under a high,
  // non-divergent category flags but does not escalate — niche is inferred-only
  // at ID-lite (no vision), so requiring human confirmation at this stage is
  // premature. Reserve niche-driven escalation for ID-full where niche is
  // vision-observable.
  const escalate = categoryBand === 'low';

  return {
    category: classification.functionCategory,
    categoryBand,
    niche: classification.functionNiche,
    nicheBand,
    divergence,
    escalate,
    tally,
    source: 'resolved',
    functionTerms: classification.functionTerms,
    suggestedCategory: classification.suggestedCategory ?? null,
    overrodeEvidence: null,
  };
}
