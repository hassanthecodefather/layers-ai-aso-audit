import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AppListingSchema, type AppListing, type Review } from '../../domain/listing';

/**
 * Map a frozen iTunes Lookup + reviews fixture into a domain `AppListing`,
 * exercising the same fields the live `sources/itunes.ts` adapter populates
 * (notably `bundleId` and `sellerUrl`, the ID-lite signals). These are the §F
 * red-test inputs — see this directory's README.
 */
const DIR = dirname(fileURLToPath(import.meta.url));

const readJson = (file: string): any =>
  JSON.parse(readFileSync(join(DIR, file), 'utf8'));

function loadReviews(name: string): Review[] {
  const data = readJson(`${name}.reviews.json`);
  const raw = data?.feed?.entry;
  const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return entries
    .filter((e: any) => e?.['im:rating'])
    .map((e: any) => ({
      author: e.author?.name?.label ?? 'Anonymous',
      rating: Number(e['im:rating']?.label ?? 0),
      title: e.title?.label ?? '',
      body: e.content?.label ?? '',
      updated: e.updated?.label ?? null,
    }));
}

export function loadFixtureListing(name: string): AppListing {
  const app = readJson(`${name}.itunes.json`).results[0];
  return AppListingSchema.parse({
    appId: String(app.trackId),
    country: 'us',
    url: app.trackViewUrl ?? `https://apps.apple.com/us/app/id${app.trackId}`,
    name: app.trackName ?? 'Unknown',
    developer: app.artistName ?? 'Unknown',
    bundleId: app.bundleId ?? null,
    sellerUrl: app.sellerUrl ?? null,
    iconUrl: app.artworkUrl512 ?? app.artworkUrl100 ?? null,
    primaryGenre: app.primaryGenreName ?? null,
    genres: app.genres ?? [],
    price: typeof app.price === 'number' ? app.price : null,
    formattedPrice: app.formattedPrice ?? null,
    subtitle: null,
    promotionalText: null,
    description: app.description ?? '',
    releaseNotes: app.releaseNotes ?? null,
    version: app.version ?? null,
    screenshotUrls: app.screenshotUrls ?? [],
    ipadScreenshotUrls: app.ipadScreenshotUrls ?? [],
    hasPreviewVideo: false,
    averageRating: typeof app.averageUserRating === 'number' ? app.averageUserRating : null,
    ratingCount: typeof app.userRatingCount === 'number' ? app.userRatingCount : null,
    currentVersionRating:
      typeof app.averageUserRatingForCurrentVersion === 'number'
        ? app.averageUserRatingForCurrentVersion
        : null,
    currentVersionRatingCount:
      typeof app.userRatingCountForCurrentVersion === 'number'
        ? app.userRatingCountForCurrentVersion
        : null,
    contentRating: app.contentAdvisoryRating ?? null,
    releaseDate: app.releaseDate ?? null,
    currentVersionReleaseDate: app.currentVersionReleaseDate ?? null,
    reviews: loadReviews(name),
    competitors: [],
    provenance: { itunes: true, crawler: false, reviews: true, competitors: false },
  });
}
