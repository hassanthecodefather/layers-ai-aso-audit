/**
 * Keyword candidate generation + gap analysis (Phase C2).
 *
 * Pure function of listing + linter result + ASA client.
 * No model call — deterministic derivation from observable text.
 *
 * Gap analysis compares your visible fields (title + subtitle) against
 * competitor names. Competitor keyword fields are never observable so all
 * gap conclusions carry confidence='inferred'.
 *
 * Volume ranking delegates to the AsaClient; under the stub every
 * volume-dependent label reads "popularity unavailable" — the deterministic
 * linter/gap findings still surface.
 */

import type { AppListing } from '../domain/listing';
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

/** Extract tokens from all competitor names (de-duplicated by normalizedKey). */
function competitorTokens(listing: AppListing): Map<string, string> {
  const result = new Map<string, string>();
  for (const c of listing.competitors) {
    for (const [key, raw] of extractTokens(c.name)) {
      if (!result.has(key)) result.set(key, raw);
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

  // ── Query ASA volume for all candidate terms ──────────────────────────────
  const allCandidateKeys = [
    ...descCandidates.map((c) => c.key),
    ...compCandidates.map((c) => c.key),
  ];
  // Deduplicate before querying — don't double-bill the same term.
  const uniqueKeys = [...new Set(allCandidateKeys)];
  const volumeMap = new Map<string, Awaited<ReturnType<AsaClient['getVolume']>>>();
  await Promise.all(
    uniqueKeys.map(async (key) => {
      const vol = await asaClient.getVolume(key, listing.country);
      volumeMap.set(key, vol);
    }),
  );

  const popularityAvailable = [...volumeMap.values()].some((v) => v.available);

  // ── Build candidates list ─────────────────────────────────────────────────
  const candidates: KeywordCandidate[] = [
    ...descCandidates.map(({ key, raw }) => {
      const vol = volumeMap.get(key)!;
      return {
        term: raw,
        normalizedKey: key,
        source: 'description' as const,
        volumeLabel: vol.label,
        volumeAvailable: vol.available,
        ...(vol.available && vol.popularity !== undefined ? { popularity: vol.popularity } : {}),
      };
    }),
    ...compCandidates.map(({ key, raw }) => {
      const vol = volumeMap.get(key)!;
      return {
        term: raw,
        normalizedKey: key,
        source: 'competitor' as const,
        volumeLabel: vol.label,
        volumeAvailable: vol.available,
        ...(vol.available && vol.popularity !== undefined ? { popularity: vol.popularity } : {}),
      };
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
      const vol = volumeMap.get(key) ?? { available: false, label: 'popularity unavailable' };
      gap.push({
        term: raw,
        normalizedKey: key,
        gapCategory: 'yours_only',
        confidence: 'inferred',
        volumeLabel: vol.label,
        volumeAvailable: vol.available,
        ...(vol.available && vol.popularity !== undefined ? { popularity: vol.popularity } : {}),
      });
    }
  }

  // theirs_only: in ≥1 competitor name, absent from your title/subtitle
  for (const [key, raw] of theirTokens) {
    if (!yourTokens.has(key)) {
      const vol = volumeMap.get(key) ?? { available: false, label: 'popularity unavailable' };
      gap.push({
        term: raw,
        normalizedKey: key,
        gapCategory: 'theirs_only',
        confidence: 'inferred',
        volumeLabel: vol.label,
        volumeAvailable: vol.available,
        ...(vol.available && vol.popularity !== undefined ? { popularity: vol.popularity } : {}),
      });
    }
  }

  // shared: in both
  for (const [key, raw] of yourTokens) {
    if (theirTokens.has(key)) {
      const vol = volumeMap.get(key) ?? { available: false, label: 'popularity unavailable' };
      gap.push({
        term: raw,
        normalizedKey: key,
        gapCategory: 'shared',
        confidence: 'inferred',
        volumeLabel: vol.label,
        volumeAvailable: vol.available,
        ...(vol.available && vol.popularity !== undefined ? { popularity: vol.popularity } : {}),
      });
    }
  }

  return { candidates: dedupedCandidates, gap, popularityAvailable };
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

  // Real ASA path (when the key lands): rank by popularity descending.
  const ranked = result.candidates
    .filter((c) => c.volumeAvailable)
    .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));

  return [
    '## Keyword gap analysis',
    `Top candidates by ASA popularity: ${ranked.slice(0, 5).map((c) => `"${c.term}" (${c.popularity})`).join(', ')}`,
    `Competitor gaps: ${result.gap.filter((g) => g.gapCategory === 'theirs_only').map((g) => `"${g.term}" (pop: ${g.popularity ?? 'n/a'})`).join(', ')}`,
  ].join('\n');
}
