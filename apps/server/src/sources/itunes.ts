import { ok, err, type Result } from '../domain/result';
import { appStoreUrl, type AppRef } from '../domain/app-url';
import type { Competitor, Review } from '../domain/listing';
import { fetchJson, SourceError } from './http';

/**
 * Apple's iTunes adapter — the keyless backbone of the audit. Three free,
 * public, no-auth endpoints:
 *
 *  - Lookup API  → core metadata, icon, screenshots, ratings, description
 *  - Reviews RSS → recent customer reviews
 *  - Search API  → category peers, used as competitor candidates
 *
 * Everything here maps Apple's JSON into the domain model and stops. The
 * iOS keyword field, subtitle and promotional text are deliberately absent —
 * Apple's API never exposes them; that gap is filled (partly) by Firecrawl.
 */

/** The subset of `AppListing` that the iTunes Lookup API can populate. */
export interface ITunesCore {
  appId: string;
  country: string;
  url: string;
  name: string;
  developer: string;
  iconUrl: string | null;
  primaryGenre: string | null;
  genres: string[];
  price: number | null;
  formattedPrice: string | null;
  description: string;
  releaseNotes: string | null;
  version: string | null;
  screenshotUrls: string[];
  ipadScreenshotUrls: string[];
  averageRating: number | null;
  ratingCount: number | null;
  currentVersionRating: number | null;
  currentVersionRatingCount: number | null;
  contentRating: string | null;
  releaseDate: string | null;
  currentVersionReleaseDate: string | null;
}

interface RawLookupApp {
  kind?: string;
  wrapperType?: string;
  trackId?: number;
  trackName?: string;
  artistName?: string;
  artworkUrl512?: string;
  artworkUrl100?: string;
  primaryGenreName?: string;
  genres?: string[];
  price?: number;
  formattedPrice?: string;
  description?: string;
  releaseNotes?: string;
  version?: string;
  screenshotUrls?: string[];
  ipadScreenshotUrls?: string[];
  averageUserRating?: number;
  userRatingCount?: number;
  averageUserRatingForCurrentVersion?: number;
  userRatingCountForCurrentVersion?: number;
  contentAdvisoryRating?: string;
  releaseDate?: string;
  currentVersionReleaseDate?: string;
}

interface RawLookupResponse {
  resultCount?: number;
  results?: RawLookupApp[];
}

const num = (v: number | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

function toCore(app: RawLookupApp, ref: AppRef): ITunesCore {
  return {
    appId: ref.appId,
    country: ref.country,
    url: appStoreUrl(ref),
    name: app.trackName?.trim() ?? 'Unknown app',
    developer: app.artistName?.trim() ?? 'Unknown developer',
    iconUrl: app.artworkUrl512 ?? app.artworkUrl100 ?? null,
    primaryGenre: app.primaryGenreName ?? null,
    genres: app.genres ?? [],
    price: num(app.price),
    formattedPrice: app.formattedPrice ?? null,
    description: app.description?.trim() ?? '',
    releaseNotes: app.releaseNotes?.trim() ?? null,
    version: app.version ?? null,
    screenshotUrls: app.screenshotUrls ?? [],
    ipadScreenshotUrls: app.ipadScreenshotUrls ?? [],
    averageRating: num(app.averageUserRating),
    ratingCount: num(app.userRatingCount),
    currentVersionRating: num(app.averageUserRatingForCurrentVersion),
    currentVersionRatingCount: num(app.userRatingCountForCurrentVersion),
    contentRating: app.contentAdvisoryRating ?? null,
    releaseDate: app.releaseDate ?? null,
    currentVersionReleaseDate: app.currentVersionReleaseDate ?? null,
  };
}

/** Fetch core metadata for one app. The cheap call behind the confirm step. */
export async function fetchITunesCore(ref: AppRef): Promise<Result<ITunesCore>> {
  const url =
    `https://itunes.apple.com/lookup?id=${encodeURIComponent(ref.appId)}` +
    `&country=${encodeURIComponent(ref.country)}&entity=software`;
  try {
    const data = await fetchJson<RawLookupResponse>(url, { source: 'iTunes Lookup' });
    const app = data.results?.find(
      (r) => (r.kind ?? r.wrapperType) === 'software',
    );
    if (!app) {
      return err(
        `No iOS app found for ID ${ref.appId} in the "${ref.country}" App Store. ` +
          'Double-check the URL — the app may be unavailable in that country.',
      );
    }
    return ok(toCore(app, ref));
  } catch (e) {
    const msg = e instanceof SourceError ? e.message : 'iTunes lookup failed';
    return err(msg);
  }
}

// ── Reviews (RSS) ──────────────────────────────────────────────────────────

interface RawRssEntry {
  'im:rating'?: { label?: string };
  title?: { label?: string };
  content?: { label?: string };
  author?: { name?: { label?: string } };
  updated?: { label?: string };
}

interface RawRssResponse {
  feed?: { entry?: RawRssEntry[] | RawRssEntry };
}

/**
 * Recent customer reviews via the iTunes RSS feed. Best-effort: reviews are
 * one input to one dimension, so a feed failure returns `[]` rather than
 * aborting the whole audit.
 */
export async function fetchReviews(ref: AppRef, limit = 25): Promise<Review[]> {
  const url =
    `https://itunes.apple.com/${encodeURIComponent(ref.country)}/rss/customerreviews/` +
    `page=1/id=${encodeURIComponent(ref.appId)}/sortby=mostrecent/json`;
  try {
    const data = await fetchJson<RawRssResponse>(url, {
      source: 'iTunes Reviews',
      retries: 1,
    });
    const raw = data.feed?.entry;
    const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return entries
      .filter((e): e is RawRssEntry => Boolean(e['im:rating']))
      .slice(0, limit)
      .map((e) => ({
        author: e.author?.name?.label ?? 'Anonymous',
        rating: Number(e['im:rating']?.label ?? 0),
        title: e.title?.label ?? '',
        body: e.content?.label ?? '',
        updated: e.updated?.label ?? null,
      }));
  } catch {
    return [];
  }
}

// ── Competitors (Search) ───────────────────────────────────────────────────

/**
 * Category peers via the iTunes Search API.
 *
 * Apple has no public "similar apps" endpoint, so we approximate: search the
 * app's primary genre as a term and take the highest-ranked results that
 * aren't the app itself. It's a heuristic — documented as such in the README —
 * and good enough to anchor a competitive comparison.
 */
export async function fetchCompetitors(
  ref: AppRef,
  searchTerm: string,
  limit = 4,
): Promise<Competitor[]> {
  const term = searchTerm.trim();
  if (!term) return [];
  const url =
    `https://itunes.apple.com/search?term=${encodeURIComponent(term)}` +
    `&country=${encodeURIComponent(ref.country)}&entity=software&limit=20`;
  try {
    const data = await fetchJson<RawLookupResponse>(url, {
      source: 'iTunes Search',
      retries: 1,
    });
    return (data.results ?? [])
      .filter((r) => String(r.trackId) !== ref.appId && r.trackName)
      .slice(0, limit)
      .map((r) => ({
        appId: String(r.trackId ?? ''),
        name: r.trackName ?? 'Unknown',
        developer: r.artistName ?? 'Unknown',
        primaryGenre: r.primaryGenreName ?? null,
        averageRating: num(r.averageUserRating),
        ratingCount: num(r.userRatingCount),
        formattedPrice: r.formattedPrice ?? null,
        screenshotCount: (r.screenshotUrls ?? []).length,
        hasPreviewVideo: false,
      }));
  } catch {
    return [];
  }
}
