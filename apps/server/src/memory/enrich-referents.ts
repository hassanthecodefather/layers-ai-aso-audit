/**
 * D2 CORRECTION · Populate theme/reviewId referents from themeResult.
 *
 * The REFERENT RULES ask the LLM to emit {kind:'theme'} for fix_complaint_theme
 * and {kind:'reviewId'} for respond_to_reviews. When the LLM complies, we
 * override text with the themeResult summary (deterministic — not LLM prose).
 * When the LLM emits {kind:'none'}, we code-derive from themeResult by position.
 *
 * This is the single producer that lights up all three dead paths:
 *   1. Dedup — valueKeyFor fires on theme.bucket instead of collapsing to ''
 *   2. resolvedKey enrichment — guards on referent.kind==='theme' can now fire
 *   3. UI badges — Recommendations.tsx checks referent.kind==='theme'/'reviewId'
 */

import type { Recommendation } from '../domain/audit';
import { ComplaintThemeSchema, type ComplaintTheme } from '../domain/recommendation';
import type { ThemeAnalysisResult } from '../reviews/themes';

export function enrichThemeReferents(
  recommendations: Recommendation[],
  themeResult: ThemeAnalysisResult | null | undefined,
): Recommendation[] {
  const themes = themeResult?.themes ?? [];
  const themeByBucket = new Map(themes.map((t) => [t.bucket, t]));
  const assignedBuckets = new Set<string>();
  let fallbackIdx = 0;

  return recommendations.map((rec) => {
    if (rec.intent === 'fix_complaint_theme') {
      // Prefer the LLM-supplied bucket when it is a valid enum value.
      let bucket: ComplaintTheme | undefined;
      if (rec.referent.kind === 'theme') {
        const parsed = ComplaintThemeSchema.safeParse(rec.referent.bucket);
        if (parsed.success) bucket = parsed.data;
      }
      if (!bucket) {
        // LLM emitted {kind:'none'} or an invalid bucket — assign the next
        // unassigned theme from themeResult in order.
        while (fallbackIdx < themes.length && assignedBuckets.has(themes[fallbackIdx]!.bucket)) {
          fallbackIdx++;
        }
        const next = themes[fallbackIdx];
        if (next) { bucket = next.bucket; fallbackIdx++; }
      }
      if (!bucket) return rec; // themeResult empty — leave {kind:'none'}, all themes collapse (degenerate)
      assignedBuckets.add(bucket);
      // text always comes from themeResult.summary (deterministic across re-audits on
      // the same reviews), never from LLM prose (which varies between runs).
      const text = themeByBucket.get(bucket)?.summary ?? '';
      return { ...rec, referent: { kind: 'theme', bucket, text } };
    }

    if (rec.intent === 'respond_to_reviews') {
      // Keep an already-valid referent (LLM correctly followed the rule).
      if (rec.referent.kind === 'reviewId' && rec.referent.value) return rec;
      // LLM emitted {kind:'none'} — take the first exemplar ID from any theme.
      const firstId = themes.flatMap((t) => t.exemplarReviewIds)[0];
      return firstId ? { ...rec, referent: { kind: 'reviewId', value: firstId } } : rec;
    }

    return rec;
  });
}
