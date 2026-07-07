import { describe, it, expect } from 'vitest';
import { explainIdentityEvidence, describeOverrideConsequences } from './evidence-explain';
import type { ResolvedIdentity } from './resolve';

const RIVIAN: ResolvedIdentity = {
  category: 'Electric vehicle companion',
  categoryBand: 'low',
  niche: 'EV companion',
  nicheBand: 'medium',
  divergence: 'cross_domain',
  escalate: true,
  source: 'resolved',
  functionTerms: ['truck', 'charge'],
  overrodeEvidence: null,
  tally: [
    { family: 'developer', value: 'Rivian', sourceTier: 'observed_on_store', agrees: true, fetchedAt: 't' },
    { family: 'marketing_domain', value: 'rivian.com', sourceTier: 'fetched_and_cited', agrees: true, fetchedAt: 't' },
    { family: 'reviews', value: 'function vocabulary present', sourceTier: 'review_inferred', agrees: true, fetchedAt: 't' },
  ],
};

describe('explainIdentityEvidence', () => {
  it('produces one line per agreeing family plus the store-category conflict line', () => {
    const lines = explainIdentityEvidence(RIVIAN, 'Travel');
    const families = lines.map((l) => l.family);
    expect(families).toContain('developer');
    expect(families).toContain('marketing_domain');
    expect(families).toContain('reviews');
    expect(families).toContain('store_category'); // the conflicting declared genre
    const dev = lines.find((l) => l.family === 'developer')!;
    expect(dev.value).toBe('Rivian');
    expect(dev.text.length).toBeGreaterThan(0);
  });

  it('omits families that did not vote (agrees=false or absent)', () => {
    const noReviews: ResolvedIdentity = { ...RIVIAN, tally: RIVIAN.tally.filter((t) => t.family !== 'reviews') };
    const families = explainIdentityEvidence(noReviews, 'Travel').map((l) => l.family);
    expect(families).not.toContain('reviews');
  });
});

describe('describeOverrideConsequences', () => {
  it('names the chosen category and lists concrete consequences', () => {
    const out = describeOverrideConsequences('Travel', 'Electric vehicle companion');
    expect(out.length).toBeGreaterThanOrEqual(3);
    expect(out.join(' ')).toContain('Travel');
    expect(out.join(' ').toLowerCase()).toContain('competitor');
  });
});
