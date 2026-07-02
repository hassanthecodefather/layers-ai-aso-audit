import { describe, it, expect } from 'vitest';
import { rankOpportunities, formatOpportunitiesForPrompt } from './opportunity';
import type { CandidateResult } from './candidates';
import type { ResolvedIdentity } from '../identity/resolve';

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Only niche + category are read by rankOpportunities; cast avoids building the full object.
const baseResolved = {
  category: 'EV Charging',
  niche: 'electric vehicle charging network',
} as ResolvedIdentity;

function normaliseKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function makeCandidates(
  candidates: { term: string; popularity?: number; difficulty?: number }[],
  gap: { term: string; gapCategory: 'yours_only' | 'theirs_only' | 'shared'; popularity?: number; difficulty?: number }[] = [],
): CandidateResult {
  const popularityAvailable =
    candidates.some((c) => c.popularity != null) || gap.some((g) => g.popularity != null);
  return {
    popularityAvailable,
    candidates: candidates.map((c) => ({
      term: c.term,
      normalizedKey: normaliseKey(c.term),
      source: 'description' as const,
      volumeLabel: c.popularity != null ? 'AppKittie estimate' : 'popularity unavailable',
      volumeAvailable: c.popularity != null,
      popularity: c.popularity,
      difficulty: c.difficulty,
    })),
    gap: gap.map((g) => ({
      term: g.term,
      normalizedKey: normaliseKey(g.term),
      gapCategory: g.gapCategory,
      confidence: 'inferred' as const,
      volumeLabel: g.popularity != null ? 'AppKittie estimate' : 'popularity unavailable',
      volumeAvailable: g.popularity != null,
      popularity: g.popularity,
      difficulty: g.difficulty,
    })),
  };
}

// ── Tests: brand detection ────────────────────────────────────────────────────

describe('rankOpportunities — brand detection', () => {
  it('places brand tokens first regardless of opportunity score', () => {
    // "Rivian" appears in the app name but has low popularity
    const candidates = makeCandidates([
      { term: 'electric charging', popularity: 80, difficulty: 50 },
      { term: 'Rivian', popularity: 5, difficulty: 5 },
      { term: 'ev network', popularity: 60, difficulty: 40 },
    ]);
    const ranked = rankOpportunities(candidates, baseResolved, 'Rivian App');
    expect(ranked[0]!.term).toBe('Rivian');
    expect(ranked[0]!.isBrand).toBe(true);
    expect(ranked[0]!.tier).toBe('core-intent');
  });

  it('marks non-brand terms isBrand=false', () => {
    const candidates = makeCandidates([{ term: 'ev charger' }]);
    const ranked = rankOpportunities(candidates, baseResolved, 'ChargePoint');
    expect(ranked[0]!.isBrand).toBe(false);
  });
});

// ── Tests: tier assignment ────────────────────────────────────────────────────

describe('rankOpportunities — tier assignment', () => {
  it('assigns core-intent when relevance ≥ 0.6', () => {
    // 'electric vehicle charging' overlaps fully with niche tokens
    const candidates = makeCandidates([{ term: 'electric vehicle charging' }]);
    const ranked = rankOpportunities(candidates, baseResolved, 'MyApp');
    expect(ranked[0]!.tier).toBe('core-intent');
  });

  it('assigns competitor tier for theirs_only gap terms', () => {
    const candidates = makeCandidates(
      [],
      [{ term: 'tesla supercharger', gapCategory: 'theirs_only' }],
    );
    const ranked = rankOpportunities(candidates, baseResolved, 'MyApp');
    expect(ranked[0]!.tier).toBe('competitor');
    expect(ranked[0]!.gapCategory).toBe('theirs_only');
  });

  it('assigns feature tier for low-relevance candidates without gap category', () => {
    const candidates = makeCandidates([{ term: 'coffee nearby' }]);
    const ranked = rankOpportunities(candidates, baseResolved, 'MyApp');
    expect(ranked[0]!.tier).toBe('feature');
  });
});

// ── Tests: score computation ──────────────────────────────────────────────────

describe('rankOpportunities — score computation', () => {
  it('higher popularity raises opportunity score', () => {
    const candidates = makeCandidates([
      { term: 'ev station', popularity: 80, difficulty: 40 },
      { term: 'ev station alt', popularity: 20, difficulty: 40 },
    ]);
    // Both terms have same relevance (same tokens essentially), higher pop wins
    const ranked = rankOpportunities(candidates, baseResolved, 'MyApp');
    // ev station should score higher than ev station alt (identical relevance, 80 vs 20 pop)
    const stationIdx = ranked.findIndex((r) => r.term === 'ev station');
    const altIdx = ranked.findIndex((r) => r.term === 'ev station alt');
    expect(ranked[stationIdx]!.opportunityScore).toBeGreaterThan(ranked[altIdx]!.opportunityScore);
  });

  it('higher difficulty lowers opportunity score (all else equal)', () => {
    const candidates = makeCandidates([
      { term: 'charger map', popularity: 50, difficulty: 10 },
      { term: 'charger finder', popularity: 50, difficulty: 90 },
    ]);
    const ranked = rankOpportunities(candidates, baseResolved, 'MyApp');
    const easyIdx = ranked.findIndex((r) => r.term === 'charger map');
    const hardIdx = ranked.findIndex((r) => r.term === 'charger finder');
    expect(ranked[easyIdx]!.opportunityScore).toBeGreaterThan(ranked[hardIdx]!.opportunityScore);
  });

  it('uses 50/50 defaults when popularity and difficulty are null', () => {
    const candidates = makeCandidates([{ term: 'ev route', popularity: undefined, difficulty: undefined }]);
    const ranked = rankOpportunities(candidates, baseResolved, 'MyApp');
    const r = ranked[0]!;
    // score = relevance × 50 / 50 = relevance × 1
    expect(r.opportunityScore).toBeCloseTo(r.relevance, 2);
    expect(r.popularity).toBeNull();
    expect(r.difficulty).toBeNull();
  });
});

// ── Tests: provenance labeling ────────────────────────────────────────────────

describe('rankOpportunities — provenance', () => {
  it('labels estimated when popularity is provided', () => {
    const candidates = makeCandidates([{ term: 'ev charger', popularity: 70, difficulty: 30 }]);
    const ranked = rankOpportunities(candidates, baseResolved, 'MyApp');
    expect(ranked[0]!.provenance).toBe('estimated');
  });

  it('labels inferred when popularity is absent', () => {
    const candidates = makeCandidates([{ term: 'ev charger' }]);
    const ranked = rankOpportunities(candidates, baseResolved, 'MyApp');
    expect(ranked[0]!.provenance).toBe('inferred');
  });
});

// ── Tests: deduplication ──────────────────────────────────────────────────────

describe('rankOpportunities — deduplication', () => {
  it('deduplicates candidates and gap terms with the same normalizedKey', () => {
    const candidates = makeCandidates(
      [{ term: 'ev network' }],
      [{ term: 'EV Network', gapCategory: 'shared' }],
    );
    const ranked = rankOpportunities(candidates, baseResolved, 'MyApp');
    const count = ranked.filter((r) => r.normalizedKey === 'ev network').length;
    expect(count).toBe(1);
  });
});

// ── Tests: formatOpportunitiesForPrompt ──────────────────────────────────────

describe('formatOpportunitiesForPrompt', () => {
  it('returns empty string for empty input', () => {
    expect(formatOpportunitiesForPrompt([])).toBe('');
  });

  it('includes tier and brand note in output', () => {
    const candidates = makeCandidates([{ term: 'Rivian', popularity: 10 }]);
    const ranked = rankOpportunities(candidates, baseResolved, 'Rivian App');
    const out = formatOpportunitiesForPrompt(ranked);
    expect(out).toContain('brand-defence');
    expect(out).toContain('core-intent');
  });

  it('caps at top parameter', () => {
    const candidates = makeCandidates(
      Array.from({ length: 20 }, (_, i) => ({ term: `term${i}`, popularity: i * 3 })),
    );
    const ranked = rankOpportunities(candidates, baseResolved, 'MyApp');
    const out = formatOpportunitiesForPrompt(ranked, 5);
    // 5 bullet rows
    const bullets = out.split('\n').filter((l) => l.startsWith('  •'));
    expect(bullets.length).toBe(5);
  });

  it('includes competitor gap note for theirs_only terms', () => {
    const candidates = makeCandidates(
      [],
      [{ term: 'tesla network', gapCategory: 'theirs_only' }],
    );
    const ranked = rankOpportunities(candidates, baseResolved, 'MyApp');
    const out = formatOpportunitiesForPrompt(ranked);
    expect(out).toContain("competitor gap — they have it, you don't");
  });
});
