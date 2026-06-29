import type { Recommendation } from '../domain/audit';
import type { AuditDraft } from '../domain/audit';
import type { DimensionId } from '../domain/audit';
import type { IntentTag } from '../domain/recommendation';
import { SINGLE_INSTANCE_INTENTS } from '../domain/recommendation';
import type { ListingSignals } from './signals';

/**
 * Canonical dimension for each single-instance intent. The model must never
 * author the dimension component of a rec_key — it is derived from the intent
 * by this table. Without this, the same intent can map to different rec_keys
 * across runs (e.g. improve_description_hook under "description" then
 * "conversion"), adding spurious rows to the ledger.
 */
export const CANONICAL_DIMENSION: Partial<Record<IntentTag, DimensionId>> = {
  add_preview_video:        'previewVideo',
  enable_promo_text:        'conversion',
  rebalance_title_subtitle: 'title',
  reposition_identity:      'competitive',
  improve_icon_legibility:  'icon',
  reorder_screenshots:      'screenshots',
  respond_to_reviews:       'ratings',
  fix_complaint_theme:      'ratings',
  improve_description_hook: 'description',
};

/**
 * Code-derived existence gates for structural recs. The signal (not the model)
 * decides whether the rec exists — prompt instructions can be ignored; code
 * cannot. Only covers intents with a directly observable boolean signal at
 * Phase A. Keyword and content-quality recs remain model-driven. Icon
 * legibility requires vision (Phase B) so its gate is always false here.
 */
export function structuralExistenceGates(
  signals: ListingSignals,
): Partial<Record<IntentTag, boolean>> {
  return {
    add_preview_video:        signals.previewVideo.observable && !signals.previewVideo.present,
    enable_promo_text:        !signals.conversion.hasPromotionalText,
    reorder_screenshots:      signals.screenshots.slotsUsedOf10 < 8,
    rebalance_title_subtitle: signals.title.utilizationPct < 70,
    improve_icon_legibility:  false,
  };
}

const DEFAULT_TITLE: Partial<Record<IntentTag, string>> = {
  add_preview_video:        'Add a preview video to show the app in context',
  enable_promo_text:        'Enable promotional text to surface timely messaging above the fold',
  reorder_screenshots:      'Fill all available screenshot slots to maximise visual real estate',
  rebalance_title_subtitle: 'Redistribute keywords across title and subtitle to improve character utilisation',
};

function defaultRec(intent: IntentTag, dimension: DimensionId): Recommendation {
  return {
    category: 'quick-win',
    dimension,
    intent,
    referent: { kind: 'none' },
    title: DEFAULT_TITLE[intent] ?? intent,
    rationale: 'Derived from observable listing signals.',
    evidence: 'Signal-gated: code-determined from listing data.',
    before: null,
    after: null,
  };
}

/**
 * Normalize a model-generated draft so no rec_key component is a free model
 * choice:
 *   1. Remap single-instance rec dimensions to their canonical value (lookup
 *      table, never the model's text).
 *   2. Deduplicate same-intent single-instance recs — after remapping they
 *      all share a canonical dimension, so keep the first (best-phrased) one.
 *   3. Enforce structural gates: inject a default rec when the signal fires
 *      but the model omitted it; remove a rec when the signal is absent but
 *      the model emitted it anyway.
 */
export function normalizeRecommendations(
  draft: AuditDraft,
  signals: ListingSignals,
): AuditDraft {
  const gates = structuralExistenceGates(signals);

  // 1. Canonical dimension
  const remapped: Recommendation[] = draft.recommendations.map((rec) => {
    const canonical = CANONICAL_DIMENSION[rec.intent];
    return canonical ? { ...rec, dimension: canonical } : rec;
  });

  // 2. Deduplicate single-instance recs
  const seen = new Set<IntentTag>();
  const deduped: Recommendation[] = [];
  for (const rec of remapped) {
    if (SINGLE_INSTANCE_INTENTS.has(rec.intent)) {
      if (seen.has(rec.intent)) continue;
      seen.add(rec.intent);
    }
    deduped.push(rec);
  }

  // 3. Structural gates — inject / remove
  for (const [intentStr, shouldExist] of Object.entries(gates)) {
    const intent = intentStr as IntentTag;
    const canonical = CANONICAL_DIMENSION[intent];
    if (!canonical) continue;
    const idx = deduped.findIndex((r) => r.intent === intent);
    if (shouldExist && idx === -1) {
      deduped.push(defaultRec(intent, canonical));
    } else if (!shouldExist && idx !== -1) {
      deduped.splice(idx, 1);
    }
  }

  return { ...draft, recommendations: deduped };
}
