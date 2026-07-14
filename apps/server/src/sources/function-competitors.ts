import type { AppRef } from '../domain/app-url';
import type { ResolvedIdentity } from '../identity/resolve';
import type { OverrodeEvidence } from '../domain/identity';
import type { Competitor } from '../domain/listing';
import type { ListingSnapshot } from '../domain/snapshot';
import type { AppKittieClient } from '../keywords/appkittie-client';
import type { StorageClient } from '../memory/storage-client';
import { batchLookupCompetitors } from './itunes';

const MAX_SEEDS = 2;      // AppKittie queries per audit (10 credits each)
const MAX_COMPETITORS = 6; // cap on returned competitors
const MAX_EVIDENCE_COMPETITORS = 3; // teaser only — not a full parallel analysis

/**
 * Derive seed keywords from the resolved identity — a prioritised, deduped
 * (case-insensitive) list: classifier function terms (short, searchable) →
 * niche → function category. Capped at MAX_SEEDS.
 *
 * functionTerms come first because AppKittie's keyword index works best with
 * short, user-typed search terms (e.g. "romance", "novel") rather than the
 * verbose internal labels the classifier produces for niche/category
 * (e.g. "Serialized romance fiction", "Romance novel reader").
 */
export function seedKeywords(
  resolved: Pick<ResolvedIdentity, 'niche' | 'category' | 'functionTerms'>,
): string[] {
  const candidates: (string | null | undefined)[] = [
    ...(resolved.functionTerms ?? []),
    resolved.niche,
    resolved.category,
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates) {
    const trimmed = c?.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= MAX_SEEDS) break;
  }
  return out;
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
  tenantId: string,
): Promise<Competitor[]> {
  const seeds = seedKeywords(resolved);
  if (seeds.length === 0) return [];

  // 1. Collect topApp IDs from all seed queries (union, dedup).
  const seen = new Set<string>();
  const collectedIds: string[] = [];
  for (const seed of seeds) {
    const topApps = await appKittie.getTopApps(seed, ref.country);
    console.info(`[D3] seed="${seed}" country=${ref.country} → ${topApps.length} apps`);
    for (const app of topApps) {
      if (app.appStoreId && !seen.has(app.appStoreId)) {
        seen.add(app.appStoreId);
        collectedIds.push(app.appStoreId);
      }
    }
  }

  if (collectedIds.length === 0) return [];

  // 2. Filter tombstoned peers (human-rejected competitors never re-surface).
  const tombstonesR = await storage.tombstones(tenantId, ref.appId, ref.country);
  const tombstones = tombstonesR.ok ? tombstonesR.value : new Set<string>();
  const filtered = collectedIds.filter((id) => !tombstones.has(id));

  if (filtered.length === 0) return [];

  // 3. Fetch competitor listings via iTunes Lookup (free, not AppKittie).
  return batchLookupCompetitors(filtered, ref.country, ref.appId, MAX_COMPETITORS);
}

/**
 * Dual-discovery: find the competitors the app's OWN evidence implies, for the
 * mismatch check shown when a human override is contested. Seeds from the stored
 * marker (no re-resolution), returns a short teaser list. Never replaces the
 * confirmed-category competitors — it's a comparison, surfaced honestly.
 */
export async function fetchEvidenceCompetitors(
  ref: AppRef,
  marker: OverrodeEvidence,
  appKittie: AppKittieClient,
  storage: StorageClient,
  tenantId: string,
  limit: number = MAX_EVIDENCE_COMPETITORS,
): Promise<Competitor[]> {
  // The category phrase (e.g. "Electric vehicle companion") is an internal
  // classifier label, not a searchable keyword — skip it and seed from the
  // captured functionTerms instead. They are closer to what users search for
  // and give AppKittie enough signal to find evidence-side peers.
  // Fall back to the category phrase only when no functionTerms were captured.
  const MAX_EVIDENCE_SEEDS = 3;
  const termPool = marker.functionTerms ?? [];
  const seeds: string[] = termPool.length > 0
    ? termPool.slice(0, MAX_EVIDENCE_SEEDS)
    : [marker.category];
  if (seeds.length === 0) return [];

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

  const tombstonesR = await storage.tombstones(tenantId, ref.appId, ref.country);
  const tombstones = tombstonesR.ok ? tombstonesR.value : new Set<string>();
  const filtered = collectedIds.filter((id) => !tombstones.has(id));
  if (filtered.length === 0) return [];

  return batchLookupCompetitors(filtered, ref.country, ref.appId, limit);
}
