/**
 * F-K2 · Competitor review mining.
 *
 * Runs the Phase-D theme engine over top competitors' 1–2★ reviews.
 * Their pain points = keyword/feature differentiation opportunities for us.
 * Provenance: observed (real reviews, directly cited).
 *
 * Cost note: one combined `analyzeThemes` LLM call, cached 2h via the gateway.
 * Gated on D3 having provided function-grounded competitors (no genre-mismatch
 * noise). Skipped when no competitors are available.
 */

import type { Competitor } from '../domain/listing';
import type { LlmProvider } from '../llm';
import type { ListingSnapshot } from '../domain/snapshot';
import { fetchReviews } from '../sources/itunes';
import { analyzeThemes } from '../reviews/themes';
import { z } from 'zod';

/** Max competitors to mine (keeps LLM + review-fetch costs bounded). */
const MAX_COMPETITORS = 3;

/** Max reviews fetched per competitor (1–2★ only; further filtered after fetch). */
const REVIEWS_PER_COMPETITOR = 50;

/** Low-rating threshold — we only care about pain points. */
const LOW_RATING_MAX = 2;

export interface CompetitorPainPoint {
  /** Complaint bucket from the theme engine. */
  bucket: string;
  /** Theme description text. */
  text: string;
  /** Number of 1–2★ reviews in this bucket. */
  reviewCount: number;
  /** Names of competitors whose reviews surfaced this theme. */
  competitors: string[];
}

export interface CompetitorMiningResult {
  /** Ranked pain points — each is a keyword/feature opportunity for you. */
  painPoints: CompetitorPainPoint[];
  /** Names of the competitors actually mined. */
  competitorsCovered: string[];
  /** Total 1–2★ competitor reviews analyzed. */
  lowRatingReviewCount: number;
}

/**
 * Mine top competitors' low-rating reviews for pain points.
 *
 * Returns null when no reviews were found or the result is uninformative
 * (no pain-point themes surfaced).
 */
export async function mineCompetitorReviews(
  competitors: Competitor[],
  country: string,
  llm: LlmProvider,
  _analyzeOverride?: typeof analyzeThemes,
  _fetchReviewsOverride?: typeof fetchReviews,
): Promise<CompetitorMiningResult | null> {
  if (competitors.length === 0) return null;

  const doFetch = _fetchReviewsOverride ?? fetchReviews;
  const toMine = competitors.slice(0, MAX_COMPETITORS);
  const competitorNames: string[] = [];
  const allLowRatingReviews: Array<{ review: import('../domain/listing').Review; competitorName: string }> = [];

  // Fetch reviews sequentially — pacer applies, cached 2h by the gateway.
  for (const competitor of toMine) {
    try {
      const reviews = await doFetch(
        { appId: competitor.appId, country },
        REVIEWS_PER_COMPETITOR,
      );
      const lowRating = reviews.filter((r) => r.rating <= LOW_RATING_MAX);
      if (lowRating.length > 0) {
        competitorNames.push(competitor.name);
        for (const review of lowRating) {
          allLowRatingReviews.push({ review, competitorName: competitor.name });
        }
      }
    } catch {
      // Individual competitor fetch failures are silent — audit continues.
    }
  }

  if (allLowRatingReviews.length === 0) return null;

  const analyze = _analyzeOverride ?? analyzeThemes;

  let themeResult;
  try {
    themeResult = await analyze(
      allLowRatingReviews.map((r) => r.review),
      llm,
    );
  } catch {
    return null;
  }

  if (themeResult.themes.length === 0) return null;

  // Map themes → pain points, annotating which competitors surfaced each.
  const painPoints: CompetitorPainPoint[] = themeResult.themes.map((theme) => {
    // Which competitors contributed reviews to this theme?
    // The theme engine assigns buckets but doesn't tag which review is in which
    // bucket. We fall back to listing all competitors whose reviews were in the
    // combined pool (conservative, never attributing to someone not in the set).
    const contributors = [...new Set(allLowRatingReviews.map((r) => r.competitorName))];
    return {
      bucket: theme.bucket,
      text: theme.text,
      reviewCount: theme.reviewIds.length,
      competitors: contributors,
    };
  });

  return {
    painPoints,
    competitorsCovered: competitorNames,
    lowRatingReviewCount: allLowRatingReviews.length,
  };
}

/**
 * Format the competitor mining result for injection into the audit prompt.
 * Returns empty string when no result is available.
 */
export function formatCompetitorMiningForPrompt(
  mining: CompetitorMiningResult | null | undefined,
): string {
  if (!mining || mining.painPoints.length === 0) return '';

  const lines: string[] = [
    `## Competitor pain points — ${mining.lowRatingReviewCount} low-rating reviews from ${mining.competitorsCovered.join(', ')} (provenance: observed)`,
    'These are their complaints — each is a differentiation opportunity or keyword gap for you.',
    '',
  ];

  for (const pt of mining.painPoints) {
    lines.push(`- **${pt.bucket}** (${pt.reviewCount} reviews): ${pt.text}`);
  }

  lines.push('');
  lines.push(
    'When generating recommendations, surface 1–2 of the most actionable pain points as ' +
      'keyword or feature-gap opportunities (intent: `add_keyword` or `add_feature_proof`). ' +
      'Provenance for competitor-sourced findings is `observed`.',
  );

  return lines.join('\n');
}

// ── Reuse (mirrors selectCandidateResult / selectVisionResult pattern) ────────

const CompetitorMiningResultSchema = z.object({
  painPoints: z.array(z.object({
    bucket: z.string(),
    text: z.string(),
    reviewCount: z.number(),
    competitors: z.array(z.string()),
  })),
  competitorsCovered: z.array(z.string()),
  lowRatingReviewCount: z.number(),
});

/**
 * Return the stored competitor mining result when D3 competitors haven't changed,
 * so unchanged re-audits skip the LLM+review-fetch pass.
 */
export function selectCompetitorMining(
  currentCompetitors: Competitor[],
  priorSnap: ListingSnapshot | null | undefined,
): CompetitorMiningResult | null {
  if (!priorSnap?.competitorMiningResult) return null;

  // Cache is valid when D3 competitor set (appIds) is unchanged.
  const currentIds = new Set(currentCompetitors.map((c) => c.appId));
  const storedIds = new Set(
    (priorSnap.listing.competitors ?? []).map((c) => c.appId),
  );
  if (currentIds.size !== storedIds.size) return null;
  for (const id of currentIds) {
    if (!storedIds.has(id)) return null;
  }

  const parsed = CompetitorMiningResultSchema.safeParse(priorSnap.competitorMiningResult);
  return parsed.success ? parsed.data : null;
}
