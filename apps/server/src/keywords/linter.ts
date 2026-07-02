/**
 * 160-char keyword linter (Phase C1 + C3).
 *
 * Deterministic analysis of the three ASO text fields:
 *   title (30) + subtitle (30) + keyword field (100) = 160 chars total
 *
 * The keyword field is never publicly observable, so its 100-char budget is
 * analysed by inference: words already used in title/subtitle are wasted there.
 * All keyword-field conclusions are labelled `inferred` by the caller.
 *
 * C3 script-aware: if > 20 % of title chars are CJK or RTL codepoints the
 * mechanics are suppressed and `scriptSupported = false` is returned —
 * callers must label findings "script not yet supported".
 */

import { normalizeValueKey } from '../memory/dedup';

export const TITLE_LIMIT = 30;
export const SUBTITLE_LIMIT = 30;
export const KEYWORD_FIELD_LIMIT = 100;
export const TOTAL_BUDGET = TITLE_LIMIT + SUBTITLE_LIMIT + KEYWORD_FIELD_LIMIT;

export type TokenField = 'title' | 'subtitle';

export type FlagReason =
  | 'cross_field_duplicate'  // same token already in a higher-priority field
  | 'plural_redundant'       // singular and plural of same root in same field
  | 'wasted_word';           // generic term with no keyword value

export interface TokenFlag {
  term: string;
  normalizedKey: string;
  field: TokenField;
  reason: FlagReason;
  /** Chars freed if this term were removed or replaced. Includes a separator. */
  reclaimableChars: number;
}

export interface LinterResult {
  /** False when title uses CJK/RTL script — all mechanics suppressed. */
  scriptSupported: boolean;
  titleUsed: number;
  subtitleUsed: number;
  /** Always null — keyword field is not publicly observable. */
  keywordFieldUsed: null;
  totalCharsBudget: number;
  /** Estimated chars wasted in the keyword field (title+subtitle overlap). */
  estimatedKeywordWaste: number;
  /** Sum of all flag.reclaimableChars. */
  reclaimableChars: number;
  flags: TokenFlag[];
}

export interface LinterInput {
  title: string;
  /** Null when subtitle is not crawled (unobservable). */
  subtitle: string | null;
  /** Always null — iOS keyword field is not publicly observable. */
  keywordField: string | null;
}

// Generic filler terms that waste keyword budget and rarely help ranking.
// Apple's guidelines also advise against these.
const WASTED_WORDS = new Set([
  'app', 'application', 'apps', 'the', 'best', 'top', 'free', 'new',
  'great', 'pro', 'plus', 'premium', 'ultimate', 'easy', 'simple',
  'fast', 'quick', 'smart', 'super', 'amazing', 'awesome', 'cool',
  'good', 'nice', 'better', 'perfect', 'official',
]);

// ── Script detection (C3) ────────────────────────────────────────────────────

function isCjkOrRtlCodePoint(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0x3040 && cp <= 0x30ff) || // Hiragana + Katakana
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0x3000 && cp <= 0x303f) || // CJK Symbols and Punctuation
    (cp >= 0x0600 && cp <= 0x06ff) || // Arabic
    (cp >= 0x0590 && cp <= 0x05ff)    // Hebrew
  );
}

/** True when the text is Latin-script (mechanics apply). */
function isLatinScript(text: string): boolean {
  if (!text) return true;
  let nonLatin = 0;
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    if (isCjkOrRtlCodePoint(cp)) nonLatin++;
  }
  return nonLatin / text.length < 0.2;
}

// ── Tokenisation ─────────────────────────────────────────────────────────────

/** Split text into tokens (≥ 3 chars, alphabetical). */
function tokenize(text: string): string[] {
  return text.split(/[^a-zA-Z]+/).filter((t) => t.length >= 3);
}

// ── Core linter ──────────────────────────────────────────────────────────────

export function runLinter(input: LinterInput): LinterResult {
  const titleUsed = input.title.length;
  const subtitleUsed = input.subtitle?.length ?? 0;

  if (!isLatinScript(input.title)) {
    return {
      scriptSupported: false,
      titleUsed,
      subtitleUsed,
      keywordFieldUsed: null,
      totalCharsBudget: TOTAL_BUDGET,
      estimatedKeywordWaste: 0,
      reclaimableChars: 0,
      flags: [],
    };
  }

  const flags: TokenFlag[] = [];

  // ── Title pass ────────────────────────────────────────────────────────────
  const titleTokens = tokenize(input.title);

  // Build a map: normalizedKey → earliest raw term in the title.
  const titleNormMap = new Map<string, string>();
  for (const term of titleTokens) {
    const key = normalizeValueKey(term);
    if (!titleNormMap.has(key)) titleNormMap.set(key, term);
  }

  // Wasted words in title.
  for (const [key, term] of titleNormMap) {
    if (WASTED_WORDS.has(key)) {
      flags.push({
        term,
        normalizedKey: key,
        field: 'title',
        reason: 'wasted_word',
        reclaimableChars: term.length + 1,
      });
    }
  }

  // Plural redundancy within title.
  const titleKeys = [...titleNormMap.keys()];
  for (let i = 0; i < titleKeys.length; i++) {
    for (let j = i + 1; j < titleKeys.length; j++) {
      const a = titleKeys[i]!;
      const b = titleKeys[j]!;
      // Both normalise to the same key only if the depluralize step collapses them.
      // Since normalizeValueKey already depluralized, two identical normalized keys
      // from different raw tokens signal a plural pair.
      if (a === b) {
        // The second occurrence is redundant.
        const redundantRaw = titleNormMap.get(b) ?? b;
        flags.push({
          term: redundantRaw,
          normalizedKey: b,
          field: 'title',
          reason: 'plural_redundant',
          reclaimableChars: redundantRaw.length + 1,
        });
      }
    }
  }

  // ── Subtitle pass ─────────────────────────────────────────────────────────
  const subtitleNormMap = new Map<string, string>();

  if (input.subtitle) {
    const subtitleTokens = tokenize(input.subtitle);
    for (const term of subtitleTokens) {
      const key = normalizeValueKey(term);
      if (!subtitleNormMap.has(key)) subtitleNormMap.set(key, term);
    }

    for (const [key, term] of subtitleNormMap) {
      if (titleNormMap.has(key)) {
        // Same root already in title → coverage wasted in subtitle.
        flags.push({
          term,
          normalizedKey: key,
          field: 'subtitle',
          reason: 'cross_field_duplicate',
          reclaimableChars: term.length + 1,
        });
      } else if (WASTED_WORDS.has(key)) {
        flags.push({
          term,
          normalizedKey: key,
          field: 'subtitle',
          reason: 'wasted_word',
          reclaimableChars: term.length + 1,
        });
      }
    }

    // Plural redundancy within subtitle (excluding cross-field dups already flagged).
    const subKeys = [...subtitleNormMap.keys()];
    for (let i = 0; i < subKeys.length; i++) {
      for (let j = i + 1; j < subKeys.length; j++) {
        const a = subKeys[i]!;
        const b = subKeys[j]!;
        if (a === b && !titleNormMap.has(a)) {
          const redundantRaw = subtitleNormMap.get(b) ?? b;
          flags.push({
            term: redundantRaw,
            normalizedKey: b,
            field: 'subtitle',
            reason: 'plural_redundant',
            reclaimableChars: redundantRaw.length + 1,
          });
        }
      }
    }
  }

  // ── Keyword-field inference ───────────────────────────────────────────────
  // Any title/subtitle token would be wasted if placed in the keyword field —
  // Apple's algorithm ignores keyword-field terms already present in title/subtitle.
  // Estimate how many chars are at risk of being wasted there.
  const allObservedKeys = new Set([...titleNormMap.keys(), ...subtitleNormMap.keys()]);
  let estimatedKeywordWaste = 0;
  for (const key of allObservedKeys) {
    // Conservative: each potentially-wasted key costs its own length + comma.
    estimatedKeywordWaste += key.length + 1;
  }
  // Cap at the keyword field limit — we can't know how much the dev uses.
  estimatedKeywordWaste = Math.min(estimatedKeywordWaste, KEYWORD_FIELD_LIMIT);

  const reclaimableChars = flags.reduce((s, f) => s + f.reclaimableChars, 0);

  return {
    scriptSupported: true,
    titleUsed,
    subtitleUsed,
    keywordFieldUsed: null,
    totalCharsBudget: TOTAL_BUDGET,
    estimatedKeywordWaste,
    reclaimableChars,
    flags,
  };
}
