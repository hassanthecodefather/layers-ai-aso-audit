import { createHash } from 'node:crypto';
import type { AppListing } from '../domain/listing';
import type { DimensionId, Confidence } from '../domain/audit';
import { DIMENSION_IDS } from '../domain/audit';
import type { ListingSignals } from './signals';
import type { VisionResult } from '../vision/types';

/**
 * Bump when codeScore or coarseOrdinalScore logic changes so that the
 * per-dimension reuse cache is invalidated for all stored snapshots that
 * predate the change. Without this, old snapshots would serve stale scores
 * for dimensions whose scoring formula changed between Phase A and B.
 */
export const SCORER_VERSION = 'phase-b-v4';

/**
 * True when a VisionResult contains real Gemini-produced critiques.
 *
 * A parse failure (backward-scan recovery returning {}) leaves critiques
 * empty even though the client is live. This guard is the single shared
 * source of truth used by deriveConfidence, codeScore, and the two prompt
 * sites — all four must change together whenever the definition changes.
 */
export function visionUsable(v: VisionResult | undefined): v is VisionResult {
  return !!v && v.screenshotSetVerdict.critiques.length > 0;
}

/**
 * Returns the subset of listing/signal fields that each dimension depends on.
 * Used for per-dimension change detection: if the hash of these inputs matches
 * the prior run, the dimension score can be reused without calling the model.
 */
export function dimensionInputs(
  id: DimensionId,
  listing: AppListing,
  signals: ListingSignals,
): unknown {
  switch (id) {
    case 'title':
      return { name: listing.name };

    case 'subtitle':
      return {
        subtitle: listing.subtitle,
        crawled: listing.provenance.crawler,
      };

    case 'keywordField':
      return {
        name: listing.name,
        subtitle: listing.subtitle,
      };

    case 'description':
      return { description: listing.description };

    case 'screenshots':
      return {
        screenshotUrls: listing.screenshotUrls,
        ipadScreenshotUrls: listing.ipadScreenshotUrls,
      };

    case 'previewVideo':
      return {
        hasPreviewVideo: listing.hasPreviewVideo,
        crawled: listing.provenance.crawler,
      };

    case 'ratings':
      return {
        averageRating: listing.averageRating,
        ratingCount: listing.ratingCount,
        currentVersionRating: listing.currentVersionRating,
        currentVersionRatingCount: listing.currentVersionRatingCount,
        reviews: listing.reviews
          .slice(0, 15)
          .map((r) => ({ rating: r.rating, body: r.body.slice(0, 100) })),
      };

    case 'icon':
      return { iconUrl: listing.iconUrl };

    case 'conversion':
      return {
        promotionalText: listing.promotionalText,
        releaseNotes: listing.releaseNotes,
        crawled: listing.provenance.crawler,
        version: listing.version,
      };

    case 'competitive':
      return listing.competitors.map((c) => ({
        name: c.name,
        averageRating: c.averageRating,
      }));
  }
}

/**
 * SHA-256 hash (first 16 hex chars) of a dimension's inputs.
 * Equal hashes → the dimension's inputs are identical → score can be reused.
 */
export function dimensionInputHash(
  id: DimensionId,
  listing: AppListing,
  signals: ListingSignals,
): string {
  return createHash('sha256')
    .update(SCORER_VERSION + ':')
    .update(JSON.stringify(dimensionInputs(id, listing, signals)))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Compute input hashes for all 10 dimensions in one pass.
 */
export function allDimensionHashes(
  listing: AppListing,
  signals: ListingSignals,
): Record<DimensionId, string> {
  return Object.fromEntries(
    DIMENSION_IDS.map((id) => [id, dimensionInputHash(id, listing, signals)]),
  ) as Record<DimensionId, string>;
}

/**
 * Derive the confidence level for a dimension purely in code — never from the
 * model. The model is unreliable at assessing its own observability.
 *
 * @param visionResult - Optional B1 vision result; upgrades screenshots/icon to 'observed'.
 */
export function deriveConfidence(
  id: DimensionId,
  signals: ListingSignals,
  visionResult?: VisionResult,
): Confidence {
  switch (id) {
    case 'subtitle':
      return signals.subtitle.observable ? 'observed' : 'unavailable';

    case 'previewVideo':
      // Existence is observable, but the rubric's quality checks (hook, length,
      // works-without-sound) need vision (P2). Honest Phase-A label: inferred
      // when present/absent is known; unavailable when the page wasn't crawled.
      return signals.previewVideo.observable ? 'inferred' : 'unavailable';

    case 'screenshots':
      // 'observed' only when Gemini produced real critiques. A parse failure
      // (empty critiques) must not fabricate an observed confidence.
      return visionUsable(visionResult) ? 'observed' : 'inferred';

    case 'keywordField':
      // The iOS keyword field is never public — always inferred.
      return 'inferred';

    case 'conversion':
      return signals.conversion.promotionalTextObservable ? 'observed' : 'inferred';

    // title, description, ratings, icon, competitive — observable from public data.
    // (ratings: the average is genuinely observed; complaint themes / developer
    // responses are deferred to P4 and surface as recommendations, not the score.)
    // icon: B1 includes vision quality assessment — always 'observed' (presence is
    // already observable; vision adds quality signal).
    case 'title':
    case 'description':
    case 'ratings':
    case 'icon':
    case 'competitive':
      return 'observed';
  }
}

/**
 * Returns a deterministic 0-10 score for dimensions that are fully
 * code-computable at Phase A/B. Returns `null` for dimensions that still require
 * model judgment.
 *
 * @param visionResult - Optional B1 vision result; supersedes slot-count for screenshots.
 */
export function codeScore(
  id: DimensionId,
  signals: ListingSignals,
  visionResult?: VisionResult,
): number | null {
  switch (id) {
    case 'previewVideo':
      // Phase-A placeholder: existence only (present → 8, absent → 0). The
      // quality checks (hook / length / works-without-sound) need vision —
      // B1 supersedes this with a quality-aware score (not B1 scope, kept here).
      if (!signals.previewVideo.observable) return null;
      return signals.previewVideo.present ? 8 : 0;

    case 'screenshots':
      // B1: real critiques present → use vision quality score.
      // Parse failure (empty critiques) → honest slot-count fallback.
      if (visionUsable(visionResult)) {
        return visionResult.screenshotSetVerdict.coarseScore;
      }
      return signals.screenshots.slotsUsedOf10;

    case 'ratings': {
      // Deterministic from public rating data — never the model's guess.
      // Covers rubric checks 1–2 (healthy average + recent trend); checks 3–4
      // (complaint themes, developer responses) need deep review analysis (P4)
      // and surface as recommendations, not in this number.
      const avg = signals.ratings.allTimeAverage;
      if (avg === null) return null; // brand-new app, no ratings → let the model handle it
      let score = (avg / 5) * 10; // 0–5 stars → 0–10
      const cur = signals.ratings.currentVersionAverage;
      if (cur !== null) {
        const delta = cur - avg;
        if (delta >= 0.3) score += 1; // improving recent trend
        else if (delta <= -0.3) score -= 1; // declining recent trend
      }
      return Math.max(0, Math.min(10, Math.round(score)));
    }

    default:
      return null;
  }
}

/**
 * Quantize a model-provided 0-10 score to the nearest coarse ordinal (0/5/10)
 * for "mixed" dimensions — ones where utilisation is deterministic but
 * readability/keyword balance still requires model judgment.
 *
 * The utilisation signal provides a deterministic floor: a severely
 * under-utilised field (< 20 % of the character limit) is always 0 regardless
 * of the model's assessment. Otherwise the model's score is snapped to the
 * nearest anchor (0 / 5 / 10), eliminating ±1-3 run-to-run drift.
 *
 * Returns `null` for dimensions that are either purely code-scored or have no
 * coarse-ordinal rule (description, icon, keywordField, etc.).
 */
export function coarseOrdinalScore(
  id: DimensionId,
  modelScore: number,
  signals: ListingSignals,
): number | null {
  switch (id) {
    case 'title':
      // Wide "poor" bucket: only 0-1 → 0. Brand-only short names (Spotify, Rivian)
      // score 2-4 from the model — that's "acceptable, not great" (→ 5), not terrible.
      // Standard < 3 boundary straddled by brand names and caused ±5-point run-to-run drift.
      return snapToOrdinalTitle(modelScore);

    case 'subtitle':
      // Not observable → confidence is 'unavailable'; snapping doesn't matter.
      if (!signals.subtitle.observable) return null;
      return snapToOrdinal(modelScore);

    case 'competitive':
      return snapToOrdinal(modelScore);

    default:
      return null;
  }
}

/** Snap for title: wider "poor" bucket (0–1 → 0) so brand-only names land at 5, not 0. */
function snapToOrdinalTitle(score: number): number {
  if (score < 2) return 0;  // 0-1 → truly terrible
  if (score < 8) return 5;  // 2-7 → acceptable (brand name, short, not keyword-rich)
  return 10;                 // 8-10 → excellent (keyword-optimized)
}

/** Snap a 0-10 model score to the nearest of {0, 5, 10}. */
function snapToOrdinal(score: number): number {
  if (score < 3) return 0; // 0-2 → poor
  if (score < 8) return 5; // 3-7 → acceptable
  return 10;               // 8-10 → excellent
}
