import { describe, it, expect } from 'vitest';
import {
  normalizeValueKey,
  computeRecKey,
  valueKeyFor,
  findContradiction,
} from './dedup';
import type { LedgerRecommendation } from '../domain/recommendation';

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
    valueKey: 'tracker',
  };

  it('is stable: same logical inputs → same key', () => {
    expect(computeRecKey(base)).toBe(computeRecKey({ ...base, valueKey: 'Trackers' }));
  });

  it('two different value_keys for the same field → different keys', () => {
    expect(computeRecKey(base)).not.toBe(computeRecKey({ ...base, valueKey: 'budget' }));
  });

  it('a different intent or target field → different key', () => {
    expect(computeRecKey(base)).not.toBe(computeRecKey({ ...base, intent: 'remove_wasted_term' }));
    expect(computeRecKey(base)).not.toBe(computeRecKey({ ...base, targetField: 'title' }));
  });

  it('single-instance intents ignore value_key entirely', () => {
    const a = computeRecKey({ dimension: 'media', intent: 'add_preview_video', targetField: null, valueKey: 'anything' });
    const b = computeRecKey({ dimension: 'media', intent: 'add_preview_video', targetField: null, valueKey: 'other' });
    expect(a).toBe(b);
    expect(valueKeyFor('add_preview_video', 'anything')).toBe('');
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
