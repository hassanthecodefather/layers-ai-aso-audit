import { ok, err, type Result } from '../domain/result';
import type { AppRef } from '../domain/app-url';
import {
  AppListingSchema,
  type AppListing,
  type AppSummary,
} from '../domain/listing';
import {
  fetchITunesCore,
  fetchReviews,
  fetchCompetitors,
  type ITunesCore,
} from './itunes';
import { getCrawler } from './crawler';

/**
 * The data layer's public surface. Two entry points, one for each phase of
 * the workflow:
 *
 *  - `resolveSummary` — one cheap, keyless call. Powers the "Is this the app
 *    you meant?" confirmation *before* any expensive work.
 *  - `resolveListing` — the full fan-out: iTunes core (required) plus reviews,
 *    competitors and the page crawl (all best-effort, in parallel).
 *
 * iTunes core is the only hard dependency. Every other source degrades to an
 * empty/`null` value and is recorded in `provenance`, so the audit always has
 * something to score and the report can be honest about what it's missing.
 */

/** Cheap surface metadata for the confirmation step. */
export async function resolveSummary(ref: AppRef): Promise<Result<AppSummary>> {
  const core = await fetchITunesCore(ref);
  if (!core.ok) return core;
  return ok(summaryFromCore(core.value));
}

/** Full listing — every source merged into the canonical model. */
export async function resolveListing(ref: AppRef, opts?: { skipCache?: boolean }): Promise<Result<AppListing>> {
  const core = await fetchITunesCore(ref, opts);
  if (!core.ok) return err(core.error);

  const searchTerm =
    core.value.primaryGenre ?? core.value.genres[0] ?? core.value.name;
  const crawler = getCrawler();

  // Independent sources — fan out in parallel, none can fail the audit.
  const [reviews, competitors, extras] = await Promise.all([
    fetchReviews(ref, 500, opts),
    fetchCompetitors(ref, searchTerm, 4, opts),
    crawler.scrape(core.value.url),
  ]);

  const listing: AppListing = {
    ...core.value,
    subtitle: extras?.subtitle ?? null,
    promotionalText: extras?.promotionalText ?? null,
    hasPreviewVideo: extras?.hasPreviewVideo ?? false,
    crawledScreenshotCount: extras?.screenshotCount ?? 0,
    reviews,
    competitors,
    provenance: {
      itunes: true,
      crawler: extras !== null,
      reviews: reviews.length > 0,
      competitors: competitors.length > 0,
      observedFromCache: false,
    },
  };

  // Parse rather than cast: a malformed merge fails loudly, here, not later.
  const parsed = AppListingSchema.safeParse(listing);
  if (!parsed.success) {
    return err(`Listing failed validation: ${parsed.error.message}`);
  }
  return ok(parsed.data);
}

function summaryFromCore(core: ITunesCore): AppSummary {
  return {
    appId: core.appId,
    country: core.country,
    url: core.url,
    name: core.name,
    developer: core.developer,
    iconUrl: core.iconUrl,
    primaryGenre: core.primaryGenre,
    averageRating: core.averageRating,
    ratingCount: core.ratingCount,
  };
}
