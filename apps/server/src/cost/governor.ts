/**
 * Spend & loop governor — enforces three caps on audit run cost and frequency:
 *
 *  1. Run-entry < 2 s trip — if another audit run started < 2 seconds ago, refuse.
 *  2. Count kill at ~2,000 metered calls/hr — all gateway calls count.
 *  3. 5-min wall-clock cap — a single audit run may not exceed 5 minutes.
 */

import { type Result, ok, err } from '../domain/result';

export type GovernorDenial = 'count_cap' | 'wallclock_cap' | 'reentrant';

export interface Governor {
  /** Call before each metered upstream call. Returns err() if any cap is tripped. */
  preflight(): Result<void, GovernorDenial>;
  /** Record the start of an audit run. Returns err('reentrant') if a run started < 2s ago. */
  startRun(): Result<void, 'reentrant'>;
  /** Record the end of an audit run (clears wall-clock timer). */
  endRun(): void;
  /** Post-hoc dollar estimate (alert-only, not enforced in beta). */
  recordEstimate(tokens: number, dollars: number): void;
  /** For tests: reset all internal state. */
  reset(): void;
}

const METERED_CALL_CEILING = 2000; // per rolling hour
const RUN_ENTRY_WINDOW_MS = 2000; // re-entrant if another run started < 2s ago
const RUN_WALL_CLOCK_CAP_MS = 5 * 60 * 1000; // 5 minutes

export class InProcessGovernor implements Governor {
  // Rolling call log: timestamps of recent metered calls (within the last hour)
  #callLog: number[] = [];
  // Track when the current run started (ms since epoch); null when no run in progress
  #runStart: number | null = null;
  // Track the last run's start time for re-entrancy detection
  #lastRunStart: number | null = null;
  // Post-hoc estimate accumulator (alert-only)
  #estimatedDollars = 0;

  startRun(): Result<void, 'reentrant'> {
    const now = Date.now();
    if (this.#lastRunStart !== null && now - this.#lastRunStart < RUN_ENTRY_WINDOW_MS) {
      return err('reentrant');
    }
    this.#runStart = now;
    this.#lastRunStart = now;
    return ok(undefined);
  }

  endRun(): void {
    this.#runStart = null;
  }

  preflight(): Result<void, GovernorDenial> {
    const now = Date.now();
    // Trim the call log to only the past hour
    const oneHourAgo = now - 60 * 60 * 1000;
    this.#callLog = this.#callLog.filter((t) => t > oneHourAgo);

    // Count cap
    if (this.#callLog.length >= METERED_CALL_CEILING) {
      return err('count_cap');
    }

    // Wall-clock cap
    if (this.#runStart !== null && now - this.#runStart > RUN_WALL_CLOCK_CAP_MS) {
      return err('wallclock_cap');
    }

    // Record this call
    this.#callLog.push(now);
    return ok(undefined);
  }

  recordEstimate(tokens: number, dollars: number): void {
    this.#estimatedDollars += dollars;
    if (this.#estimatedDollars > 5) {
      // Alert-only — log to console, never throw
      console.warn(
        `[governor] estimated daily spend alert: $${this.#estimatedDollars.toFixed(2)} (>${tokens} tokens)`,
      );
    }
  }

  reset(): void {
    this.#callLog = [];
    this.#runStart = null;
    this.#lastRunStart = null;
    this.#estimatedDollars = 0;
  }
}

// GovernorDenialError is declared here so gateway.ts can import it from ./governor
// (avoiding a circular dependency — gateway imports governor, not vice-versa).
// The GatewayCall type is forward-declared here as a minimal shape to avoid
// pulling in the full gateway module.
export interface GovernorCallRef {
  kind: string;
  upstream: string;
}

export class GovernorDenialError extends Error {
  constructor(
    readonly denial: GovernorDenial,
    readonly url: string,
    readonly call: GovernorCallRef,
  ) {
    super(`Governor denied ${call.upstream} call to ${url}: ${denial}`);
    this.name = 'GovernorDenialError';
  }
}

let _governor: Governor | null = null;

export function getGovernor(): Governor {
  if (!_governor) _governor = new InProcessGovernor();
  return _governor;
}

/** Replace the singleton — used in tests to inject a stub or reset. */
export function setGovernor(g: Governor): void {
  _governor = g;
}
