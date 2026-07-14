import type { AppListing } from '../domain/listing';
import { runLinter, type LinterResult } from '../keywords/linter';
import type { AscListingData } from '../asc/listing-client';

/**
 * Deterministic signals — every fact about a listing that is *arithmetic*,
 * not judgement: character counts, utilisation ratios, slot counts, rating
 * averages, word overlaps.
 *
 * These are computed in code and handed to the auditor agent as a fact sheet.
 * The LLM's job is judgement ("is this title keyword-stuffed?"); it must not
 * be left to *count characters* or *average ratings* — models are unreliable
 * at both. Pure functions, fully unit-tested.
 */

export interface ListingSignals {
  title: {
    value: string;
    length: number;
    limit: number;
    utilizationPct: number;
    overLimit: boolean;
  };
  subtitle: {
    observable: boolean;
    value: string | null;
    length: number;
    limit: number;
    utilizationPct: number;
    /** Words appearing in both title and subtitle — wasted keyword coverage. */
    wordsSharedWithTitle: string[];
  };
  keywordField:
    | { observable: false; note: string }
    | { observable: true; value: string; length: number; charsRemaining: number; wordsSharedWithTitle: string[] };
  keywordLinter: LinterResult;
  description: {
    charCount: number;
    lineCount: number;
    /** Text above the App Store "more" cutoff (~first 3 lines). */
    aboveFold: string;
  };
  screenshots: {
    iphoneCount: number;
    ipadCount: number;
    /** iPhone slots used, of the 10 Apple allows. */
    slotsUsedOf10: number;
  };
  previewVideo: {
    observable: boolean;
    present: boolean;
  };
  ratings: {
    allTimeAverage: number | null;
    allTimeCount: number | null;
    currentVersionAverage: number | null;
    currentVersionCount: number | null;
    reviewSampleSize: number;
    reviewSampleAverage: number | null;
    /** Share of sampled reviews rated 1-2 stars, 0-1. */
    negativeReviewShare: number | null;
  };
  icon: {
    present: boolean;
  };
  conversion: {
    promotionalTextObservable: boolean;
    hasPromotionalText: boolean;
    promotionalText: string | null;
    hasReleaseNotes: boolean;
    releaseNotesLength: number;
    daysSinceLastUpdate: number | null;
  };
  competitive: {
    competitorCount: number;
  };
  categories?: {
    primary: string | null;
    secondary: string | null;
    /** True when only one category is set — secondary slot is an unused ASO opportunity. */
    missingSecondary: boolean;
  };
}

const TITLE_LIMIT = 30;
const SUBTITLE_LIMIT = 30;
const KEYWORD_FIELD_NOTE =
  'The iOS keyword field (100 chars) is not exposed by Apple\'s public API ' +
  'or the rendered web page. Score by inference only: assess whether the ' +
  'title and subtitle already cover the obvious keywords and how much '
  + 'opportunity a well-built keyword field would add. Set confidence to ' +
  '"inferred".';

/** Tokenise into deduplicated, lowercased words of length >= 3. */
export function words(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 3) seen.add(raw);
  }
  return [...seen];
}

const pct = (length: number, limit: number): number =>
  Math.round((length / limit) * 100);

function aboveFold(description: string): string {
  const lines = description
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const firstThree = lines.slice(0, 3).join(' ');
  // Apple truncates at ~3 lines; cap by characters too for single-line blobs.
  return firstThree.length > 230 ? `${firstThree.slice(0, 230)}…` : firstThree;
}

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.round((Date.now() - then) / 86_400_000));
}

/** Compute every deterministic signal for a listing. */
export function computeSignals(listing: AppListing, ascData?: AscListingData): ListingSignals {
  const titleWords = new Set(words(listing.name));
  const subtitle = listing.subtitle;
  const sharedWords = subtitle
    ? words(subtitle).filter((w) => titleWords.has(w))
    : [];

  const sample = listing.reviews;
  const sampleAverage =
    sample.length > 0
      ? Number(
          (
            sample.reduce((s, r) => s + r.rating, 0) / sample.length
          ).toFixed(2),
        )
      : null;
  const negativeShare =
    sample.length > 0
      ? Number(
          (
            sample.filter((r) => r.rating <= 2).length / sample.length
          ).toFixed(2),
        )
      : null;

  return {
    title: {
      value: listing.name,
      length: listing.name.length,
      limit: TITLE_LIMIT,
      utilizationPct: pct(listing.name.length, TITLE_LIMIT),
      overLimit: listing.name.length > TITLE_LIMIT,
    },
    subtitle: {
      observable: listing.provenance.crawler,
      value: subtitle,
      length: subtitle?.length ?? 0,
      limit: SUBTITLE_LIMIT,
      utilizationPct: subtitle ? pct(subtitle.length, SUBTITLE_LIMIT) : 0,
      wordsSharedWithTitle: sharedWords,
    },
    keywordField: ascData?.keywords != null
      ? {
          observable: true as const,
          value: ascData.keywords,
          length: ascData.keywords.length,
          charsRemaining: 100 - ascData.keywords.length,
          wordsSharedWithTitle: words(ascData.keywords).filter((w) => titleWords.has(w)),
        }
      : { observable: false as const, note: KEYWORD_FIELD_NOTE },
    keywordLinter: runLinter({
      title: listing.name,
      subtitle: listing.provenance.crawler ? (listing.subtitle ?? null) : null,
      keywordField: null,
    }),
    description: {
      charCount: listing.description.length,
      lineCount: listing.description.split('\n').filter((l) => l.trim()).length,
      aboveFold: aboveFold(listing.description),
    },
    screenshots: {
      // Priority: ASC (exact, device-specific) → iTunes → crawler (last fallback).
      // iTunes returns empty for apps that only uploaded modern display sizes
      // (6.7"/6.5"); the crawler can over-count by mixing iPhone + iPad slots.
      iphoneCount: ascData?.iphoneScreenshotCount ?? (listing.screenshotUrls.length || (listing.crawledScreenshotCount ?? 0)),
      ipadCount: listing.ipadScreenshotUrls.length,
      slotsUsedOf10: Math.min(10, ascData?.iphoneScreenshotCount ?? (listing.screenshotUrls.length || (listing.crawledScreenshotCount ?? 0))),
    },
    previewVideo: {
      observable: listing.provenance.crawler,
      present: listing.hasPreviewVideo,
    },
    ratings: {
      allTimeAverage: listing.averageRating,
      allTimeCount: listing.ratingCount,
      currentVersionAverage: listing.currentVersionRating,
      currentVersionCount: listing.currentVersionRatingCount,
      reviewSampleSize: sample.length,
      reviewSampleAverage: sampleAverage,
      negativeReviewShare: negativeShare,
    },
    icon: { present: Boolean(listing.iconUrl) },
    conversion: {
      promotionalTextObservable: listing.provenance.crawler,
      hasPromotionalText: Boolean(listing.promotionalText),
      promotionalText: ascData?.promotionalText ?? null,
      hasReleaseNotes: Boolean(listing.releaseNotes),
      releaseNotesLength: listing.releaseNotes?.length ?? 0,
      daysSinceLastUpdate: daysSince(listing.currentVersionReleaseDate),
    },
    competitive: {
      competitorCount: listing.competitors.length,
    },
    categories: {
      primary: listing.primaryGenre ?? null,
      secondary: listing.genres.length > 1 ? listing.genres[1]! : null,
      missingSecondary: listing.genres.length <= 1,
    },
  };
}
