import { describe, it, expect } from 'vitest';
import { scoringVersion } from './version';
import { SCORER_VERSION } from './dimension-scorer';

/**
 * A7 residual (c): the whole-snapshot reuse cache keys on the scoring version,
 * which MUST fold in the scorer-code version — otherwise a `codeScore` /
 * `coarseOrdinalScore` change (with an unchanged listing/prompt/rubric weights)
 * would serve a stale cached report and never re-run the new scoring logic.
 */
describe('scoringVersion — folds in the scorer-code version', () => {
  it('changes when SCORER_VERSION changes (a scorer bump invalidates the snapshot cache)', () => {
    expect(scoringVersion('phase-a-v1')).not.toBe(scoringVersion('phase-b-v1'));
  });

  it('is deterministic for the same scorer version', () => {
    expect(scoringVersion('x')).toBe(scoringVersion('x'));
  });

  it('defaults to the live SCORER_VERSION', () => {
    expect(scoringVersion()).toBe(scoringVersion(SCORER_VERSION));
  });

  it('returns a 16-char hex string', () => {
    expect(scoringVersion()).toMatch(/^[0-9a-f]{16}$/);
  });
});
