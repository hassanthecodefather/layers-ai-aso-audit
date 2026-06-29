import type { AppListing } from '../domain/listing';
import type { ListingSignals } from './signals';
import type { VisionResult } from '../vision/types';
import { RUBRIC } from './rubric';
import { codeScore } from './dimension-scorer';

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


/**
 * Build the scoring-constraints note injected after the signals fact sheet.
 *
 * Some dimension scores are fully determined by code from the signals — the
 * model's number is discarded and replaced. Telling the model this prevents
 * inconsistency between its findings text ("7 slots → solid") and the actual
 * displayed score. It also tells the model to restrict title/subtitle to the
 * three coarse anchors the code enforces, so quantization never contradicts
 * the narrative.
 */
function scoringConstraints(signals: ListingSignals, visionResult?: VisionResult): string {
  const lines: string[] = [
    '## Scoring constraints — these values are computed in code and override yours',
    '',
    'Your `score` field for the dimensions below MUST exactly match the value shown.',
    'Do not adjust them — they come from the fact sheet, not from judgment.',
    'Write `findings` and `evidence` that explain *why* the number matters.',
    '',
  ];

  // screenshots: vision-assessed score when vision ran; slot-count fallback otherwise.
  const sc = signals.screenshots.slotsUsedOf10;
  if (visionResult && visionResult.screenshotSetVerdict.critiques.length > 0) {
    const vs = visionResult.screenshotSetVerdict.coarseScore;
    lines.push(`• screenshots  → ${vs}  (vision-assessed; ${sc} of 10 slots used — use ALL per-slot critiques from the Vision analysis section as separate evidence items, one per slot)`);
  } else if (visionResult) {
    // Vision ran but JSON parse failed — no real critique data; fall back to slot count.
    lines.push(`• screenshots  → ${sc}  (vision parse failed; slotsUsedOf10 = ${sc} of 10 available)`);
  } else {
    lines.push(`• screenshots  → ${sc}  (slotsUsedOf10 = ${sc} of 10 available)`);
  }

  // previewVideo: delegate to codeScore — single source of truth
  const pvScore = codeScore('previewVideo', signals);
  if (pvScore !== null) {
    lines.push(
      `• previewVideo → ${pvScore}  (${signals.previewVideo.present ? 'present → 8' : 'absent → 0'}; quality checks need vision, deferred to Phase B)`,
    );
  } else {
    lines.push(
      '• previewVideo → set confidence "unavailable" (page not crawled — presence unknown)',
    );
  }

  // ratings: delegate to codeScore — single source of truth
  const rScore = codeScore('ratings', signals);
  if (rScore !== null) {
    const r = signals.ratings;
    const cv = r.currentVersionAverage;
    const nudge =
      cv !== null && r.allTimeAverage !== null && Math.abs(cv - r.allTimeAverage) >= 0.3
        ? cv > r.allTimeAverage ? 1 : -1
        : 0;
    const nudgeNote =
      nudge > 0 ? ', +1 improving-trend nudge' : nudge < 0 ? ', −1 declining-trend nudge' : '';
    lines.push(
      `• ratings      → ${rScore}  (${r.allTimeAverage!.toFixed(2)}★ all-time × 2${nudgeNote})`,
    );
  } else {
    lines.push('• ratings      → score by judgment (no rating data yet)');
  }

  // title: utilisation floor forces 0; otherwise restrict to {0, 5, 10}
  const titleUtil = signals.title.utilizationPct;
  if (titleUtil < 20) {
    lines.push(`• title        → 0  (utilisation floor: ${titleUtil}% < 20% — near-empty field)`);
  } else {
    lines.push('• title        — score ONLY as 0, 5, or 10 (never any other value)');
  }

  // subtitle: unobservable → unavailable; floor at <20%; otherwise restrict to {0, 5, 10}
  const sub = signals.subtitle;
  if (!sub.observable) {
    lines.push('• subtitle     → set confidence "unavailable" (page not crawled)');
  } else if (sub.utilizationPct < 20) {
    lines.push(`• subtitle     → 0  (utilisation floor: ${sub.utilizationPct}% < 20% — near-empty field)`);
  } else {
    lines.push('• subtitle     — score ONLY as 0, 5, or 10 (never any other value)');
  }

  lines.push('');
  lines.push(
    'Anchor meanings: 0 = poor (near-empty, keyword-stuffed, or unreadable) · 5 = acceptable (functional but improvable) · 10 = excellent (optimised, natural, distinctive).',
  );
  lines.push('Use the same three-level language in your findings so the text matches the score.');

  return lines.join('\n');
}

/**
 * Format the vision result into a human-readable section the LLM can cite
 * as evidence in findings. Called only when vision ran.
 */
function visionFacts(v: VisionResult): string {
  const lines: string[] = [
    '## Vision analysis — Gemini examined your screenshots and icon',
  ];
  const sv = v.screenshotSetVerdict;

  // Only suppress the limitation when Gemini actually produced critiques.
  // If parse failed (critiques empty), the limitation is real and must surface.
  if (sv.critiques.length > 0) {
    lines.push('IMPORTANT: Do NOT list "Screenshot Content" or "Icon Visuals" as limitations — Gemini has already assessed these. Use the analysis below as evidence in your findings.');
  }

  lines.push(`Screenshots overall: ${sv.coarseScore}/10 (${sv.confidence})`);

  if (sv.critiques.length > 0) {
    lines.push('Per-slot critique:');
    for (const c of sv.critiques) {
      lines.push(
        `  Slot ${c.slot}: value-prop clarity — ${c.valuePropClarity.value}; ` +
          `readability — ${c.readability.value}; cohesion — ${c.cohesion.value}`,
      );
    }
  }

  if (sv.competitorComparison.value) {
    lines.push(`Competitor comparison: ${sv.competitorComparison.value}`);
  }

  if (v.iconVerdict) {
    const iv = v.iconVerdict;
    lines.push(
      `Icon: category cohesion — ${iv.categoryCohesion.value}; ` +
        `confusability — ${iv.confusable.value}; ` +
        `pHash distance to nearest competitor — ${iv.pHashDistance.value} (${iv.pHashDistance.confidence})`,
    );
  }

  return lines.join('\n');
}

/** The full per-listing audit prompt. */
export function buildAuditPrompt(
  listing: AppListing,
  signals: ListingSignals,
  priorContext?: string,
  visionResult?: VisionResult,
): string {
  return [
    `Audit this App Store listing: "${listing.name}" by ${listing.developer}.`,
    `Store: ${listing.country.toUpperCase()} · ${listing.url}`,
    '',
    // The resolved identity fact sheet (identity grounding only — no ledger).
    // Generation is a pure function of (listing + identity); the recommendation
    // ledger is read after generation in the memory reconciliation layer.
    ...(priorContext ? ['## Identity context — AUTHORITATIVE', priorContext, ''] : []),
    '## Text fields',
    textFields(listing),
    '',
    '## Signals fact sheet — AUTHORITATIVE, use these numbers verbatim',
    JSON.stringify(signals, null, 2),
    '',
    scoringConstraints(signals, visionResult),
    '',
    ...(visionResult ? [visionFacts(visionResult), ''] : []),
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
