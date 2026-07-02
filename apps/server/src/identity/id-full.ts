/**
 * ID-full: Vision-grounded identity augmentation (Task B2).
 *
 * Upgrades an ID-lite identity row with a vision pass that:
 *  - Checks whether the creative assets match the resolved function category.
 *  - Resolves the audience segment.
 *  - May de-escalate a prior escalation when creative confirms function.
 *  - Does NOT re-run the deterministic signal tally.
 *
 * All deterministic fields (category, categoryBand, tally, divergence, source)
 * are copied verbatim from the ID-lite prior.
 */

import type { AppListing } from '../domain/listing';
import type { IdentityVersion } from '../domain/identity';
import type { ResolvedIdentity } from './resolve';
import { newId } from '../memory/ids';

// ── Public types ──────────────────────────────────────────────────────────────

export interface AudienceInfo {
  description: string;
  segments: string[]; // e.g. ["EV owners", "Rivian customers"]
}

export interface CreativeMatchResult {
  creativeMatchesFunction: boolean;
  confidence: 'observed' | 'inferred';
  resolvedNiche: string | null;          // vision-derived niche (may refine lite's)
  nicheBand: 'high' | 'medium' | 'low'; // vision-grounded niche band
  audience: AudienceInfo;
}

export interface FullIdentityResult {
  identityVersion: IdentityVersion; // stage = 'full', audience populated
  visionEscalation: boolean;        // true = creative doesn't match function
}

/**
 * Vision-grounded identity client interface (for stubbing in tests).
 * Separate from the screenshot/icon VisionClient in B1 to keep concerns clear.
 */
export interface IdentityVisionClient {
  analyzeCreativeMatch(
    iconUrl: string | null,
    firstScreenshotUrl: string | null,
    functionCategory: string,
  ): Promise<CreativeMatchResult>;
}

// ── Core function ─────────────────────────────────────────────────────────────

/**
 * Upgrade an ID-lite identity to ID-full using vision evidence.
 *
 * - Does NOT re-run the deterministic signal tally.
 * - Copies category/categoryBand/tally/divergence/source verbatim from litePrior.
 * - Adds audience; may refine nicheBand (but only upward — vision can raise
 *   a 'low' nicheBand to 'medium' or 'high', never lower a 'high').
 * - May change `escalate`: vision can resolve a prior escalation when creative
 *   confirms function (only if the lite escalation was niche-driven, not
 *   category-driven — cross_domain divergence always escalates regardless).
 * - Returns `visionEscalation = true` if creative contradicts the function.
 *
 * De-escalation rule:
 *   1. litePrior.escalate === true
 *   2. litePrior.divergence !== 'cross_domain'
 *   3. creativeMatch.creativeMatchesFunction === true
 *
 * @param listing      The full listing (for iconUrl + screenshotUrls).
 * @param litePrior    The existing ID-lite identity (resolved by A2).
 * @param visionClient The injected vision client (real or stub).
 * @param nextVersion  The version number to stamp (caller increments from prior).
 * @param now          ISO-8601 timestamp.
 */
export async function runIdFull(
  listing: AppListing,
  litePrior: ResolvedIdentity,
  visionClient: IdentityVisionClient,
  nextVersion: number,
  now: string,
): Promise<FullIdentityResult> {
  const iconUrl = listing.iconUrl ?? null;
  const firstScreenshotUrl = listing.screenshotUrls[0] ?? null;

  const creativeMatch = await visionClient.analyzeCreativeMatch(
    iconUrl,
    firstScreenshotUrl,
    litePrior.category,
  );

  // Vision escalation: creative doesn't match the resolved function.
  const visionEscalation = !creativeMatch.creativeMatchesFunction;

  // De-escalation: clear in code — only de-escalate if:
  //   1. litePrior escalated
  //   2. divergence is not cross_domain (structural; vision can't fix it)
  //   3. creative confirms function
  const deEscalate =
    litePrior.escalate &&
    litePrior.divergence !== 'cross_domain' &&
    creativeMatch.creativeMatchesFunction;

  const escalate = deEscalate ? false : litePrior.escalate || visionEscalation;

  // nicheBand: vision can only raise (not lower) the prior value.
  // When de-escalating we adopt vision's nicheBand; otherwise keep litePrior's.
  function nicheBandRank(b: 'high' | 'medium' | 'low'): number {
    return b === 'high' ? 2 : b === 'medium' ? 1 : 0;
  }
  const priorNicheBand = litePrior.nicheBand ?? 'low';
  let nicheBand: 'high' | 'medium' | 'low';
  if (deEscalate) {
    // Vision resolved the ambiguity — adopt its nicheBand.
    nicheBand = creativeMatch.nicheBand;
  } else {
    // Only raise, never lower.
    nicheBand =
      nicheBandRank(creativeMatch.nicheBand) > nicheBandRank(priorNicheBand)
        ? creativeMatch.nicheBand
        : priorNicheBand;
  }

  // Niche: verbatim from litePrior (vision does not override the deterministic niche field).
  // Vision's resolvedNiche is only used internally to derive nicheBand, not stored separately.
  const niche = litePrior.niche;

  const identityVersion: IdentityVersion = {
    id: newId('idv'),
    appId: listing.appId,
    country: listing.country,
    version: nextVersion,
    stage: 'full',
    // ── Verbatim copies from litePrior (no re-running tally) ──────────────
    category: litePrior.category,
    categoryBand: litePrior.categoryBand,
    tally: litePrior.tally,
    divergence: litePrior.divergence,
    source: litePrior.source,
    // ── Vision-augmented fields ────────────────────────────────────────────
    niche,
    nicheBand,
    audience: creativeMatch.audience,
    escalate,
    createdAt: now,
  };

  return { identityVersion, visionEscalation };
}
