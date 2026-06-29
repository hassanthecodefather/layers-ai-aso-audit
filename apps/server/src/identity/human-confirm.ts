import { z } from 'zod';
import type { AppListing } from '../domain/listing';
import type { IdentityVersion } from '../domain/identity';
import { type ResolvedIdentity } from './resolve';
import { resolveAppIdentity, type IdentityClassifier } from '../mastra/tools/resolve-identity';
import { extractIdentitySignals, type RawIdentitySignals } from './signals';
import { domainOf } from './domains';

/**
 * The human-confirmed identity override (spec ID "Save the findings —
 * versioned, reused, human-overridable").
 *
 * A human override is the **highest-priority signal**: sticky, recorded as a
 * categorical `human_confirmed` tier (never a fake 100%), respected by every
 * future audit, and **re-asked only when the signals it rested on materially
 * change and the answer actually flips**. It steers *interpretation* — it can
 * legitimately point future audits a different way — but it never rewrites the
 * observation/measurement layers (those stay append-only elsewhere).
 */

/**
 * What the operator said at the widened confirm step: accept what we resolved,
 * correct the category/niche, or pick a different identity outright.
 */
export const IdentityDecisionSchema = z.object({
  action: z.enum(['confirm', 'correct', 'pick']),
  /** Operator-supplied category for `correct`/`pick`. */
  category: z.string().optional(),
  /** Operator-supplied niche for `correct`/`pick`. */
  niche: z.string().nullable().optional(),
});
export type IdentityDecision = z.infer<typeof IdentityDecisionSchema>;

/**
 * Apply a human decision to a resolved identity, producing a `human_confirmed`
 * identity: the operator's category/niche wins; `escalate` clears (the human
 * settled it); the band reads `high` but the real tier is `source`, which is
 * `human_confirmed` — above all resolved bands, and never a percentage.
 */
export function applyHumanDecision(
  resolved: ResolvedIdentity,
  decision: IdentityDecision,
): ResolvedIdentity {
  const category = decision.action === 'confirm' ? resolved.category : decision.category ?? resolved.category;
  const niche = decision.action === 'confirm' ? resolved.niche : decision.niche ?? resolved.niche;
  return {
    ...resolved,
    category,
    niche,
    categoryBand: 'high',
    nicheBand: niche ? 'high' : null,
    escalate: false,
    source: 'human_confirmed',
  };
}

/** Re-hydrate a stored identity version into a `ResolvedIdentity` for reuse. */
export function identityVersionToResolved(v: IdentityVersion): ResolvedIdentity {
  return {
    category: v.category,
    categoryBand: v.categoryBand,
    niche: v.niche,
    nicheBand: v.nicheBand,
    divergence: v.divergence,
    escalate: v.escalate,
    tally: v.tally,
    source: v.source,
  };
}

/** The key signals a human decision rests on — change here is "material". */
function keySignal(prior: IdentityVersion, family: string): string | undefined {
  return prior.tally.find((t) => t.family === family)?.value;
}

/**
 * Have the signals a prior human decision rested on materially changed? We
 * compare the load-bearing families (developer, bundle org, marketing domain).
 * A rebrand or a moved marketing site is material; a fresh review batch is not.
 */
export function signalsMateriallyChanged(
  prior: IdentityVersion,
  current: RawIdentitySignals,
): boolean {
  return (
    keySignal(prior, 'developer') !== current.developer ||
    keySignal(prior, 'bundle_id') !== (current.bundleOrg ?? undefined) ||
    keySignal(prior, 'marketing_domain') !== (current.marketingDomain ?? undefined)
  );
}

/**
 * Resolve identity for a listing, but **respect a prior human override**:
 *  - no prior human-confirmed identity → resolve fresh.
 *  - prior human-confirmed, signals unchanged → reuse verbatim (no re-ask).
 *  - prior human-confirmed, signals changed but the fresh answer stays in the
 *    same domain → keep the human's call (no flip → no re-ask).
 *  - prior human-confirmed, signals changed AND the fresh answer flips domain →
 *    escalate (re-ask the human).
 */
export async function resolveWithHistory(
  listing: AppListing,
  classify: IdentityClassifier,
  prior: IdentityVersion | null,
  opts: { fetchedAt?: string } = {},
): Promise<ResolvedIdentity> {
  if (!prior) {
    return resolveAppIdentity(listing, classify, opts);
  }

  const current = extractIdentitySignals(listing);

  // When the load-bearing signals (developer, bundle org, marketing domain)
  // are unchanged, re-resolving produces LLM drift rather than new information —
  // the same inputs will return the same classification ±noise. Reuse the prior
  // verbatim. This applies to both `lite` and `human_confirmed` sources and is
  // the key stabiliser for the prompt hash (and therefore the rec-set cache).
  if (!signalsMateriallyChanged(prior, current)) {
    return identityVersionToResolved(prior);
  }

  // Signals changed — re-resolve fresh.
  const fresh = await resolveAppIdentity(listing, classify, opts);

  if (prior.source !== 'human_confirmed') {
    return fresh;
  }

  // Human-confirmed: only re-ask when the domain actually flips (a rebrand
  // is material; a minor signal change that stays in the same domain is not).
  const flipped = domainOf(fresh.category) !== domainOf(prior.category);
  if (!flipped) {
    return { ...fresh, category: prior.category, niche: prior.niche, categoryBand: 'high', escalate: false, source: 'human_confirmed' };
  }
  return { ...fresh, escalate: true };
}
