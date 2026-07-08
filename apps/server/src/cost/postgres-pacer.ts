import postgres from 'postgres';
import type { Pacer } from './pacer';

const MIN_INTERVAL_MS = 3500;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class PostgresSharedPacer implements Pacer {
  constructor(private readonly sql: postgres.Sql) {}

  async wait(retryAfterMs = 0): Promise<void> {
    const intervalMs = Math.max(retryAfterMs, MIN_INTERVAL_MS);

    const result = await this.sql.begin(async (tx) => {
      const [row] = await tx<[{ next_allowed_at: Date }]>`
        SELECT next_allowed_at
        FROM aso_rate_slots
        WHERE key = 'itunes'
        FOR UPDATE
      `;
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

    if (result > 0) await sleep(result);
  }

  reset(): void {
    // No-op: distributed pacer has no local state to reset.
  }
}
