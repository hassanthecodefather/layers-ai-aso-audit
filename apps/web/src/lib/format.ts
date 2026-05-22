/** Small presentation helpers shared across the report components. */

export interface Tone {
  bar: string;
  text: string;
  badge: string;
}

/** Map a 0-10 score to a colour tone. */
export function scoreTone(score: number): Tone {
  if (score >= 8) {
    return {
      bar: 'bg-emerald-400',
      text: 'text-emerald-300',
      badge: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
    };
  }
  if (score >= 6) {
    return {
      bar: 'bg-lime-400',
      text: 'text-lime-300',
      badge: 'bg-lime-500/15 text-lime-300 ring-lime-500/30',
    };
  }
  if (score >= 4) {
    return {
      bar: 'bg-amber-400',
      text: 'text-amber-300',
      badge: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
    };
  }
  return {
    bar: 'bg-rose-400',
    text: 'text-rose-300',
    badge: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
  };
}

/** Tone for the overall 0-100 score. */
export function overallTone(score: number): Tone {
  return scoreTone(score / 10);
}

/** Compact a large rating count, e.g. 39946904 → "39.9M". */
export function formatCount(n: number | null): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Format an average rating to one decimal, or an em dash. */
export function formatRating(n: number | null): string {
  return n == null ? '—' : n.toFixed(1);
}

const CONFIDENCE_LABEL: Record<string, string> = {
  observed: 'observed',
  inferred: 'inferred',
  unavailable: 'not assessed',
};

export function confidenceLabel(confidence: string): string {
  return CONFIDENCE_LABEL[confidence] ?? confidence;
}
