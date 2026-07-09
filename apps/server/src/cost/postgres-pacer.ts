import postgres from 'postgres';
import type { Pacer } from './pacer';
import { logger } from '../telemetry';

const MIN_INTERVAL_MS = 3500;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Thrown when the rate-slot database is unreachable (misconfigured DATABASE_URL). */
export class PacerError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'PacerError';
  }
}

export class PostgresSharedPacer implements Pacer {
  constructor(private readonly sql: postgres.Sql) {}

  async wait(retryAfterMs = 0): Promise<void> {
    const intervalMs = Math.max(retryAfterMs, MIN_INTERVAL_MS);

    let result: number;
    try {
      result = await this.sql.begin(async (tx) => {
        const [row] = await tx<[{ next_allowed_at: Date }]>`
          SELECT next_allowed_at
          FROM aso_rate_slots
          WHERE key = 'itunes'
          FOR UPDATE
        `;
        if (!row) throw new Error("aso_rate_slots 'itunes' row missing — run runPgMigrations()");
        const now = new Date();
        const waitMs = Math.max(row.next_allowed_at.getTime() - now.getTime(), 0);
        const newNext = new Date(
          Math.max(row.next_allowed_at.getTime(), now.getTime()) + intervalMs,
        );
        await tx`
          UPDATE aso_rate_slots
          SET next_allowed_at = ${newNext}
          WHERE key = 'itunes'
        `;
        return waitMs;
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.info('provider_call postgres-pacer rate-slot', { event: 'provider_call', provider: 'postgres-pacer', operation: 'rate-slot', status: 'error', errorMessage: msg });
      throw new PacerError(
        `Rate-slot DB unreachable — check DATABASE_URL. Underlying: ${msg}`,
        e,
      );
    }

    logger.info('provider_call postgres-pacer rate-slot', { event: 'provider_call', provider: 'postgres-pacer', operation: 'rate-slot', status: 'ok' });

    if (result > 0) await sleep(result);
  }

  reset(): void {
    // No-op: distributed pacer has no local state to reset.
  }
}
