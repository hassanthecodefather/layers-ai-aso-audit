/**
 * D2 CORRECTION tests — enrichThemeReferents
 *
 * The plan's missing guard: assert referent.kind survives the full pipeline
 * (LLM produces {kind:'none'} → enrichment → distinct rec_keys end-to-end).
 * Tests inject kind:'none' referents to simulate the LLM ignoring the rule,
 * mirroring the real failure mode discovered in live testing.
 */

import { describe, it, expect } from 'vitest';
import { enrichThemeReferents } from './enrich-referents';
import { computeRecKey } from './dedup';
import type { Recommendation } from '../domain/audit';
import type { ThemeAnalysisResult, ClassifiedTheme } from '../reviews/themes';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeThemeResult(themes: ClassifiedTheme[]): ThemeAnalysisResult {
  return { themes, versionDelta: null, featureRequests: [], sampleSize: 50, taxonomyVersion: 'theme-taxonomy@1' };
}

function makeRec(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    category: 'quick-win',
    dimension: 'ratings',
    intent: 'fix_complaint_theme',
    referent: { kind: 'none' },
    title: 'Fix complaint',
    rationale: 'There are complaints',
    evidence: 'Review data',
    before: null,
    after: null,
    ...overrides,
  };
}

// ── D2 CORRECTION tests ───────────────────────────────────────────────────────

describe('enrichThemeReferents — D2 CORRECTION', () => {
  it('two fix_complaint_theme recs with kind:none → two distinct rec_keys via themeResult', () => {
    const themeResult = makeThemeResult([
      { bucket: 'ads_intrusive', summary: 'Too many ads every session', count: 5, exemplarReviewIds: ['r1'], isUnresolved: false },
      { bucket: 'crash_stability', summary: 'App crashes on launch', count: 3, exemplarReviewIds: ['r2'], isUnresolved: false },
    ]);

    const enriched = enrichThemeReferents([
      makeRec({ title: 'Fix ads', referent: { kind: 'none' } }),
      makeRec({ title: 'Fix crashes', referent: { kind: 'none' } }),
    ], themeResult);

    expect(enriched[0]!.referent.kind).toBe('theme');
    expect(enriched[1]!.referent.kind).toBe('theme');

    // The critical end-to-end assertion: two distinct complaint themes → two distinct rec_keys
    const key0 = computeRecKey({ dimension: 'ratings', intent: 'fix_complaint_theme', targetField: null, referent: enriched[0]!.referent });
    const key1 = computeRecKey({ dimension: 'ratings', intent: 'fix_complaint_theme', targetField: null, referent: enriched[1]!.referent });
    expect(key0).not.toBe(key1);
  });

  it('LLM-supplied valid bucket is preserved; text is overridden from themeResult summary', () => {
    const themeResult = makeThemeResult([
      { bucket: 'ads_intrusive', summary: 'Too many ads every session', count: 5, exemplarReviewIds: ['r1'], isUnresolved: false },
    ]);

    // Simulate LLM following the rule: {kind:'theme', bucket:'ads_intrusive', text: 'LLM prose'}
    const rec = makeRec({ referent: { kind: 'theme', bucket: 'ads_intrusive', text: 'LLM prose — should be overridden' } });
    const [enriched] = enrichThemeReferents([rec], themeResult);

    expect(enriched!.referent.kind).toBe('theme');
    if (enriched!.referent.kind === 'theme') {
      expect(enriched!.referent.bucket).toBe('ads_intrusive');
      // text comes from themeResult, not the LLM (deterministic across re-audits)
      expect(enriched!.referent.text).toBe('Too many ads every session');
    }
  });

  it('LLM-supplied invalid bucket falls back to positional assignment from themeResult', () => {
    const themeResult = makeThemeResult([
      { bucket: 'pricing_subscription', summary: 'Subscription too expensive', count: 4, exemplarReviewIds: ['r3'], isUnresolved: false },
    ]);

    // Simulate LLM hallucinating a bucket not in the enum
    const rec = makeRec({ referent: { kind: 'theme', bucket: 'made_up_bucket' as never, text: 'whatever' } });
    const [enriched] = enrichThemeReferents([rec], themeResult);

    expect(enriched!.referent.kind).toBe('theme');
    if (enriched!.referent.kind === 'theme') {
      expect(enriched!.referent.bucket).toBe('pricing_subscription');
      expect(enriched!.referent.text).toBe('Subscription too expensive');
    }
  });

  it('respond_to_reviews kind:none → reviewId from first themeResult exemplar', () => {
    const themeResult = makeThemeResult([
      { bucket: 'ads_intrusive', summary: 'Too many ads', count: 5, exemplarReviewIds: ['r1', 'r2'], isUnresolved: false },
    ]);

    const rec = makeRec({ intent: 'respond_to_reviews', title: 'Respond to complaints' });
    const [enriched] = enrichThemeReferents([rec], themeResult);

    expect(enriched!.referent.kind).toBe('reviewId');
    if (enriched!.referent.kind === 'reviewId') {
      expect(enriched!.referent.value).toBe('r1');
    }
  });

  it('respond_to_reviews with existing reviewId is unchanged', () => {
    const themeResult = makeThemeResult([
      { bucket: 'crash_stability', summary: 'Crashes', count: 2, exemplarReviewIds: ['r9'], isUnresolved: false },
    ]);

    const rec = makeRec({ intent: 'respond_to_reviews', referent: { kind: 'reviewId', value: 'already-set-id' } });
    const [enriched] = enrichThemeReferents([rec], themeResult);

    expect(enriched!.referent.kind).toBe('reviewId');
    if (enriched!.referent.kind === 'reviewId') {
      expect(enriched!.referent.value).toBe('already-set-id');
    }
  });

  it('null themeResult — kind:none recs stay as-is (degenerate: theme analysis failed)', () => {
    const rec = makeRec();
    const [enriched] = enrichThemeReferents([rec], null);
    expect(enriched!.referent.kind).toBe('none');
  });

  it('does not assign the same bucket twice — third rec stays kind:none when themes exhausted', () => {
    const themeResult = makeThemeResult([
      { bucket: 'ads_intrusive', summary: 'Too many ads', count: 5, exemplarReviewIds: [], isUnresolved: false },
      { bucket: 'crash_stability', summary: 'App crashes', count: 3, exemplarReviewIds: [], isUnresolved: false },
    ]);

    const recs = [makeRec(), makeRec(), makeRec()]; // 3 recs but only 2 themes
    const enriched = enrichThemeReferents(recs, themeResult);

    const themeBuckets = enriched
      .filter((r) => r.referent.kind === 'theme')
      .map((r) => (r.referent as { bucket: string }).bucket);
    // No duplicates among the assigned buckets
    expect(new Set(themeBuckets).size).toBe(themeBuckets.length);
    // Third rec has no theme left — stays kind:'none'
    expect(enriched[2]!.referent.kind).toBe('none');
  });

  it('non-theme intents pass through unchanged', () => {
    const themeResult = makeThemeResult([
      { bucket: 'ads_intrusive', summary: 'Too many ads', count: 5, exemplarReviewIds: ['r1'], isUnresolved: false },
    ]);

    const rec = makeRec({ intent: 'add_keyword', referent: { kind: 'keyword', value: 'tracker' } });
    const [enriched] = enrichThemeReferents([rec], themeResult);

    expect(enriched!.referent.kind).toBe('keyword');
  });
});
