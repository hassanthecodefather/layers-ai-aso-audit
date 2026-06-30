import { createHash } from 'node:crypto';
import {
  type IntentTag,
  type Referent,
  type LedgerRecommendation,
  SINGLE_INSTANCE_INTENTS,
} from '../domain/recommendation';

/**
 * Recommendation identity + dedup — "P1's hard part" (spec §C).
 *
 * `rec_key = hash(dimension, intent, target_field, value_key)` — NOT the
 * wording — so two runs that produce the same suggestion phrased differently
 * map to one row (an upsert, not a duplicate), while two genuinely different
 * suggestions for the same field stay distinct (the `value_key` discriminator).
 */

/**
 * Pinned `value_key` normalization (spec §C): casefold + Unicode NFC + trim,
 * plus the linter's own plural rule (s/es) so "tracker" and "trackers" collapse
 * to one key — Apple indexes singular and plural together. Applied per token so
 * phrases ("fitness trackers" → "fitness tracker") normalize too. Deliberately
 * NOT full stemming, which would over-collapse distinct words.
 */
export function normalizeValueKey(raw: string): string {
  const base = raw.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!base) return '';
  return base
    .split(' ')
    .map(depluralize)
    .join(' ');
}

/** The linter's plural rule (s/es), applied to a single token. */
function depluralize(token: string): string {
  // "boxes" → "box", "watches" → "watch": -es after s/x/z/ch/sh.
  if (/(?:s|x|z|ch|sh)es$/.test(token) && token.length > 4) {
    return token.slice(0, -2);
  }
  // plain plural "-s", but never "-ss" (e.g. "access" stays "access").
  if (/[^s]s$/.test(token) && token.length > 3) {
    return token.slice(0, -1);
  }
  return token;
}

export interface RecKeyInput {
  dimension: string;
  intent: IntentTag;
  targetField: string | null;
  /** The typed referent; single-instance intents always produce an empty value_key. */
  referent: Referent;
}

/**
 * The stable `rec_key`. `value_key` is derived from the typed referent (never
 * from the model's prose), and forced empty for single-instance intents, so a
 * single-instance intent can never accidentally fork on a stray value.
 */
export function computeRecKey(input: RecKeyInput): string {
  const valueKey = valueKeyFor(input.intent, input.referent);
  const parts = [
    input.dimension.trim().toLowerCase(),
    input.intent,
    (input.targetField ?? '').trim().toLowerCase(),
    valueKey,
  ];
  // NUL-joined so field boundaries can't be forged by a value containing the
  // separator, then hashed for a fixed-width, opaque key.
  return createHash('sha256').update(parts.join(' ')).digest('hex').slice(0, 32);
}

/**
 * The normalized `value_key` stored alongside a rec. Derived from the typed
 * referent — never from `after`/`title` prose — so a model that rewords the
 * same suggestion still lands on the same key.
 */
export function valueKeyFor(intent: IntentTag, referent: Referent): string {
  if (SINGLE_INSTANCE_INTENTS.has(intent) || referent.kind === 'none') return '';
  if (referent.kind === 'theme') return referent.resolvedKey ?? referent.bucket; // resolvedKey used for 'other' bucket; named buckets fall back to bucket
  return normalizeValueKey(referent.value); // keyword, country, reviewId
}

/** Intents that directly reverse one another (spec §C contradiction guard). */
const OPPOSING_INTENTS: Partial<Record<IntentTag, IntentTag>> = {
  add_keyword: 'remove_wasted_term',
  remove_wasted_term: 'add_keyword',
};

/**
 * The contradiction guard (spec P1): before emitting a recommendation, check it
 * against the ledger and refuse to silently reverse past advice. Fires when
 * either:
 *  - the ledger holds a rec for the **same field+value** with the **opposing
 *    intent** (add ↔ remove the same term), or
 *  - this exact `rec_key` was previously **dismissed** and is being re-raised.
 * Returns the conflicting row, or null if the candidate is clean.
 */
export function findContradiction(
  ledger: readonly LedgerRecommendation[],
  candidate: Pick<
    LedgerRecommendation,
    'recKey' | 'dimension' | 'intent' | 'targetField' | 'valueKey'
  >,
): LedgerRecommendation | null {
  const opposing = OPPOSING_INTENTS[candidate.intent];
  const candValue = normalizeValueKey(candidate.valueKey);
  for (const row of ledger) {
    // Re-raising advice the user explicitly dismissed.
    if (row.recKey === candidate.recKey && row.status === 'dismissed') {
      return row;
    }
    // Reversing live advice on the same target+value.
    if (
      opposing &&
      row.intent === opposing &&
      row.dimension === candidate.dimension &&
      (row.targetField ?? '') === (candidate.targetField ?? '') &&
      normalizeValueKey(row.valueKey) === candValue &&
      row.status !== 'dismissed'
    ) {
      return row;
    }
  }
  return null;
}
