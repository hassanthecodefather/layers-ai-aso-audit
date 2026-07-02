import type { IntentTag, ProofRegime } from '../domain/recommendation';

/**
 * Connect-to-measure honesty manifest (spec §F / plan Phase F).
 *
 * Maps each intent to the tightest proof regime available in the beta.
 * Intent-level granularity beats dimension-level because intents within
 * the same dimension can have different proof paths — e.g. `reorder_screenshots`
 * requires a PPO visual test while `fix_complaint_theme` under the ratings
 * dimension is measurable via public rating drift (correlational).
 *
 * The four regimes, ordered from tightest to loosest:
 *  ppo_causal    — PPO A/B visual test (North Star, not yet available)
 *  funnel_asc    — App Store Connect funnel metrics (P7, not yet keyed)
 *  correlational — public keyword-rank / rating drift (available now, directional)
 *  observable_now — directly visible in the next public listing snapshot
 */
const INTENT_PROOF_REGIME: Record<IntentTag, ProofRegime> = {
  // Directly observable in the next public listing snapshot
  localise_storefront:      'observable_now',
  respond_to_reviews:       'observable_now',
  enable_promo_text:        'observable_now',

  // Measurable via public keyword-rank / rating drift (directional)
  add_keyword:              'correlational',
  remove_wasted_term:       'correlational',
  rebalance_title_subtitle: 'correlational',
  reposition_identity:      'correlational',
  fix_complaint_theme:      'correlational',
  improve_description_hook: 'correlational',

  // Requires PPO A/B visual testing to isolate the causal effect
  improve_icon_legibility:  'ppo_causal',
  reorder_screenshots:      'ppo_causal',
  add_preview_video:        'ppo_causal',
};

export function assignProofRegime(intent: IntentTag): ProofRegime {
  return INTENT_PROOF_REGIME[intent] ?? 'correlational';
}
