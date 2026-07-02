import { describe, it, expect } from 'vitest';
import { runLinter, TOTAL_BUDGET, type LinterInput } from './linter';

// ── Helpers ──────────────────────────────────────────────────────────────────

function input(overrides: Partial<LinterInput> = {}): LinterInput {
  return {
    title: 'Rivian',
    subtitle: null,
    keywordField: null,
    ...overrides,
  };
}

// ── C3: Script detection ──────────────────────────────────────────────────────

describe('script detection (C3)', () => {
  it('returns scriptSupported=true for Latin-script title', () => {
    expect(runLinter(input({ title: 'Rivian' })).scriptSupported).toBe(true);
  });

  it('returns scriptSupported=false for CJK title (>20% CJK chars)', () => {
    const result = runLinter(input({ title: '微信 WeChat' }));
    expect(result.scriptSupported).toBe(false);
  });

  it('returns scriptSupported=false for Arabic title', () => {
    const result = runLinter(input({ title: 'تطبيق عربي App' }));
    expect(result.scriptSupported).toBe(false);
  });

  it('returns scriptSupported=false for Hebrew title', () => {
    const result = runLinter(input({ title: 'אפליקציה עברית App' }));
    expect(result.scriptSupported).toBe(false);
  });

  it('suppresses all flags when scriptSupported=false', () => {
    // Title is >20% CJK — mechanics must be suppressed entirely.
    const result = runLinter(input({ title: '微信通讯 Free' }));
    expect(result.scriptSupported).toBe(false);
    expect(result.flags).toHaveLength(0);
    expect(result.reclaimableChars).toBe(0);
    expect(result.estimatedKeywordWaste).toBe(0);
  });

  it('returns correct char counts even when script unsupported', () => {
    const result = runLinter(input({ title: '微信', subtitle: 'sub' }));
    expect(result.titleUsed).toBe(2);
    expect(result.subtitleUsed).toBe(3);
  });
});

// ── Budget reporting ──────────────────────────────────────────────────────────

describe('budget reporting', () => {
  it('totalCharsBudget is always 160', () => {
    expect(runLinter(input()).totalCharsBudget).toBe(TOTAL_BUDGET);
    expect(TOTAL_BUDGET).toBe(160);
  });

  it('keywordFieldUsed is always null (unobservable)', () => {
    expect(runLinter(input()).keywordFieldUsed).toBeNull();
  });

  it('reports correct titleUsed', () => {
    const result = runLinter(input({ title: 'Rivian' }));
    expect(result.titleUsed).toBe(6);
  });

  it('reports correct subtitleUsed when subtitle present', () => {
    const result = runLinter(input({ title: 'Rivian', subtitle: 'EV companion' }));
    expect(result.subtitleUsed).toBe(12);
  });

  it('reports subtitleUsed=0 when subtitle null', () => {
    expect(runLinter(input({ subtitle: null })).subtitleUsed).toBe(0);
  });
});

// ── Determinism (§F P3) ───────────────────────────────────────────────────────

describe('determinism — same input → identical output, no model call', () => {
  it('produces byte-identical results on repeated calls', () => {
    const inp = input({ title: 'Best Free App Tracker', subtitle: 'Track Your Apps Free' });
    const r1 = runLinter(inp);
    const r2 = runLinter(inp);
    expect(r1).toEqual(r2);
  });

  it('is a pure function (no side effects)', () => {
    const inp = input({ title: 'Best App' });
    runLinter(inp);
    // inp should not be mutated
    expect(inp.title).toBe('Best App');
  });
});

// ── Wasted words ─────────────────────────────────────────────────────────────

describe('wasted word detection', () => {
  it('flags "app" in title as wasted', () => {
    const result = runLinter(input({ title: 'Rivian App' }));
    const flag = result.flags.find((f) => f.normalizedKey === 'app' && f.field === 'title');
    expect(flag).toBeDefined();
    expect(flag?.reason).toBe('wasted_word');
  });

  it('flags "free" in title as wasted', () => {
    const result = runLinter(input({ title: 'Rivian Free' }));
    const flag = result.flags.find((f) => f.normalizedKey === 'free' && f.field === 'title');
    expect(flag?.reason).toBe('wasted_word');
  });

  it('flags "best" in subtitle as wasted', () => {
    const result = runLinter(input({ title: 'Rivian', subtitle: 'Best EV Companion' }));
    const flag = result.flags.find((f) => f.normalizedKey === 'best' && f.field === 'subtitle');
    expect(flag?.reason).toBe('wasted_word');
  });

  it('does not flag meaningful words', () => {
    const result = runLinter(input({ title: 'Rivian', subtitle: 'Electric Vehicle Companion' }));
    expect(result.flags).toHaveLength(0);
  });

  it('counts reclaimableChars as term.length + 1', () => {
    const result = runLinter(input({ title: 'Best Rivian' }));
    const flag = result.flags.find((f) => f.normalizedKey === 'best');
    expect(flag?.reclaimableChars).toBe('best'.length + 1); // 5
  });
});

// ── Cross-field duplicates ────────────────────────────────────────────────────

describe('cross-field duplicate detection', () => {
  it('flags subtitle word that also appears in title', () => {
    const result = runLinter(input({
      title: 'Rivian EV',
      subtitle: 'Rivian Electric Vehicle Control',
    }));
    const flag = result.flags.find((f) => f.reason === 'cross_field_duplicate' && f.field === 'subtitle');
    expect(flag).toBeDefined();
    expect(flag?.normalizedKey).toBe('rivian');
  });

  it('uses normalizeValueKey for matching (handles case)', () => {
    const result = runLinter(input({
      title: 'TRACKER Pro',
      subtitle: 'Track your vehicle',
    }));
    // "TRACKER" in title normalizes to "tracker"; "Track" in subtitle normalizes to "track"
    // depluralize("tracker") = "tracker", depluralize("track") = "track" → different keys
    // so "track" should NOT be a cross-field dup of "tracker"
    const dupFlags = result.flags.filter((f) => f.reason === 'cross_field_duplicate');
    expect(dupFlags.every((f) => f.normalizedKey !== 'track')).toBe(true);
  });

  it('collapses plural forms — "tracks" in subtitle matches "track" in title', () => {
    const result = runLinter(input({
      title: 'Track Rivian',
      subtitle: 'Tracks your EV',
    }));
    // normalizeValueKey("tracks") → "track", normalizeValueKey("track") → "track" → duplicate
    const flag = result.flags.find((f) => f.reason === 'cross_field_duplicate' && f.normalizedKey === 'track');
    expect(flag).toBeDefined();
  });

  it('does not flag subtitle words absent from title', () => {
    const result = runLinter(input({
      title: 'Rivian',
      subtitle: 'Electric Vehicle Control',
    }));
    const dups = result.flags.filter((f) => f.reason === 'cross_field_duplicate');
    expect(dups).toHaveLength(0);
  });
});

// ── Plural redundancy ─────────────────────────────────────────────────────────

describe('plural redundancy within a field', () => {
  it('flags a wasted words scenario correctly (plural redundancy distinct from wasted word)', () => {
    // Wasted words shouldn't be confused with plural redundancy
    const result = runLinter(input({ title: 'App Apps Manager' }));
    // "App" and "Apps" normalize to "app" → plural redundancy
    // But both are also wasted words — we expect wasted_word flags, not plural_redundant
    // since the wasted-word check fires first in the same pass
    const wastedFlags = result.flags.filter((f) => f.reason === 'wasted_word');
    expect(wastedFlags.length).toBeGreaterThan(0);
  });
});

// ── Keyword-field inference ───────────────────────────────────────────────────

describe('keyword field inference', () => {
  it('estimates keyword waste based on title+subtitle token count', () => {
    const result = runLinter(input({ title: 'Rivian EV', subtitle: 'Electric Vehicle' }));
    expect(result.estimatedKeywordWaste).toBeGreaterThan(0);
  });

  it('caps estimatedKeywordWaste at 100 (keyword field limit)', () => {
    const longTitle = 'A'.repeat(30); // 30 single chars — many tokens
    const result = runLinter(input({ title: longTitle }));
    expect(result.estimatedKeywordWaste).toBeLessThanOrEqual(100);
  });

  it('produces zero estimatedKeywordWaste for empty title (single chars filtered)', () => {
    // Single-char tokens are filtered (< 3 chars); an all-single-char title has no tokens
    const result = runLinter(input({ title: 'AB' }));
    expect(result.estimatedKeywordWaste).toBe(0);
  });
});

// ── reclaimableChars total ────────────────────────────────────────────────────

describe('reclaimableChars total', () => {
  it('sums all flag.reclaimableChars', () => {
    const result = runLinter(input({ title: 'Best Free Rivian App' }));
    const expected = result.flags.reduce((s, f) => s + f.reclaimableChars, 0);
    expect(result.reclaimableChars).toBe(expected);
  });

  it('is 0 when no flags', () => {
    const result = runLinter(input({ title: 'Rivian' }));
    expect(result.reclaimableChars).toBe(0);
  });
});
