import { describe, it, expect } from 'vitest';
import {
  applyHumanDecision,
  signalsMateriallyChanged,
  identityVersionToResolved,
  resolveWithHistory,
} from './human-confirm';
import { extractIdentitySignals } from './signals';
import { loadFixtureListing } from './__fixtures__/load';
import type { ResolvedIdentity } from './resolve';
import type { IdentityVersion } from '../domain/identity';
import type { IdentityClassifier } from '../mastra/tools/resolve-identity';

/**
 * The human-confirmed override path (spec ID). Pure + offline: the classifier
 * is stubbed so reuse/re-ask logic is exercised deterministically.
 */

const RIVIAN_ESCALATED: ResolvedIdentity = {
  category: 'Electric vehicle companion',
  categoryBand: 'low',
  niche: 'EV companion',
  nicheBand: 'medium',
  divergence: 'cross_domain',
  escalate: true,
  source: 'resolved',
  tally: [
    { family: 'developer', value: 'Rivian', sourceTier: 'observed_on_store', agrees: true, fetchedAt: 't' },
    { family: 'bundle_id', value: 'rivian', sourceTier: 'observed_on_store', agrees: true, fetchedAt: 't' },
    { family: 'marketing_domain', value: 'rivian', sourceTier: 'fetched_and_cited', agrees: true, fetchedAt: 't' },
  ],
};

function humanConfirmedRow(over: Partial<IdentityVersion> = {}): IdentityVersion {
  return {
    id: 'idv', appId: '1570215232', country: 'us', version: 1, stage: 'lite',
    category: 'Electric vehicle companion', categoryBand: 'high',
    niche: 'EV companion', nicheBand: 'high', audience: null,
    divergence: 'cross_domain', escalate: false, source: 'human_confirmed',
    createdAt: 't',
    tally: [
      { family: 'developer', value: 'Rivian', sourceTier: 'observed_on_store', agrees: true, fetchedAt: 't' },
      { family: 'bundle_id', value: 'rivian', sourceTier: 'observed_on_store', agrees: true, fetchedAt: 't' },
      { family: 'marketing_domain', value: 'rivian', sourceTier: 'fetched_and_cited', agrees: true, fetchedAt: 't' },
    ],
    ...over,
  };
}

describe('applyHumanDecision', () => {
  it('confirm: accepts the resolved identity and clears escalation as human_confirmed', () => {
    const out = applyHumanDecision(RIVIAN_ESCALATED, { action: 'confirm' });
    expect(out.source).toBe('human_confirmed');
    expect(out.escalate).toBe(false);
    expect(out.category).toBe('Electric vehicle companion');
    expect(out.categoryBand).toBe('high');
  });

  it('correct: overrides the category/niche the human supplies', () => {
    const out = applyHumanDecision(RIVIAN_ESCALATED, { action: 'correct', category: 'EV charging utility', niche: 'charging' });
    expect(out.source).toBe('human_confirmed');
    expect(out.category).toBe('EV charging utility');
    expect(out.niche).toBe('charging');
    expect(out.escalate).toBe(false);
  });
});

describe('signalsMateriallyChanged', () => {
  it('false when the load-bearing signals are unchanged', () => {
    const prior = humanConfirmedRow();
    const current = extractIdentitySignals(loadFixtureListing('rivian'));
    expect(signalsMateriallyChanged(prior, current)).toBe(false);
  });

  it('true when the developer (a rebrand) changed', () => {
    const prior = humanConfirmedRow();
    const current = extractIdentitySignals(loadFixtureListing('rivian'));
    expect(signalsMateriallyChanged(prior, { ...current, developer: 'Rivian Automotive LLC' })).toBe(true);
  });
});

describe('resolveWithHistory', () => {
  const automotive: IdentityClassifier = async () => ({ functionCategory: 'Electric vehicle companion', functionNiche: 'EV', functionTerms: ['truck', 'charge'] });
  const flippedToMusic: IdentityClassifier = async () => ({ functionCategory: 'Music streaming', functionNiche: 'music', functionTerms: ['song'] });

  it('reuses a human-confirmed identity verbatim when signals are unchanged (no re-ask)', async () => {
    const prior = humanConfirmedRow();
    const out = await resolveWithHistory(loadFixtureListing('rivian'), automotive, prior, { fetchedAt: 't' });
    expect(out.source).toBe('human_confirmed');
    expect(out.escalate).toBe(false);
    expect(out.category).toBe('Electric vehicle companion');
  });

  it('resolves fresh when there is no prior human-confirmed identity', async () => {
    const out = await resolveWithHistory(loadFixtureListing('rivian'), automotive, null, { fetchedAt: 't' });
    expect(out.source).toBe('resolved');
    // Rivian still escalates on a fresh resolve (cross-domain).
    expect(out.escalate).toBe(true);
  });

  it('keeps the human call when signals change but the answer stays in-domain', async () => {
    // Developer changed (material) but fresh classification is still automotive.
    const prior = humanConfirmedRow();
    const listing = { ...loadFixtureListing('rivian'), developer: 'Rivian Automotive LLC' };
    const out = await resolveWithHistory(listing, automotive, prior, { fetchedAt: 't' });
    expect(out.source).toBe('human_confirmed');
    expect(out.escalate).toBe(false);
    expect(out.category).toBe('Electric vehicle companion'); // human's call preserved
  });

  it('re-asks (escalates) when signals change AND the answer flips domain', async () => {
    const prior = humanConfirmedRow();
    const listing = { ...loadFixtureListing('rivian'), developer: 'Spotify AB' };
    const out = await resolveWithHistory(listing, flippedToMusic, prior, { fetchedAt: 't' });
    expect(out.escalate).toBe(true);
    expect(out.source).toBe('resolved'); // no longer trusts the stale human call
  });

  it('round-trips an identity version back to a resolved identity', () => {
    const out = identityVersionToResolved(humanConfirmedRow());
    expect(out.source).toBe('human_confirmed');
    expect(out.category).toBe('Electric vehicle companion');
  });
});
