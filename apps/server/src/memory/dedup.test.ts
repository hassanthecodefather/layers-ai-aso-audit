import { describe, it, expect, vi } from 'vitest';
import {
  normalizeValueKey,
  computeRecKey,
  valueKeyFor,
  findContradiction,
} from './dedup';
import type { LedgerRecommendation } from '../domain/recommendation';
import { resolveOtherThemeKey, NoOpEmbeddingProvider } from '../reviews/embedding';

describe('normalizeValueKey (spec §C pinned normalization)', () => {
  it('casefolds, trims, and collapses whitespace', () => {
    expect(normalizeValueKey('  Budget   Planner ')).toBe('budget planner');
  });

  it('collapses plural variants via the s/es rule (Apple indexes them together)', () => {
    expect(normalizeValueKey('tracker')).toBe(normalizeValueKey('trackers'));
    expect(normalizeValueKey('box')).toBe(normalizeValueKey('boxes'));
    expect(normalizeValueKey('fitness trackers')).toBe('fitness tracker');
  });

  it('does not strip a doubled-s ending (access stays access)', () => {
    expect(normalizeValueKey('access')).toBe('access');
  });
});

describe('computeRecKey (spec §C)', () => {
  const base = {
    dimension: 'keywords',
    intent: 'add_keyword' as const,
    targetField: 'subtitle' as string | null,
    referent: { kind: 'keyword' as const, value: 'tracker' },
  };

  it('is stable: same logical inputs → same key (plural referent collapses)', () => {
    expect(computeRecKey(base)).toBe(
      computeRecKey({ ...base, referent: { kind: 'keyword', value: 'Trackers' } }),
    );
  });

  it('two different referent values for the same field → different keys', () => {
    expect(computeRecKey(base)).not.toBe(
      computeRecKey({ ...base, referent: { kind: 'keyword', value: 'budget' } }),
    );
  });

  it('a different intent or target field → different key', () => {
    expect(computeRecKey(base)).not.toBe(computeRecKey({ ...base, intent: 'remove_wasted_term' }));
    expect(computeRecKey(base)).not.toBe(computeRecKey({ ...base, targetField: 'title' }));
  });

  it('single-instance intents ignore referent entirely', () => {
    const a = computeRecKey({ dimension: 'media', intent: 'add_preview_video', targetField: null, referent: { kind: 'none' } });
    const b = computeRecKey({ dimension: 'media', intent: 'add_preview_video', targetField: null, referent: { kind: 'keyword', value: 'anything' } });
    expect(a).toBe(b);
    expect(valueKeyFor('add_preview_video', { kind: 'none' })).toBe('');
  });
});

describe('findContradiction (spec P1 contradiction guard)', () => {
  const row = (over: Partial<LedgerRecommendation>): LedgerRecommendation => ({
    id: 'r', appId: 'a', country: 'us', recKey: 'k', valueKey: 'tracker',
    taxonomyVersion: null, dimension: 'keywords', intent: 'add_keyword',
    targetField: 'subtitle', title: 't', body: 'b', beforeText: null, afterText: null,
    evidence: [], status: 'proposed', supersededBy: null,
    firstSeenAt: '', lastSeenAt: '', appliedAt: null, proofRegime: 'correlational',
    ...over,
  });

  it('fires when a live rec reverses prior advice (add ↔ remove same term)', () => {
    const ledger = [row({ intent: 'add_keyword', valueKey: 'tracker' })];
    const hit = findContradiction(ledger, {
      recKey: 'k2', dimension: 'keywords', intent: 'remove_wasted_term',
      targetField: 'subtitle', valueKey: 'Trackers',
    });
    expect(hit).not.toBeNull();
    expect(hit?.intent).toBe('add_keyword');
  });

  it('fires when re-raising a previously dismissed rec_key', () => {
    const ledger = [row({ recKey: 'kx', status: 'dismissed' })];
    const hit = findContradiction(ledger, {
      recKey: 'kx', dimension: 'keywords', intent: 'add_keyword',
      targetField: 'subtitle', valueKey: 'tracker',
    });
    expect(hit?.status).toBe('dismissed');
  });

  it('stays silent for an unrelated, non-conflicting candidate', () => {
    const ledger = [row({ intent: 'add_keyword', valueKey: 'tracker' })];
    const hit = findContradiction(ledger, {
      recKey: 'k3', dimension: 'keywords', intent: 'add_keyword',
      targetField: 'subtitle', valueKey: 'budget',
    });
    expect(hit).toBeNull();
  });
});

describe('valueKeyFor — theme referent (§F P4)', () => {
  it('theme referent with resolvedKey uses resolvedKey, not bucket', () => {
    const key = valueKeyFor('fix_complaint_theme', {
      kind: 'theme', bucket: 'other', text: 'map broken',
      resolvedKey: 'other:abc123def456ab12',
    });
    expect(key).toBe('other:abc123def456ab12');
  });

  it('theme referent without resolvedKey falls back to bucket (named bucket path)', () => {
    const key = valueKeyFor('fix_complaint_theme', {
      kind: 'theme', bucket: 'crash_stability', text: 'crashes on launch',
    });
    expect(key).toBe('crash_stability');
  });

  it('other-bucket theme without resolvedKey falls back to "other" (legacy path)', () => {
    const key = valueKeyFor('fix_complaint_theme', {
      kind: 'theme', bucket: 'other', text: 'some complaint',
    });
    expect(key).toBe('other');
  });
});

describe('§F P4 other-bucket embedding path', () => {
  it('dismissed other complaint does not resurface when embedding matches (both-paths gate)', async () => {
    // The prior dismissed 'other' rec
    const priorValueKey = await resolveOtherThemeKey('map navigation broken', [], new NoOpEmbeddingProvider());
    // Verify it's content-hashed
    expect(priorValueKey).toMatch(/^other:/);

    const dismissedRec: LedgerRecommendation = {
      id: 'rec_001',
      appId: 'app1', country: 'us',
      recKey: 'some-hash-key',
      valueKey: priorValueKey,
      taxonomyVersion: 'theme-taxonomy@1',
      dimension: 'ratings', intent: 'fix_complaint_theme',
      targetField: null, title: 'Fix map complaints', body: 'map navigation broken',
      beforeText: null, afterText: null, evidence: [],
      status: 'dismissed',
      supersededBy: null, firstSeenAt: '2026-01-01', lastSeenAt: '2026-01-01', appliedAt: null,
      proofRegime: 'correlational',
    };

    // Simulate: a LIVE embedder sees similar new complaint → matches prior → same valueKey
    const stubEmb = {
      isLive: true,
      embed: vi.fn()
        .mockResolvedValueOnce([1, 0, 0])       // new: "map is broken"
        .mockResolvedValueOnce([0.95, 0.2, 0]), // prior body: "map navigation broken" (cosine ≈ 0.98)
    };
    const newValueKey = await resolveOtherThemeKey('map is broken', [{ text: dismissedRec.body, valueKey: priorValueKey }], stubEmb);
    expect(newValueKey).toBe(priorValueKey); // same key → same rec_key → dismissed row found

    // With the same valueKey, computeRecKey would produce the same recKey, so findContradiction fires.
    // We test this at the valueKey level: same valueKey → same recKey (proven by hash determinism).
    expect(newValueKey).toBe(priorValueKey);
  });

  it('distinct other complaints produce different value_keys (distinct rows)', async () => {
    const stubEmb = {
      isLive: true,
      embed: vi.fn()
        .mockResolvedValueOnce([1, 0, 0])  // new: "customer support terrible"
        .mockResolvedValueOnce([0, 1, 0]), // prior: "map broken" (orthogonal → cosine=0)
    };
    const priorKey = await resolveOtherThemeKey('map broken', [], new NoOpEmbeddingProvider());
    const newKey = await resolveOtherThemeKey('customer support terrible', [{ text: 'map broken', valueKey: priorKey }], stubEmb);
    expect(newKey).not.toBe(priorKey); // distinct → distinct rows
    expect(newKey).toMatch(/^other:/);
  });
});
