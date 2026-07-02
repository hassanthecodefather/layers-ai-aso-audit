import { z } from 'zod';

/**
 * The canonical domain model.
 *
 * This is the *anti-corruption layer*: Apple's iTunes Lookup API, the iTunes
 * customer-reviews RSS feed, and a Firecrawl scrape of the rendered web page
 * all return wildly different shapes. None of those shapes is allowed past
 * this file — every source maps *into* `AppListing`, and the scoring engine
 * only ever sees `AppListing`. Add a fourth data source tomorrow and nothing
 * downstream changes.
 */

/** A single customer review (from the public iTunes RSS feed). */
export const ReviewSchema = z.object({
  author: z.string(),
  rating: z.number().min(0).max(5),
  title: z.string(),
  body: z.string(),
  updated: z.string().nullable(),
  id: z.string().optional(),        // Apple's stable review ID from RSS id.label
  appVersion: z.string().nullable().optional(), // app version from im:version.label
});
export type Review = z.infer<typeof ReviewSchema>;

/** A competitor listing — a thinner projection of the same app data. */
export const CompetitorSchema = z.object({
  appId: z.string(),
  name: z.string(),
  developer: z.string(),
  primaryGenre: z.string().nullable(),
  averageRating: z.number().nullable(),
  ratingCount: z.number().nullable(),
  formattedPrice: z.string().nullable(),
  screenshotCount: z.number(),
  hasPreviewVideo: z.boolean(),
  description: z.string().optional(),   // from iTunes Lookup; inferred-only gap source
});
export type Competitor = z.infer<typeof CompetitorSchema>;

/**
 * Which sources actually contributed. The audit degrades gracefully — an
 * iTunes-only run still scores 8 of 10 dimensions — and the report tells the
 * user exactly what was and wasn't observable.
 */
export const ProvenanceSchema = z.object({
  itunes: z.boolean(),
  /** Whether the page crawler contributed (subtitle, promo text, video). */
  crawler: z.boolean(),
  reviews: z.boolean(),
  /** True when the reviews fetch failed (network/429) rather than returning empty cleanly. */
  reviewsFetchFailed: z.boolean().optional(),
  competitors: z.boolean(),
  /** True when all listing data was served from the HTTP response cache (E1). */
  observedFromCache: z.boolean().optional().default(false),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const AppListingSchema = z.object({
  appId: z.string(),
  country: z.string(),
  url: z.string(),

  // Core identity — iTunes Lookup API.
  name: z.string(),
  developer: z.string(),
  iconUrl: z.string().nullable(),
  primaryGenre: z.string().nullable(),
  genres: z.array(z.string()),
  price: z.number().nullable(),
  formattedPrice: z.string().nullable(),

  // Identity-resolution signals the Lookup API already returns (spec ID):
  // the reverse-DNS bundle id (com.rivian.* → "rivian") and the developer's
  // marketing/support URL (the citable marketing-domain signal family).
  bundleId: z.string().nullable().default(null),
  sellerUrl: z.string().nullable().default(null),

  // Text fields. `subtitle` and `promotionalText` exist *only* on the
  // rendered web page — the iTunes API never returns them — so they are
  // null on an iTunes-only run.
  subtitle: z.string().nullable(),
  promotionalText: z.string().nullable(),
  description: z.string(),
  releaseNotes: z.string().nullable(),
  version: z.string().nullable(),

  // Creative assets.
  screenshotUrls: z.array(z.string()),
  ipadScreenshotUrls: z.array(z.string()),
  hasPreviewVideo: z.boolean(),
  /** Screenshot count from the page crawler; fallback when iTunes returns none (known API gap). */
  crawledScreenshotCount: z.number().default(0),

  // Ratings & reviews.
  averageRating: z.number().nullable(),
  ratingCount: z.number().nullable(),
  currentVersionRating: z.number().nullable(),
  currentVersionRatingCount: z.number().nullable(),
  contentRating: z.string().nullable(),

  releaseDate: z.string().nullable(),
  currentVersionReleaseDate: z.string().nullable(),

  reviews: z.array(ReviewSchema),
  competitors: z.array(CompetitorSchema),

  provenance: ProvenanceSchema,
});
export type AppListing = z.infer<typeof AppListingSchema>;

/**
 * The thin slice shown in the "Is this the app you meant?" confirmation card.
 * Cheap to fetch (one iTunes Lookup call, no key), so the user confirms
 * before the expensive scrape-and-score work begins.
 */
export const AppSummarySchema = z.object({
  appId: z.string(),
  country: z.string(),
  url: z.string(),
  name: z.string(),
  developer: z.string(),
  iconUrl: z.string().nullable(),
  primaryGenre: z.string().nullable(),
  averageRating: z.number().nullable(),
  ratingCount: z.number().nullable(),
});
export type AppSummary = z.infer<typeof AppSummarySchema>;

/** Project a full listing down to its confirmation-card summary. */
export function toSummary(listing: AppListing): AppSummary {
  return {
    appId: listing.appId,
    country: listing.country,
    url: listing.url,
    name: listing.name,
    developer: listing.developer,
    iconUrl: listing.iconUrl,
    primaryGenre: listing.primaryGenre,
    averageRating: listing.averageRating,
    ratingCount: listing.ratingCount,
  };
}
