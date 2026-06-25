import type { AppListing } from '../domain/listing';
import type { ListingSignals } from './signals';
import { RUBRIC } from './rubric';

/**
 * Prompt construction for the audit.
 *
 * Pure functions — listing + signals in, prompt string out — so the exact
 * text the model sees is reviewable and testable. The prompt is structured:
 * raw text fields, the authoritative signals fact sheet, competitors and
 * reviews, the rubric, then the required JSON shape.
 */

const cap = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

function textFields(listing: AppListing): string {
  const crawled = listing.provenance.crawler;
  return [
    `Title: ${JSON.stringify(listing.name)}`,
    `Developer: ${JSON.stringify(listing.developer)}`,
    `Subtitle: ${
      crawled
        ? JSON.stringify(listing.subtitle)
        : 'NOT OBSERVABLE (no page crawler) — score "unavailable"'
    }`,
    `Promotional text: ${
      crawled
        ? JSON.stringify(listing.promotionalText)
        : 'NOT OBSERVABLE (no page crawler)'
    }`,
    `Preview video present: ${
      crawled
        ? String(listing.hasPreviewVideo)
        : 'NOT OBSERVABLE (no page crawler) — score "unavailable"'
    }`,
    `Primary genre: ${listing.primaryGenre ?? 'unknown'}`,
    `Price: ${listing.formattedPrice ?? 'unknown'}`,
    `Version: ${listing.version ?? 'unknown'}`,
    `What's New: ${
      listing.releaseNotes
        ? JSON.stringify(cap(listing.releaseNotes, 600))
        : 'none'
    }`,
    '',
    'Description:',
    cap(listing.description, 2400),
  ].join('\n');
}

function reviewSample(listing: AppListing): string {
  if (listing.reviews.length === 0) return 'No reviews available.';
  return listing.reviews
    .slice(0, 15)
    .map(
      (r) => `- [${r.rating}★] ${JSON.stringify(r.title)} — ${cap(r.body, 220)}`,
    )
    .join('\n');
}

function competitors(listing: AppListing): string {
  if (listing.competitors.length === 0) {
    return 'No competitor data available.';
  }
  return listing.competitors
    .map((c) => {
      const rating =
        c.averageRating != null
          ? `${c.averageRating.toFixed(1)}★ (${c.ratingCount ?? '?'})`
          : 'unrated';
      return `- ${c.name} by ${c.developer} — ${rating}, ${c.screenshotCount} screenshots, ${c.formattedPrice ?? 'price unknown'}`;
    })
    .join('\n');
}

function rubricChecks(): string {
  return RUBRIC.map(
    (d) =>
      `${d.label} (id: ${d.id}${d.charLimit ? `, ${d.charLimit}-char limit` : ''}):\n` +
      d.checks.map((c) => `  - ${c}`).join('\n'),
  ).join('\n');
}

/** The exact JSON structure the auditor must return. */
export const AUDIT_JSON_SHAPE = `{
  "headline": "<one-sentence verdict on the listing overall>",
  "dimensions": [
    {
      "id": "<title|subtitle|keywordField|description|screenshots|previewVideo|ratings|icon|conversion|competitive>",
      "score": <number 0-10>,
      "confidence": "<observed|inferred|unavailable>",
      "findings": "<1-2 sentences>",
      "evidence": ["<concrete data point>", "..."]
    }
    // EXACTLY 10 entries — one for each id listed above
  ],
  "recommendations": [
    {
      "category": "<quick-win|high-impact|strategic>",
      "dimension": "<one of the 10 dimension ids>",
      "intent": "<pick exactly one: add_keyword|remove_wasted_term|rebalance_title_subtitle|reposition_identity|improve_icon_legibility|reorder_screenshots|add_preview_video|localise_storefront|respond_to_reviews|fix_complaint_theme|improve_description_hook|enable_promo_text>",
      "referent": "<see rules below>",
      "title": "<the change, as an imperative>",
      "rationale": "<why it matters, citing the evidence>",
      "evidence": "<the specific data point behind it>",
      "before": "<current text — or null for non-text changes>",
      "after": "<proposed text — or null for non-text changes>"
    }
    // 9-15 entries, spread across the three categories
  ],
  "competitorComparison": {
    "summary": "<a short paragraph>",
    "rows": [
      { "name": "<competitor>", "rating": "<e.g. 4.7 (1.2M)>", "positioning": "<one phrase>", "edge": "<what they do better, or —>" }
    ]
  },
  "limitations": ["<what could not be assessed from public data, and why>"]
}

REFERENT RULES — the referent field pins the recommendation's identity for deduplication:
- intent is add_keyword or remove_wasted_term  → {"kind":"keyword","value":"<the single keyword, lowercase>"}
- intent is localise_storefront               → {"kind":"country","value":"<2-letter ISO country code>"}
- ALL other intents                           → {"kind":"none"}
There is at most ONE recommendation per (dimension, intent, referent) combination. For example,
two add_keyword suggestions for the subtitle must have different referent.value keywords.`;

/** The full per-listing audit prompt. */
export function buildAuditPrompt(
  listing: AppListing,
  signals: ListingSignals,
  priorContext?: string,
): string {
  return [
    `Audit this App Store listing: "${listing.name}" by ${listing.developer}.`,
    `Store: ${listing.country.toUpperCase()} · ${listing.url}`,
    '',
    // The resolved identity fact sheet + prior-audit history (P1 memory),
    // injected the same way the deterministic signals are, so the model
    // interprets a grounded identity and its own past advice rather than
    // re-deriving either from the (possibly misleading) listing.
    ...(priorContext ? ['## Identity & prior-audit memory — AUTHORITATIVE', priorContext, ''] : []),
    '## Text fields',
    textFields(listing),
    '',
    '## Signals fact sheet — AUTHORITATIVE, use these numbers verbatim',
    JSON.stringify(signals, null, 2),
    '',
    '## Category competitors',
    competitors(listing),
    '',
    '## Recent review sample',
    reviewSample(listing),
    '',
    '## Rubric — score each dimension 0-10 against these checks',
    rubricChecks(),
    '',
    '## Output',
    'Respond with ONLY a JSON object — no prose, no explanation, no markdown ' +
      'code fences — matching exactly this structure:',
    AUDIT_JSON_SHAPE,
    '',
    'Cite concrete signals as evidence; give before/after text for every ' +
      'text change. Do not compute an overall score — only the per-dimension ' +
      'scores.',
  ].join('\n');
}

/** A follow-up prompt asking the model to fix a malformed response. */
export function buildRepairPrompt(
  badOutput: string,
  errorDetail: string,
): string {
  return [
    'Your previous response did not match the required JSON structure.',
    '',
    `Problem: ${errorDetail}`,
    '',
    'Your previous response was:',
    cap(badOutput, 4000),
    '',
    'Return a corrected JSON object now. Output ONLY the JSON — no prose, no ' +
      'markdown fences — matching exactly this structure:',
    AUDIT_JSON_SHAPE,
  ].join('\n');
}
