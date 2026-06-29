import { createHash } from 'node:crypto';
import { RUBRIC } from './rubric';
import { SCORER_VERSION } from './dimension-scorer';

/**
 * The scoring fingerprint — a hash of everything that deterministically shapes
 * a score: the RUBRIC weight column **and** the scorer-code version
 * (`SCORER_VERSION`). It is what the snapshot stores as `rubricVersion` and what
 * the audit workflow's whole-snapshot reuse cache compares against.
 *
 * Folding `SCORER_VERSION` in (not just the weights) is the A7-residual fix:
 * a `codeScore` / `coarseOrdinalScore` change bumps `SCORER_VERSION`, which
 * changes this fingerprint, which invalidates the whole-snapshot cache — so an
 * unchanged listing is re-scored under the new logic instead of returning a
 * stale report. `scorerVersion` is a parameter purely so this is unit-testable.
 */
export function scoringVersion(scorerVersion: string = SCORER_VERSION): string {
  return createHash('sha256')
    .update(JSON.stringify(RUBRIC.map((d) => [d.id, d.weight])))
    .update(':')
    .update(scorerVersion)
    .digest('hex')
    .slice(0, 16);
}

/** The live scoring fingerprint (rubric weights + current SCORER_VERSION). */
export const RUBRIC_VERSION = scoringVersion();
