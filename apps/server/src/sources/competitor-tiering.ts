/**
 * F-K3 · Competitor tiering + per-keyword gap mapping.
 *
 * Deterministic, pure — no LLM, no new API calls.
 * Tags each D3 peer as `direct | indirect | organic-search` so the scorer can
 * weight competitor observations accordingly.
 *
 * Provenance: `estimated` — AppKittie panel data, not Apple-authoritative.
 * Tier label: inferred from store genre match (pure code, no model).
 *
 * Per-keyword gap: assembled from the existing CandidateResult.gap — `theirs_only`
 * terms are competitor tokens already extracted from their listings.
 */

import type { Competitor } from '../domain/listing';
import type { CandidateResult, GapRow } from '../keywords/candidates';

// ── Types ─────────────────────────────────────────────────────────────────────

export type CompetitorTier = 'direct' | 'indirect' | 'organic-search';

export interface TieredCompetitor {
  competitor: Competitor;
  /**
   * direct        — same App Store primaryGenre as our app (head-on competitor)
   * indirect      — different category but ranks for our seed keywords (D3-sourced)
   * organic-search — keyword-only overlap (non-D3 / genre-based fallback peers)
   */
  tier: CompetitorTier;
}

/**
 * A keyword that competitors have but we don't, with a list of which competitor
 * names are likely to surface it (approximated from their description tokens).
 */
export interface KeywordGapWithCompetitors {
  term: string;
  /** Names of competitors whose descriptions contain this term. */
  competitorNames: string[];
  /** Provenance label — always `estimated` (panel data, not Apple-verified). */
  provenance: 'estimated';
}

export interface CompetitorTieringResult {
  tiered: TieredCompetitor[];
  /** `theirs_only` gap terms annotated with likely-contributing competitor names. */
  keywordGaps: KeywordGapWithCompetitors[];
}

// ── Tiering ───────────────────────────────────────────────────────────────────

/**
 * Tier competitors by store genre match against our app's primaryGenre.
 *
 * - `direct`        — same primaryGenre (head-on; highest weight)
 * - `indirect`      — different genre, D3-sourced (still keyword-relevant)
 * - `organic-search` — caller may pass non-D3 competitors (genre-based);
 *                      D3 peers are always at least `indirect`.
 */
export function tierCompetitors(
  competitors: Competitor[],
  ourPrimaryGenre: string | null,
  /** If false, treat tier as `organic-search` (non-D3 peers). */
  fromD3 = true,
): TieredCompetitor[] {
  return competitors.map((competitor) => {
    if (!fromD3) {
      return { competitor, tier: 'organic-search' };
    }
    const tier: CompetitorTier =
      ourPrimaryGenre &&
      competitor.primaryGenre &&
      competitor.primaryGenre.toLowerCase() === ourPrimaryGenre.toLowerCase()
        ? 'direct'
        : 'indirect';
    return { competitor, tier };
  });
}

// ── Per-keyword gap mapping ───────────────────────────────────────────────────

/**
 * For each `theirs_only` gap term, find which competitors likely surface it by
 * scanning their descriptions (observable, zero-cost, no extra API calls).
 *
 * Approximation: a competitor "surfaces" a term if its description contains it
 * as a word boundary match. Provenance is always `estimated` because we're
 * inferring rank from description presence, not measuring actual Apple ranks.
 */
export function mapKeywordGapsToCompetitors(
  gaps: GapRow[],
  tiered: TieredCompetitor[],
): KeywordGapWithCompetitors[] {
  const theirsOnly = gaps.filter((g) => g.gapCategory === 'theirs_only');
  if (theirsOnly.length === 0 || tiered.length === 0) return [];

  return theirsOnly.map((gap) => {
    const termLower = gap.term.toLowerCase();
    const matching = tiered
      .filter(({ competitor }) => {
        const desc = (competitor.description ?? '').toLowerCase();
        const name = competitor.name.toLowerCase();
        // Word-boundary match: term appears as a standalone token
        const wordBoundary = new RegExp(`\\b${termLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
        return wordBoundary.test(desc) || wordBoundary.test(name);
      })
      .map(({ competitor }) => competitor.name);

    return {
      term: gap.term,
      competitorNames: matching,
      provenance: 'estimated' as const,
    };
  });
}

/**
 * Assemble the full tiering result from D3 competitors + candidate gaps.
 */
export function buildCompetitorTieringResult(
  competitors: Competitor[],
  ourPrimaryGenre: string | null,
  candidateResult: CandidateResult | null | undefined,
  fromD3 = true,
): CompetitorTieringResult {
  const tiered = tierCompetitors(competitors, ourPrimaryGenre, fromD3);
  const keywordGaps = candidateResult
    ? mapKeywordGapsToCompetitors(candidateResult.gap, tiered)
    : [];
  return { tiered, keywordGaps };
}

// ── Prompt section ────────────────────────────────────────────────────────────

const TIER_LABEL: Record<CompetitorTier, string> = {
  direct: 'Direct',
  indirect: 'Indirect',
  'organic-search': 'Organic-search',
};

/**
 * Format the tiering result for injection into the audit prompt.
 * Returns empty string when no data is available.
 */
export function formatCompetitorTieringForPrompt(
  result: CompetitorTieringResult | null | undefined,
): string {
  if (!result || result.tiered.length === 0) return '';

  const lines: string[] = [
    '## Competitor tiers (provenance: inferred from store data)',
    '',
  ];

  for (const { competitor, tier } of result.tiered) {
    const rating =
      competitor.averageRating != null
        ? `★${competitor.averageRating.toFixed(1)}`
        : 'no rating';
    lines.push(
      `- **${competitor.name}** [${TIER_LABEL[tier]}] — ${competitor.primaryGenre ?? 'unknown genre'}, ${rating}`,
    );
  }

  if (result.keywordGaps.length > 0) {
    lines.push('');
    lines.push(
      '### Competitor keyword gaps (theirs-only — labeled `estimated`, panel data)',
    );
    lines.push('These terms appear in competitor listings but not yours:');
    lines.push('');
    for (const gap of result.keywordGaps) {
      const by = gap.competitorNames.length > 0
        ? ` — seen in: ${gap.competitorNames.join(', ')}`
        : '';
      lines.push(`- \`${gap.term}\`${by}`);
    }
  }

  return lines.join('\n');
}
