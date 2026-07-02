import { describe, it, expect } from 'vitest';
import {
  tierCompetitors,
  mapKeywordGapsToCompetitors,
  buildCompetitorTieringResult,
  formatCompetitorTieringForPrompt,
} from './competitor-tiering';
import type { Competitor } from '../domain/listing';
import type { CandidateResult } from '../keywords/candidates';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeCompetitor(overrides: Partial<Competitor> = {}): Competitor {
  return {
    appId: '111',
    name: 'TestApp',
    developer: 'Dev Inc.',
    primaryGenre: 'Utilities',
    averageRating: 4.0,
    ratingCount: 1000,
    formattedPrice: 'Free',
    screenshotCount: 5,
    hasPreviewVideo: false,
    description: 'A test app for utilities.',
    ...overrides,
  };
}

function makeGap(term: string, gapCategory: 'yours_only' | 'theirs_only' | 'shared') {
  return {
    term,
    normalizedKey: term.toLowerCase(),
    gapCategory,
    confidence: 'inferred' as const,
    volumeLabel: 'popularity unavailable',
    volumeAvailable: false,
  };
}

const EMPTY_CANDIDATE_RESULT: CandidateResult = {
  popularityAvailable: false,
  candidates: [],
  gap: [],
};

// ── tierCompetitors ───────────────────────────────────────────────────────────

describe('tierCompetitors', () => {
  it('tags as direct when primaryGenre matches our genre (case-insensitive)', () => {
    const competitor = makeCompetitor({ primaryGenre: 'Utilities' });
    const tiered = tierCompetitors([competitor], 'Utilities');
    expect(tiered[0]!.tier).toBe('direct');
  });

  it('tags as direct ignoring case', () => {
    const competitor = makeCompetitor({ primaryGenre: 'utilities' });
    const tiered = tierCompetitors([competitor], 'Utilities');
    expect(tiered[0]!.tier).toBe('direct');
  });

  it('tags as indirect when genres differ (D3-sourced)', () => {
    const competitor = makeCompetitor({ primaryGenre: 'Navigation' });
    const tiered = tierCompetitors([competitor], 'Utilities');
    expect(tiered[0]!.tier).toBe('indirect');
  });

  it('tags as indirect when competitor primaryGenre is null', () => {
    const competitor = makeCompetitor({ primaryGenre: null });
    const tiered = tierCompetitors([competitor], 'Utilities');
    expect(tiered[0]!.tier).toBe('indirect');
  });

  it('tags as indirect when our primaryGenre is null', () => {
    const competitor = makeCompetitor({ primaryGenre: 'Utilities' });
    const tiered = tierCompetitors([competitor], null);
    expect(tiered[0]!.tier).toBe('indirect');
  });

  it('tags all as organic-search when fromD3=false', () => {
    const competitors = [
      makeCompetitor({ primaryGenre: 'Utilities' }),   // would be direct if D3
      makeCompetitor({ primaryGenre: 'Navigation' }),
    ];
    const tiered = tierCompetitors(competitors, 'Utilities', false);
    for (const t of tiered) {
      expect(t.tier).toBe('organic-search');
    }
  });

  it('handles an empty competitors list', () => {
    const tiered = tierCompetitors([], 'Utilities');
    expect(tiered).toHaveLength(0);
  });

  it('mixes direct and indirect correctly', () => {
    const competitors = [
      makeCompetitor({ name: 'Same', primaryGenre: 'Utilities' }),
      makeCompetitor({ name: 'Different', primaryGenre: 'Travel' }),
    ];
    const tiered = tierCompetitors(competitors, 'Utilities');
    const tiers = Object.fromEntries(tiered.map((t) => [t.competitor.name, t.tier]));
    expect(tiers['Same']).toBe('direct');
    expect(tiers['Different']).toBe('indirect');
  });
});

// ── mapKeywordGapsToCompetitors ───────────────────────────────────────────────

describe('mapKeywordGapsToCompetitors', () => {
  it('returns empty when no theirs_only gaps', () => {
    const tiered = [{ competitor: makeCompetitor(), tier: 'direct' as const }];
    const gaps = [makeGap('ev charging', 'yours_only'), makeGap('shared term', 'shared')];
    const result = mapKeywordGapsToCompetitors(gaps, tiered);
    expect(result).toHaveLength(0);
  });

  it('returns empty when tiered list is empty', () => {
    const gaps = [makeGap('ev charging', 'theirs_only')];
    const result = mapKeywordGapsToCompetitors(gaps, []);
    expect(result).toHaveLength(0);
  });

  it('maps a theirs_only term to competitors whose descriptions contain it', () => {
    const tiered = [
      {
        competitor: makeCompetitor({ name: 'EVgo', description: 'Find ev charging stations near you.' }),
        tier: 'direct' as const,
      },
      {
        competitor: makeCompetitor({ name: 'PlugShare', description: 'Share charging locations.' }),
        tier: 'indirect' as const,
      },
    ];
    const gaps = [makeGap('ev charging', 'theirs_only')];
    const result = mapKeywordGapsToCompetitors(gaps, tiered);

    expect(result).toHaveLength(1);
    expect(result[0]!.term).toBe('ev charging');
    expect(result[0]!.competitorNames).toContain('EVgo');
    expect(result[0]!.competitorNames).not.toContain('PlugShare'); // 'ev charging' not in PlugShare desc
    expect(result[0]!.provenance).toBe('estimated');
  });

  it('matches competitor name as well as description', () => {
    const tiered = [
      {
        competitor: makeCompetitor({ name: 'ChargePoint', description: 'EV network app.' }),
        tier: 'direct' as const,
      },
    ];
    const gaps = [makeGap('chargepoint', 'theirs_only')];
    const result = mapKeywordGapsToCompetitors(gaps, tiered);

    expect(result[0]!.competitorNames).toContain('ChargePoint');
  });

  it('returns empty competitorNames when no match found', () => {
    const tiered = [
      {
        competitor: makeCompetitor({ name: 'Unrelated', description: 'Something else entirely.' }),
        tier: 'indirect' as const,
      },
    ];
    const gaps = [makeGap('ev charging', 'theirs_only')];
    const result = mapKeywordGapsToCompetitors(gaps, tiered);

    expect(result[0]!.competitorNames).toHaveLength(0);
  });

  it('handles regex-special characters in term without throwing', () => {
    const tiered = [{ competitor: makeCompetitor(), tier: 'direct' as const }];
    const gaps = [makeGap('c++ app', 'theirs_only')];
    // Should not throw; just returns with empty competitorNames
    expect(() => mapKeywordGapsToCompetitors(gaps, tiered)).not.toThrow();
  });
});

// ── buildCompetitorTieringResult ──────────────────────────────────────────────

describe('buildCompetitorTieringResult', () => {
  it('returns empty tiered and gaps when competitors list is empty', () => {
    const result = buildCompetitorTieringResult([], 'Utilities', EMPTY_CANDIDATE_RESULT);
    expect(result.tiered).toHaveLength(0);
    expect(result.keywordGaps).toHaveLength(0);
  });

  it('assembles tiered + keyword gaps in one call', () => {
    const competitors = [
      makeCompetitor({ name: 'DirectPeer', primaryGenre: 'Utilities', description: 'ev charging made easy' }),
    ];
    const candidateResult: CandidateResult = {
      popularityAvailable: false,
      candidates: [],
      gap: [makeGap('ev charging', 'theirs_only'), makeGap('ours', 'yours_only')],
    };
    const result = buildCompetitorTieringResult(competitors, 'Utilities', candidateResult);

    expect(result.tiered[0]!.tier).toBe('direct');
    expect(result.keywordGaps).toHaveLength(1); // only theirs_only
    expect(result.keywordGaps[0]!.term).toBe('ev charging');
  });

  it('handles null candidateResult — no keyword gaps', () => {
    const competitors = [makeCompetitor()];
    const result = buildCompetitorTieringResult(competitors, 'Utilities', null);
    expect(result.keywordGaps).toHaveLength(0);
  });
});

// ── formatCompetitorTieringForPrompt ──────────────────────────────────────────

describe('formatCompetitorTieringForPrompt', () => {
  it('returns empty string for null', () => {
    expect(formatCompetitorTieringForPrompt(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(formatCompetitorTieringForPrompt(undefined)).toBe('');
  });

  it('returns empty string when tiered list is empty', () => {
    expect(formatCompetitorTieringForPrompt({ tiered: [], keywordGaps: [] })).toBe('');
  });

  it('includes tier label for each competitor', () => {
    const result = buildCompetitorTieringResult(
      [
        makeCompetitor({ name: 'DirectApp', primaryGenre: 'Utilities', averageRating: 4.2 }),
        makeCompetitor({ name: 'IndirectApp', primaryGenre: 'Navigation', averageRating: 3.8 }),
      ],
      'Utilities',
      EMPTY_CANDIDATE_RESULT,
    );
    const section = formatCompetitorTieringForPrompt(result);

    expect(section).toContain('DirectApp');
    expect(section).toContain('[Direct]');
    expect(section).toContain('IndirectApp');
    expect(section).toContain('[Indirect]');
    expect(section).toContain('4.2');
  });

  it('includes keyword gap section when theirs_only gaps present', () => {
    const result = buildCompetitorTieringResult(
      [makeCompetitor({ description: 'ev charging app' })],
      'Utilities',
      {
        popularityAvailable: false,
        candidates: [],
        gap: [makeGap('ev charging', 'theirs_only')],
      },
    );
    const section = formatCompetitorTieringForPrompt(result);

    expect(section).toContain('ev charging');
    expect(section).toContain('estimated');
  });

  it('omits keyword gap section when no theirs_only gaps', () => {
    const result = buildCompetitorTieringResult(
      [makeCompetitor()],
      'Utilities',
      {
        popularityAvailable: false,
        candidates: [],
        gap: [makeGap('ours', 'yours_only')],
      },
    );
    const section = formatCompetitorTieringForPrompt(result);

    expect(section).not.toContain('keyword gaps');
  });
});
