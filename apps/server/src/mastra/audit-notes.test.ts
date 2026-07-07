import { describe, it, expect } from 'vitest';
import { buildOverrideNotes } from './workflows/audit-workflow';
import type { ResolvedIdentity } from '../identity/resolve';

const confirmedTravel: ResolvedIdentity = {
  category: 'Travel', categoryBand: 'high', niche: null, nicheBand: null,
  divergence: 'cross_domain', escalate: false, source: 'human_confirmed', functionTerms: [],
  overrodeEvidence: { category: 'Electric vehicle companion', niche: 'EV companion', functionTerms: ['truck'] },
  tally: [],
};

it('produces the standing conflict note when a marker is present', () => {
  const notes = buildOverrideNotes(confirmedTravel, [], []);
  expect(notes.join(' ')).toContain('overriding');
  expect(notes.join(' ')).toContain('Electric vehicle companion');
  expect(notes.join(' ')).toContain('Re-open identity');
});

it('adds a mismatch check listing both competitor sets when evidence peers exist', () => {
  const notes = buildOverrideNotes(
    confirmedTravel,
    [{ name: 'Expedia' } as any, { name: 'Booking' } as any],
    [{ name: 'Ford Pass' } as any, { name: 'EVgo' } as any],
  );
  const text = notes.join(' ');
  expect(text).toContain('Expedia');
  expect(text).toContain('Ford Pass');
});

it('no override notes for a normal resolved identity', () => {
  const resolved = { ...confirmedTravel, source: 'resolved', overrodeEvidence: null } as ResolvedIdentity;
  expect(buildOverrideNotes(resolved, [], [])).toEqual([]);
});
