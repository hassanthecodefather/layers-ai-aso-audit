/**
 * Keyword candidate generation + gap analysis (Phase C2/C4).
 *
 * Pure function of listing + linter result + keyword provider.
 * No model call — deterministic derivation from observable text.
 *
 * Gap analysis compares your visible fields (title + subtitle) against
 * competitor names. Competitor keyword fields are never observable so all
 * gap conclusions carry confidence='inferred'.
 *
 * Volume ranking delegates to the AsaClient/AppKittieClient behind the seam.
 * Under the stub every volume-dependent label reads "popularity unavailable";
 * with AppKittie the top-N candidates (≤10, credit-capped) are enriched with
 * popularity + difficulty — the deterministic linter/gap findings always surface.
 */

import { z } from 'zod';
import type { AppListing } from '../domain/listing';
import type { ListingSnapshot } from '../domain/snapshot';
import type { AsaClient } from './asa-client';
import type { LinterResult } from './linter';
import { normalizeValueKey } from '../memory/dedup';

// ── Types ────────────────────────────────────────────────────────────────────

export type CandidateSource = 'description' | 'competitor';

export interface KeywordCandidate {
  term: string;
  normalizedKey: string;
  source: CandidateSource;
  /** "popularity unavailable" under the stub; a 0-100 label when the real client is live. */
  volumeLabel: string;
  volumeAvailable: boolean;
  popularity?: number;
  difficulty?: number;
}

export type GapCategory =
  | 'yours_only'  // in your title/subtitle, absent from all competitor names
  | 'theirs_only' // in ≥1 competitor name, absent from your title/subtitle
  | 'shared';     // in both your title/subtitle and ≥1 competitor name

export interface GapRow {
  term: string;
  normalizedKey: string;
  gapCategory: GapCategory;
  /** Always 'inferred' — competitor keyword fields are never observable. */
  confidence: 'inferred';
  volumeLabel: string;
  volumeAvailable: boolean;
  popularity?: number;
  difficulty?: number;
}

export interface CandidateResult {
  /** Keyword suggestions derived from description and competitor names. */
  candidates: KeywordCandidate[];
  /** Yours-only / theirs-only / shared breakdown vs competitor names. */
  gap: GapRow[];
  /** True only when a real ASA key is configured. */
  popularityAvailable: boolean;
}

// ── Wasted-word list (mirrors the linter — must stay in lockstep) ─────────────

const WASTED_WORDS = new Set([
  'app', 'application', 'apps', 'the', 'best', 'top', 'free', 'new',
  'great', 'pro', 'plus', 'premium', 'ultimate', 'easy', 'simple',
  'fast', 'quick', 'smart', 'super', 'amazing', 'awesome', 'cool',
  'good', 'nice', 'better', 'perfect', 'official',
]);

// ── Tokenisation ─────────────────────────────────────────────────────────────

/** Extract meaningful tokens from text (≥3 chars, non-wasted). */
function extractTokens(text: string): Map<string, string> {
  // normalizedKey → earliest raw token
  const result = new Map<string, string>();
  for (const raw of text.split(/[^a-zA-Z]+/)) {
    if (raw.length < 3) continue;
    const key = normalizeValueKey(raw);
    if (!key || WASTED_WORDS.has(key)) continue;
    if (!result.has(key)) result.set(key, raw);
  }
  return result;
}

/** Extract tokens from all competitor names and descriptions (de-duplicated by normalizedKey). */
function competitorTokens(listing: AppListing): Map<string, string> {
  const result = new Map<string, string>();
  for (const c of listing.competitors) {
    const texts = [c.name, c.description].filter(Boolean) as string[];
    for (const text of texts) {
      for (const [key, raw] of extractTokens(text)) {
        if (!result.has(key)) result.set(key, raw);
      }
    }
  }
  return result;
}

// ── Core function ─────────────────────────────────────────────────────────────

export async function generateCandidates(
  listing: AppListing,
  linter: LinterResult,
  asaClient: AsaClient,
): Promise<CandidateResult> {
  // ── Your visible-field keys ───────────────────────────────────────────────
  const yourTokens = extractTokens(listing.name);
  if (listing.subtitle) {
    for (const [key, raw] of extractTokens(listing.subtitle)) {
      if (!yourTokens.has(key)) yourTokens.set(key, raw);
    }
  }

  // ── Competitor name keys ──────────────────────────────────────────────────
  const theirTokens = competitorTokens(listing);

  // ── Description candidates ────────────────────────────────────────────────
  // Tokens in description not already in title+subtitle → potential keyword-field additions.
  const descTokens = extractTokens(listing.description);
  const descCandidates = [...descTokens.entries()]
    .filter(([key]) => !yourTokens.has(key))
    .map(([key, raw]) => ({ key, raw }));

  // ── Competitor-name candidates ────────────────────────────────────────────
  // Competitor tokens absent from your title+subtitle → gaps to consider.
  const compCandidates = [...theirTokens.entries()]
    .filter(([key]) => !yourTokens.has(key))
    .map(([key, raw]) => ({ key, raw }));

  // ── Query volume for candidate terms (capped at 10 for credit control) ───────
  // Competitor-source candidates get priority — they're more likely to be
  // high-volume keywords absent from our metadata. Description candidates
  // fill remaining slots up to the cap. Beyond the cap, candidates surface
  // without volume data (volumeAvailable=false) — still actionable for gap analysis.
  const QUERY_CAP = 10;
  const allCandidateKeys = [
    ...compCandidates.map((c) => c.key), // priority: competitor gaps
    ...descCandidates.map((c) => c.key),
  ];
  const uniqueKeys = [...new Set(allCandidateKeys)];
  const keysToQuery = uniqueKeys.slice(0, QUERY_CAP);

  const volumeMap = new Map<string, Awaited<ReturnType<AsaClient['getVolume']>>>();
  await Promise.all(
    keysToQuery.map(async (key) => {
      const vol = await asaClient.getVolume(key, listing.country);
      volumeMap.set(key, vol);
    }),
  );

  const popularityAvailable = [...volumeMap.values()].some((v) => v.available);

  // ── Build candidates list ─────────────────────────────────────────────────
  const fallbackVol = { available: false, label: 'popularity unavailable' } as const;

  function volFields(vol: Awaited<ReturnType<AsaClient['getVolume']>>) {
    if (!vol.available) return {};
    return {
      ...(vol.popularity !== undefined ? { popularity: vol.popularity } : {}),
      ...(vol.difficulty !== undefined ? { difficulty: vol.difficulty } : {}),
    };
  }

  const candidates: KeywordCandidate[] = [
    ...descCandidates.map(({ key, raw }) => {
      const vol = volumeMap.get(key) ?? fallbackVol;
      return { term: raw, normalizedKey: key, source: 'description' as const, volumeLabel: vol.label, volumeAvailable: vol.available, ...volFields(vol) };
    }),
    ...compCandidates.map(({ key, raw }) => {
      const vol = volumeMap.get(key) ?? fallbackVol;
      return { term: raw, normalizedKey: key, source: 'competitor' as const, volumeLabel: vol.label, volumeAvailable: vol.available, ...volFields(vol) };
    }),
  ];

  // Deduplicate candidates by normalizedKey — a term from description that also
  // appears in a competitor name should only appear once (prefer competitor source).
  const seen = new Set<string>();
  const dedupedCandidates: KeywordCandidate[] = [];
  // Process competitor-sourced first so they take precedence on collision.
  for (const c of [...candidates].sort((a, b) =>
    a.source === 'competitor' && b.source !== 'competitor' ? -1 : 1,
  )) {
    if (!seen.has(c.normalizedKey)) {
      seen.add(c.normalizedKey);
      dedupedCandidates.push(c);
    }
  }

  // ── Gap analysis ──────────────────────────────────────────────────────────
  const gap: GapRow[] = [];

  // yours_only: in your title/subtitle, absent from all competitor names
  for (const [key, raw] of yourTokens) {
    if (!theirTokens.has(key)) {
      const vol = volumeMap.get(key) ?? fallbackVol;
      gap.push({ term: raw, normalizedKey: key, gapCategory: 'yours_only', confidence: 'inferred', volumeLabel: vol.label, volumeAvailable: vol.available, ...volFields(vol) });
    }
  }

  // theirs_only: in ≥1 competitor name, absent from your title/subtitle
  for (const [key, raw] of theirTokens) {
    if (!yourTokens.has(key)) {
      const vol = volumeMap.get(key) ?? fallbackVol;
      gap.push({ term: raw, normalizedKey: key, gapCategory: 'theirs_only', confidence: 'inferred', volumeLabel: vol.label, volumeAvailable: vol.available, ...volFields(vol) });
    }
  }

  // shared: in both
  for (const [key, raw] of yourTokens) {
    if (theirTokens.has(key)) {
      const vol = volumeMap.get(key) ?? fallbackVol;
      gap.push({ term: raw, normalizedKey: key, gapCategory: 'shared', confidence: 'inferred', volumeLabel: vol.label, volumeAvailable: vol.available, ...volFields(vol) });
    }
  }

  return { candidates: dedupedCandidates, gap, popularityAvailable };
}

// ── Candidate result reuse (mirrors selectVisionResult) ──────────────────────

const KeywordCandidateSchema = z.object({
  term: z.string(),
  normalizedKey: z.string(),
  source: z.enum(['description', 'competitor']),
  volumeLabel: z.string(),
  volumeAvailable: z.boolean(),
  popularity: z.number().optional(),
  difficulty: z.number().optional(),
});

const GapRowSchema = z.object({
  term: z.string(),
  normalizedKey: z.string(),
  gapCategory: z.enum(['yours_only', 'theirs_only', 'shared']),
  confidence: z.literal('inferred'),
  volumeLabel: z.string(),
  volumeAvailable: z.boolean(),
  popularity: z.number().optional(),
  difficulty: z.number().optional(),
});

export const CandidateResultSchema = z.object({
  candidates: z.array(KeywordCandidateSchema),
  gap: z.array(GapRowSchema),
  popularityAvailable: z.boolean(),
});

/**
 * Returns the prior CandidateResult from the snapshot if the listing text
 * (name, subtitle, description) and competitor names haven't changed since
 * the prior snapshot. When reused, generateCandidates and its AppKittie
 * calls are skipped entirely — mirroring selectVisionResult for vision.
 *
 * This is a pure function: no side effects, no IO. Unit-testable directly.
 */
export function selectCandidateResult(
  current: AppListing,
  priorSnapshot: ListingSnapshot | null,
): CandidateResult | null {
  if (!priorSnapshot) return null;

  // Validate stored result against schema — catches corrupt or drifted rows.
  const parsed = CandidateResultSchema.safeParse(priorSnapshot.candidateResult);
  if (!parsed.success) return null;

  const prior = priorSnapshot.listing;

  // Compare text fields that feed candidate generation
  if (current.name !== prior.name) return null;
  if ((current.subtitle ?? '') !== (prior.subtitle ?? '')) return null;
  if (current.description !== prior.description) return null;

  // Compare competitor names (sorted — order-independent)
  const currentComps = current.competitors.map((c) => c.name).sort().join('|');
  const priorComps = prior.competitors.map((c) => c.name).sort().join('|');
  if (currentComps !== priorComps) return null;

  return parsed.data as CandidateResult;
}

/**
 * Strips competitor-derived gap rows from a CandidateResult when the resolved
 * identity is cross-domain or escalated. In that case the genre-matched
 * competitors are category peers (e.g. Expedia / Booking for an EV app listed
 * under Travel) and their names produce irrelevant `theirs_only` gap terms.
 *
 * Only `theirs_only` rows are removed — `yours_only` (terms from your own
 * title/subtitle) and `shared` (terms in both) are kept because they're
 * grounded in your listing regardless of competitor quality. Description
 * candidates are always kept.
 *
 * D3 provides function-grounded competitors (identity-seeded via AppKittie) when
 * AppKittie is keyed, making this suppression unnecessary for those runs.
 * This function remains the fallback for un-keyed runs where genre-based
 * competitors from fetchCompetitors may still be cross-domain peers.
 *
 * Pure function — returns a new object, does not mutate input.
 */
export function suppressCompetitorGapTerms(result: CandidateResult): CandidateResult {
  return {
    ...result,
    gap: result.gap.filter((g) => g.gapCategory !== 'theirs_only'),
  };
}

// ── Linter-result accessor for integration (no circular dep) ──────────────────

/**
 * Summarise candidate results for injection into the audit prompt.
 * All conclusions are inferred — neither the competitor keyword field nor the
 * app's own keyword field is observable.
 */
export function formatCandidatesForPrompt(result: CandidateResult): string {
  if (!result.popularityAvailable) {
    // Stub path: surface the gap structure but be honest about missing volume.
    const lines: string[] = [
      '## Keyword gap analysis — deterministic, no model call needed',
      'ASA popularity data: unavailable (key not yet configured). ' +
        'Gap categories are derived from title/subtitle vs competitor names only.',
      'All findings are confidence "inferred" (keyword fields not publicly observable).',
    ];

    const theirs = result.gap.filter((g) => g.gapCategory === 'theirs_only');
    const yours = result.gap.filter((g) => g.gapCategory === 'yours_only');
    const shared = result.gap.filter((g) => g.gapCategory === 'shared');

    if (theirs.length > 0) {
      lines.push(`Competitor terms absent from your title/subtitle (gaps): ${theirs.map((g) => `"${g.term}"`).join(', ')}`);
    }
    if (yours.length > 0) {
      lines.push(`Your differentiators (not in any competitor name): ${yours.map((g) => `"${g.term}"`).join(', ')}`);
    }
    if (shared.length > 0) {
      lines.push(`Shared competitive terms: ${shared.map((g) => `"${g.term}"`).join(', ')}`);
    }

    const descCandidates = result.candidates.filter((c) => c.source === 'description');
    if (descCandidates.length > 0) {
      lines.push(
        `Keyword-field candidates from description (not in title/subtitle): ` +
          descCandidates
            .slice(0, 10)
            .map((c) => `"${c.term}"`)
            .join(', '),
      );
    }

    return lines.join('\n');
  }

  // Volume-enriched path (AppKittie or real ASA): rank by popularity descending.
  // Provenance label is in each candidate's volumeLabel ("AppKittie estimate" or "Apple Search Ads").
  const ranked = result.candidates
    .filter((c) => c.volumeAvailable)
    .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));

  const fmtCandidate = (c: (typeof ranked)[number]) => {
    const parts = [`"${c.term}"`];
    if (c.popularity !== undefined) parts.push(`pop ${c.popularity}/100`);
    if (c.difficulty !== undefined) parts.push(`difficulty ${c.difficulty}/100`);
    return parts.join(' ');
  };

  const theirs = result.gap.filter((g) => g.gapCategory === 'theirs_only');
  const fmtGap = (g: (typeof theirs)[number]) => {
    const parts = [`"${g.term}"`];
    if (g.popularity !== undefined) parts.push(`pop ${g.popularity}/100`);
    return parts.join(' ');
  };

  const lines = [
    '## Keyword gap analysis (AppKittie estimate — confidence "inferred")',
    'All findings are confidence "inferred" (keyword fields not publicly observable).',
  ];

  if (ranked.length > 0) {
    lines.push(`Top candidates by popularity: ${ranked.slice(0, 5).map(fmtCandidate).join(', ')}`);
  }

  if (theirs.length > 0) {
    lines.push(`Competitor terms absent from your title/subtitle (gaps): ${theirs.map(fmtGap).join(', ')}`);
  }

  const yours = result.gap.filter((g) => g.gapCategory === 'yours_only');
  if (yours.length > 0) {
    lines.push(`Your differentiators (not in any competitor name): ${yours.map((g) => `"${g.term}"`).join(', ')}`);
  }

  return lines.join('\n');
}
