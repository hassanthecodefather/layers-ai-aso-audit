import type { AppRef } from '../domain/app-url';
import type { ResolvedIdentity } from '../identity/resolve';
import type { Competitor } from '../domain/listing';
import type { ListingSnapshot } from '../domain/snapshot';
import type { AppKittieClient } from '../keywords/appkittie-client';
import type { StorageClient } from '../memory/storage-client';
import { batchLookupCompetitors } from './itunes';

const MAX_SEEDS = 2;      // AppKittie queries per audit (10 credits each)
const MAX_COMPETITORS = 6; // cap on returned competitors

/**
 * Derive seed keywords from the resolved identity. Uses niche (most specific)
 * and category (function-derived, not store genre). Up to MAX_SEEDS terms.
 * Exported so the workflow can pass seeds to persistAudit for future reuse.
 */
export function seedKeywords(resolved: ResolvedIdentity): string[] {
  const seeds: string[] = [];
  if (resolved.niche) seeds.push(resolved.niche);
  if (seeds.length < MAX_SEEDS) seeds.push(resolved.category);
  return seeds.slice(0, MAX_SEEDS);
}

/**
 * Reuse path for D3 (mirrors selectCandidateResult / selectVisionResult).
 *
 * Returns the prior snapshot's competitors when the identity seeds are
 * unchanged — the same niche + category terms produce the same topApps
 * ranking, so a live AppKittie call would return the same result.
 * Returns null when the snapshot is absent, seeds changed, or D3 didn't
 * run previously (no functionCompetitorSeeds stored).
 */
export function selectFunctionCompetitors(
  resolved: ResolvedIdentity,
  priorSnapshot: ListingSnapshot | null,
): Competitor[] | null {
  if (!priorSnapshot) return null;
  const priorSeeds = priorSnapshot.functionCompetitorSeeds;
  if (!priorSeeds || priorSeeds.length === 0) return null;

  const currentSorted = seedKeywords(resolved).slice().sort().join('|');
  const priorSorted = priorSeeds.slice().sort().join('|');
  if (currentSorted !== priorSorted) return null;

  const prior = priorSnapshot.listing.competitors;
  if (prior.length === 0) return null;

  return prior;
}

/**
 * D3: identity-seeded competitor discovery.
 *
 * Seeds AppKittie with function-derived terms (not store genre), collects
 * topApps ranked for those keywords, filters tombstoned peers, then fetches
 * their full listings via iTunes Lookup. Returns up to MAX_COMPETITORS peers.
 *
 * Falls back to [] on any error — the caller should use fetchCompetitors
 * (genre-based) as the fallback.
 */
export async function fetchFunctionGroundedCompetitors(
  ref: AppRef,
  resolved: ResolvedIdentity,
  appKittie: AppKittieClient,
  storage: StorageClient,
): Promise<Competitor[]> {
  const seeds = seedKeywords(resolved);
  if (seeds.length === 0) return [];

  // 1. Collect topApp IDs from all seed queries (union, dedup).
  const seen = new Set<string>();
  const collectedIds: string[] = [];
  for (const seed of seeds) {
    const topApps = await appKittie.getTopApps(seed, ref.country);
    for (const app of topApps) {
      if (app.appStoreId && !seen.has(app.appStoreId)) {
        seen.add(app.appStoreId);
        collectedIds.push(app.appStoreId);
      }
    }
  }

  if (collectedIds.length === 0) return [];

  // 2. Filter tombstoned peers (human-rejected competitors never re-surface).
  const tombstonesR = await storage.tombstones(ref.appId, ref.country);
  const tombstones = tombstonesR.ok ? tombstonesR.value : new Set<string>();
  const filtered = collectedIds.filter((id) => !tombstones.has(id));

  if (filtered.length === 0) return [];

  // 3. Fetch competitor listings via iTunes Lookup (free, not AppKittie).
  return batchLookupCompetitors(filtered, ref.country, ref.appId, MAX_COMPETITORS);
}
