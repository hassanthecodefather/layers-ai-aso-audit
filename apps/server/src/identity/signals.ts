import type { AppListing } from '../domain/listing';

/**
 * The deterministic, day-one identity signals (spec ID "ID-lite") — pure code
 * over the iTunes Lookup response + reviews, no vision, no LLM. These are the
 * raw observations; turning them into a tally and a band is `resolve.ts`'s job.
 */
export interface RawIdentitySignals {
  /** The app's display name — often the strongest single identity signal. */
  appName: string;
  /** First 300 chars of the description — confirms function when name is ambiguous. */
  appDescriptionExcerpt: string;
  developer: string;
  /** Slugified developer name, for matching against the bundle/domain. */
  developerSlug: string;
  /** Reverse-DNS org segment (com.**rivian**.ios → "rivian"), or null if vanity. */
  bundleOrg: string | null;
  /** A bundle id that isn't usable reverse-DNS (vanity / generic / malformed). */
  bundleIsVanity: boolean;
  /** Registrable domain label of the marketing/support URL (rivian.com → "rivian"). */
  marketingDomain: string | null;
  /** The store-declared category (primaryGenre) — a single signal, not strong by default. */
  storeCategory: string;
  storeGenres: string[];
  /** Lowercased review title+body corpus, for vocabulary overlap. */
  reviewCorpus: string;
  reviewCount: number;
}

/** First reverse-DNS segments that mark a real org-style bundle id. */
const TLDISH = new Set([
  'com', 'org', 'net', 'io', 'co', 'app', 'ai', 'me', 'tv', 'gg', 'dev', 'us', 'uk', 'de',
]);
/** Org segments too generic to corroborate anything (com.app.myapp). */
const GENERIC_ORG = new Set(['app', 'apps', 'ios', 'mobile', 'myapp', 'application', 'test']);

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Extract the reverse-DNS org segment, or null when the id is vanity/unusable. */
function parseBundle(bundleId: string | null): { org: string | null; vanity: boolean } {
  if (!bundleId) return { org: null, vanity: true };
  const parts = bundleId.toLowerCase().split('.').filter(Boolean);
  // Real reverse-DNS starts with a TLD-ish segment and has an org segment after it.
  if (parts.length < 2 || !TLDISH.has(parts[0]!)) return { org: null, vanity: true };
  const org = parts[1]!;
  if (GENERIC_ORG.has(org)) return { org: null, vanity: true };
  return { org, vanity: false };
}

/** Registrable second-level label of a URL's host (https://www.rivian.com/ → "rivian"). */
export function registrableLabel(url: string | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(url.includes('://') ? url : `https://${url}`).hostname
      .toLowerCase()
      .replace(/^www\./, '');
    const labels = host.split('.').filter(Boolean);
    if (labels.length < 2) return null;
    // Second-level label (ignores the TLD); good enough for matching, not for PSL correctness.
    return labels[labels.length - 2] ?? null;
  } catch {
    return null;
  }
}

export function extractIdentitySignals(listing: AppListing): RawIdentitySignals {
  const { org, vanity } = parseBundle(listing.bundleId);
  const reviewCorpus = listing.reviews
    .map((r) => `${r.title} ${r.body}`)
    .join(' ')
    .toLowerCase();
  return {
    appName: listing.name,
    appDescriptionExcerpt: listing.description.slice(0, 300),
    developer: listing.developer,
    developerSlug: slug(listing.developer),
    bundleOrg: org,
    bundleIsVanity: vanity,
    marketingDomain: registrableLabel(listing.sellerUrl),
    storeCategory: listing.primaryGenre ?? listing.genres[0] ?? 'Unknown',
    storeGenres: listing.genres,
    reviewCorpus,
    reviewCount: listing.reviews.length,
  };
}
