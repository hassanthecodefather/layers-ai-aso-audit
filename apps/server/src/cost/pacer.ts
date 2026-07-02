/**
 * SerialPacer — process-global courtesy throttle for iTunes/Apple Search API.
 *
 * Apple documents ~20 calls/min. We space calls ≥3.5s apart (~17/min) to
 * stay safely under the ceiling and avoid IP bans.
 */

const MIN_INTERVAL_MS = 3500; // ~17 calls/min — safely under Apple's ~20/min ceiling
// Full-jitter: spread calls across [MIN_INTERVAL_MS, MIN_INTERVAL_MS + JITTER_MS]
// so concurrent callers don't produce a synchronized burst after a shared wait.
const JITTER_MS = 500;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface Pacer {
  /**
   * Wait until the min-interval has elapsed since the last call.
   * @param retryAfterMs — if non-zero, honour Retry-After header by waiting
   *   max(retryAfterMs, MIN_INTERVAL_MS) before resuming.
   */
  wait(retryAfterMs?: number): Promise<void>;
  /** For tests: reset last-call timestamp. */
  reset(): void;
}

export class SerialPacer implements Pacer {
  #lastCallMs: number | null = null;

  async wait(retryAfterMs = 0): Promise<void> {
    const now = Date.now();
    const floor = Math.max(retryAfterMs, MIN_INTERVAL_MS);

    if (this.#lastCallMs !== null) {
      const elapsed = now - this.#lastCallMs;
      const baseDelay = Math.max(0, floor - elapsed);
      // Jitter only applies when we are already waiting — it spreads bursts but
      // never introduces a sleep where none was needed.
      if (baseDelay > 0) {
        const jitter = Math.floor(Math.random() * JITTER_MS);
        await sleep(baseDelay + jitter);
      }
    }

    this.#lastCallMs = Date.now();
  }

  reset(): void {
    this.#lastCallMs = null;
  }
}

let _pacer: Pacer | null = null;

export function getPacer(): Pacer {
  if (!_pacer) _pacer = new SerialPacer();
  return _pacer;
}

export function setPacer(p: Pacer): void {
  _pacer = p;
}
