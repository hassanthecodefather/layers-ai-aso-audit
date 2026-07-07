import { describe, it, expect } from 'vitest';
import { confirmStep } from './workflows/audit-workflow';
import type { ResolvedIdentity } from '../identity/resolve';

const identity: ResolvedIdentity = {
  category: 'Electric vehicle companion', categoryBand: 'low', niche: 'EV companion', nicheBand: 'medium',
  divergence: 'cross_domain', escalate: true, source: 'resolved', functionTerms: ['truck'], overrodeEvidence: null,
  tally: [{ family: 'developer', value: 'Rivian', sourceTier: 'observed_on_store', agrees: true, fetchedAt: 't' }],
};
const inputData = { summary: { appId: '1', country: 'us', primaryGenre: 'Travel' }, identity, identityNeedsConfirm: true } as any;

it('re-suspends with a conflict payload on an unacknowledged contested override', async () => {
  let suspended: any = null;
  await confirmStep.execute({
    inputData,
    resumeData: { confirmed: true, identityDecision: { action: 'correct', category: 'Travel' } },
    suspend: async (p: any) => { suspended = p; return undefined; },
  } as any);
  expect(suspended).not.toBeNull();
  expect(suspended.conflict.evidenceCategory).toBe('Electric vehicle companion');
  expect(suspended.conflict.chosenCategory).toBe('Travel');
  expect(suspended.conflict.evidence.length).toBeGreaterThan(0);
});

it('accepts the contested override once acknowledged', async () => {
  const out: any = await confirmStep.execute({
    inputData,
    resumeData: { confirmed: true, identityDecision: { action: 'correct', category: 'Travel' }, overrideAcknowledged: true },
    suspend: async () => undefined,
  } as any);
  expect(out.identityDecision).toEqual({ action: 'correct', category: 'Travel' });
});

it('accepts an in-domain correction with no second suspend', async () => {
  let suspended = false;
  const out: any = await confirmStep.execute({
    inputData,
    resumeData: { confirmed: true, identityDecision: { action: 'correct', category: 'EV charging utility' } },
    suspend: async () => { suspended = true; return undefined; },
  } as any);
  expect(suspended).toBe(false);
  expect(out.identityDecision.category).toBe('EV charging utility');
});
