import type postgres from 'postgres';
import type { Cache, CacheEntry, EntityKey } from '../cost/cache';

export class PostgresCache implements Cache {
  readonly #sql: postgres.Sql;
  #hits = 0;

  constructor(sql: postgres.Sql) {
    this.#sql = sql;
  }

  async get<T>(key: EntityKey): Promise<CacheEntry<T> | null> {
    const now = new Date().toISOString();
    try {
      const rows = await this.#sql<{ value: string; fetched_at: string }[]>`
        SELECT value, fetched_at
        FROM   aso_cache
        WHERE  key = ${key}
          AND  expires_at > ${now}
        LIMIT  1
      `;
      const row = rows[0];
      if (!row) return null;
      this.#hits++;
      return {
        value: JSON.parse(row.value) as T,
        fetchedAt: row.fetched_at,
      };
    } catch {
      return null;
    }
  }

  async set<T>(key: EntityKey, value: T, ttlSeconds: number): Promise<void> {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    try {
      await this.#sql`
        INSERT INTO aso_cache (key, value, fetched_at, expires_at)
        VALUES (${key}, ${JSON.stringify(value)}, ${now}, ${expiresAt})
        ON CONFLICT (key) DO UPDATE SET
          value      = EXCLUDED.value,
          fetched_at = EXCLUDED.fetched_at,
          expires_at = EXCLUDED.expires_at
      `;
    } catch {
      // Best-effort — a failed cache write is not fatal.
    }
  }

  hitCount(): number { return this.#hits; }
  resetHitCount(): void { this.#hits = 0; }
}
