import type { AppRef } from '../domain/app-url';
import type { ResolvedIdentity } from '../identity/resolve';
import type { Competitor } from '../domain/listing';
import type { AppKittieClient } from '../keywords/appkittie-client';
import type { StorageClient } from '../memory/storage-client';
import { batchLookupCompetitors } from './itunes';

const MAX_SEEDS = 2;      // AppKittie queries per audit (10 credits each)
const MAX_COMPETITORS = 6; // cap on returned competitors

/**
 * Derive seed keywords from the resolved identity. Uses niche (most specific)
 * and category (function-derived, not store genre). Up to MAX_SEEDS terms.
 */
function seedKeywords(resolved: ResolvedIdentity): string[] {
  const seeds: string[] = [];
  if (resolved.niche) seeds.push(resolved.niche);
  if (seeds.length < MAX_SEEDS) seeds.push(resolved.category);
  return seeds.slice(0, MAX_SEEDS);
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
