/**
 * F-K1 · Keyword opportunity ranking (plan Phase F).
 *
 * Turns the existing candidate + gap sets into a deterministic ranked target
 * list — the "structured deliverable" the raw candidates section lacks.
 *
 * Score = relevance(keyword ↔ resolved function) × volume ÷ difficulty.
 * Volume is NOT squared (fights the long-tail-for-young-apps strategy).
 * Brand terms are handled specially: defence of your own name is high-value
 * at any volume, so they bypass the formula and are ranked first.
 *
 * Every finding carries a provenance label:
 *  'observed'  — keyword appears in title/subtitle (visible field)
 *  'inferred'  — derived from description text or competitor names
 *  'estimated' — volume/difficulty supplied by AppKittie (panel data, not Apple)
 */

import type { CandidateResult } from './candidates';
import type { ResolvedIdentity } from '../identity/resolve';
import { normalizeValueKey } from '../memory/dedup';

// ── Types ─────────────────────────────────────────────────────────────────────

/** The four intent tiers — tags, not fixed percentage allocations. */
export type KeywordTier = 'core-intent' | 'feature' | 'competitor' | 'problem';

export interface RankedKeyword {
  term: string;
  normalizedKey: string;
  tier: KeywordTier;
  /** True when the keyword is a subset of the app name tokens (brand-defence case). */
  isBrand: boolean;
  /** 0-1 estimate of how well the keyword maps to the app's resolved function. */
  relevance: number;
  popularity: number | null;  // 0-100 or null when AppKittie unavailable
  difficulty: number | null;  // 0-100 or null when AppKittie unavailable
  /** Heuristic: relevance × (pop ?? 50) / max(diff ?? 50, 1). Never "math that proves". */
  opportunityScore: number;
  /** Gap position vs competitors (for competitor-tier keywords). */
  gapCategory?: 'yours_only' | 'theirs_only' | 'shared';
  provenance: 'observed' | 'inferred' | 'estimated';
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Tokenise text into normalised 3+ char tokens. */
function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split(/[^a-zA-Z0-9]+/)) {
    if (raw.length >= 3) out.add(normalizeValueKey(raw));
  }
  return out;
}

/**
 * Fraction of `normalizedKey` tokens found in `identityTokens`.
 * A keyword that exactly matches the niche scores 1.0; one with no overlap
 * scores 0 — which is floor-raised to 0.2 so non-identity keywords still
 * participate in the ranking.
 */
function computeRelevance(normalizedKey: string, identityTokens: Set<string>): number {
  const terms = normalizedKey.split(' ').filter((t) => t.length >= 3);
  if (terms.length === 0) return 0.2;
  const matches = terms.filter((t) => identityTokens.has(t)).length;
  return Math.max(matches / terms.length, 0.2);
}

/** Heuristic score. Volume floored to 1, difficulty floored to 1 to avoid ÷0. */
function computeScore(
  relevance: number,
  popularity: number | null,
  difficulty: number | null,
): number {
  const vol = Math.max(popularity ?? 50, 1);
  const diff = Math.max(difficulty ?? 50, 1);
  return relevance * (vol / diff);
}

function assignTier(
  relevance: number,
  isBrand: boolean,
  gapCategory?: string,
): KeywordTier {
  if (isBrand || relevance >= 0.6) return 'core-intent';
  if (gapCategory === 'theirs_only') return 'competitor';
  return 'feature';
}

// ── Public surface ────────────────────────────────────────────────────────────

/**
 * Rank keyword candidates by relevance-weighted opportunity score.
 *
 * @param candidates  Output of `generateCandidates` / `selectCandidateResult`.
 * @param resolved    The audited app's resolved identity (provides the function grounding).
 * @param appName     The app's display name (for brand-defence detection).
 */
export function rankOpportunities(
  candidates: CandidateResult,
  resolved: ResolvedIdentity,
  appName: string,
): RankedKeyword[] {
  const identityText = `${resolved.niche ?? ''} ${resolved.category ?? ''}`;
  const identityTokens = tokenize(identityText);
  const appNameTokens = tokenize(appName);

  const seen = new Set<string>();
  const results: RankedKeyword[] = [];

  function add(
    term: string,
    normalizedKey: string,
    popularity: number | null,
    difficulty: number | null,
    gapCategory?: 'yours_only' | 'theirs_only' | 'shared',
    baseProvenance: 'observed' | 'inferred' = 'inferred',
  ) {
    if (!normalizedKey || seen.has(normalizedKey)) return;
    seen.add(normalizedKey);

    const termTokens = normalizedKey.split(' ').filter((t) => t.length >= 3);
    const isBrand =
      termTokens.length > 0 && termTokens.every((t) => appNameTokens.has(t));

    const relevance = isBrand
      ? 0.9
      : computeRelevance(normalizedKey, identityTokens);

    const score = computeScore(relevance, popularity, difficulty);
    const tier = assignTier(relevance, isBrand, gapCategory);

    // Volume/difficulty data from AppKittie → estimated; pure text analysis → inferred.
    const provenance: RankedKeyword['provenance'] =
      popularity !== null ? 'estimated' : baseProvenance;

    results.push({
      term,
      normalizedKey,
      tier,
      isBrand,
      relevance: Math.round(relevance * 100) / 100,
      popularity: popularity ?? null,
      difficulty: difficulty ?? null,
      opportunityScore: Math.round(score * 100) / 100,
      gapCategory,
      provenance,
    });
  }

  // Gap rows first (they include competitor-sourced signal)
  for (const gap of candidates.gap) {
    add(
      gap.term,
      gap.normalizedKey,
      gap.popularity ?? null,
      gap.difficulty ?? null,
      gap.gapCategory,
      'inferred',
    );
  }

  // Candidates from description
  for (const c of candidates.candidates) {
    add(
      c.term,
      c.normalizedKey,
      c.popularity ?? null,
      c.difficulty ?? null,
      undefined,
      'inferred',
    );
  }

  // Sort: brand terms first, then by opportunity score descending.
  return results.sort((a, b) => {
    if (a.isBrand !== b.isBrand) return a.isBrand ? -1 : 1;
    return b.opportunityScore - a.opportunityScore;
  });
}

/** Prompt-ready rendering of the top-N ranked keywords. */
export function formatOpportunitiesForPrompt(ranked: RankedKeyword[], top = 15): string {
  if (ranked.length === 0) return '';
  const rows = ranked.slice(0, top).map((k) => {
    const volPart = k.popularity !== null ? `pop ${k.popularity}/100` : 'pop unavailable';
    const diffPart = k.difficulty !== null ? `diff ${k.difficulty}/100` : '';
    const gapNote =
      k.gapCategory === 'theirs_only'
        ? ' [competitor gap — they have it, you don\'t]'
        : k.gapCategory === 'yours_only'
          ? ' [yours only — not in competitor titles]'
          : '';
    const brandNote = k.isBrand ? ' [brand-defence]' : '';
    const stats = [volPart, diffPart].filter(Boolean).join(', ');
    return `  • "${k.term}" [${k.tier}${brandNote}${gapNote}] score=${k.opportunityScore} rel=${k.relevance} ${stats} (${k.provenance})`;
  });

  return [
    '\n=== Keyword Opportunity Ranking (F-K1) ===',
    `Top ${Math.min(ranked.length, top)} of ${ranked.length} candidates by relevance × volume ÷ difficulty.`,
    'Scores are heuristic — never treat them as proven measurement.',
    '',
    ...rows,
  ].join('\n');
}
