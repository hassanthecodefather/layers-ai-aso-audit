import type { Divergence } from '../domain/identity';

/**
 * Coarse "domain" classification of a category string, and the ordinal
 * divergence between two of them (spec ID "Conflict yields low" + §E).
 *
 * This is the deterministic core of the escalation gate: it is what decides
 * that Rivian's *declared* category (Travel) and its *function* category
 * (electric-vehicle companion) sit in different domains → `cross_domain` → the
 * one band that escalates. It is keyword-based and intentionally conservative:
 * an unmappable string never manufactures a cross-domain conflict (which would
 * over-escalate), it degrades to "can't tell" → no hard gate.
 */

/** Top-level domains and the keywords that map a category/function string in. */
const DOMAINS: Record<string, readonly string[]> = {
  automotive: ['vehicle', 'car', 'automotive', 'ev', 'electric vehicle', 'truck', 'charging', 'charge', 'driving', 'tesla', 'auto'],
  travel: ['travel', 'trip', 'hotel', 'flight', 'booking', 'itinerary', 'tourism', 'vacation'],
  navigation: ['navigation', 'maps', 'gps', 'directions'],
  music: ['music', 'song', 'audio', 'playlist', 'podcast'],
  // "streaming" deliberately omitted — it's ambiguous (music streams too) and
  // would shadow the music domain on a string like "music streaming".
  video_social: ['video', 'social', 'entertainment', 'short-form', 'short video', 'reels', 'photo', 'feed', 'creator'],
  messaging: ['messaging', 'chat', 'messenger', 'sms'],
  productivity: ['productivity', 'todo', 'to-do', 'to do', 'task', 'notes', 'note-taking', 'calendar', 'reminder', 'organizer', 'organiser'],
  finance: ['finance', 'banking', 'bank', 'payments', 'wallet', 'budget', 'investing', 'crypto'],
  health: ['health', 'fitness', 'workout', 'medical', 'meditation', 'sleep', 'nutrition'],
  shopping: ['shopping', 'commerce', 'retail', 'marketplace', 'store', 'deals'],
  food: ['food', 'recipe', 'restaurant', 'delivery', 'grocery', 'cooking'],
  games: ['game', 'gaming', 'rpg', 'puzzle', 'arcade', 'gacha'],
  education: ['education', 'learning', 'course', 'language learning', 'study', 'flashcard'],
  dating: ['dating', 'match', 'relationship'],
  news: ['news', 'magazine', 'journal'],
  utilities: ['utility', 'utilities', 'tool', 'widget', 'scanner', 'vpn'],
  business: ['business', 'crm', 'enterprise', 'invoicing'],
};

/**
 * The single domain a category/function string belongs to, or `null` if no
 * keyword matches. Longest keyword wins, so "electric vehicle" beats a stray
 * "vehicle" elsewhere and multi-word cues aren't shadowed by single words.
 */
export function domainOf(category: string): string | null {
  const text = category.toLowerCase();
  let best: { domain: string; len: number } | null = null;
  for (const [domain, keywords] of Object.entries(DOMAINS)) {
    for (const kw of keywords) {
      // Word-boundary match so "auto" doesn't fire on "automation", and the
      // longest matching keyword wins (multi-word cues beat single words).
      const re = new RegExp(`\\b${kw.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`);
      if (re.test(text) && (!best || kw.length > best.len)) {
        best = { domain, len: kw.length };
      }
    }
  }
  return best?.domain ?? null;
}

/**
 * Divergence between the store-declared category and the function-derived
 * category (spec ID). `none` when they map to the same domain (or we can't
 * tell), `cross_domain` when they map to genuinely different domains — the
 * only band that triggers the hard escalation gate.
 */
export function divergenceBetween(
  storeCategory: string,
  functionCategory: string,
): Divergence {
  const a = domainOf(storeCategory);
  const b = domainOf(functionCategory);
  // Unmappable on either side → don't manufacture a conflict.
  if (a == null || b == null) return 'none';
  if (a === b) return 'none';
  // Two clearly-different domains is the cross-domain conflict that escalates.
  // (A within-domain note — e.g. productivity → note-taking — never reaches
  // here because both map to the same top-level domain and return `none`.)
  return 'cross_domain';
}
