/**
 * E1: LibSQL-backed HTTP response cache (aso_cache table).
 *
 * Caches source HTTP fetch bodies (iTunes, reviews, crawler, AppKittie)
 * so re-audits skip upstream fetches entirely.
 *
 * NOT cached:
 *   - kind: 'asset' (Apple CDN binary fetches)
 *   - upstream: 'vision'    (domain-layer selectVisionResult handles this)
 *   - upstream: 'embedding' (cheap, rarely repeated per-text)
 */

import type { Client } from '@libsql/client';
import { openDb } from '../memory/migrate';

export type EntityKey = string; // `${upstream}:${entityId}`

export interface CacheEntry<T> {
  value: T;
  fetchedAt: string; // ISO-8601, when originally fetched
}

export interface Cache {
  get<T>(key: EntityKey): Promise<CacheEntry<T> | null>;
  set<T>(key: EntityKey, value: T, ttlSeconds: number): Promise<void>;
  /** Approximate hit count since last reset — for provenance stamping. */
  hitCount(): number;
  resetHitCount(): void;
}

export class NoOpCache implements Cache {
  #hits = 0;
  async get<T>(_key: EntityKey): Promise<CacheEntry<T> | null> { return null; }
  async set<T>(_key: EntityKey, _value: T, _ttl: number): Promise<void> {}
  hitCount(): number { return this.#hits; }
  resetHitCount(): void { this.#hits = 0; }
}

export class LibSqlCache implements Cache {
  #db: Client;
  #hits = 0;

  constructor(db: Client) { this.#db = db; }

  async get<T>(key: EntityKey): Promise<CacheEntry<T> | null> {
    const now = new Date().toISOString();
    try {
      const res = await this.#db.execute({
        sql: 'SELECT value, fetched_at FROM aso_cache WHERE key = ? AND expires_at > ?',
        args: [key, now],
      });
      const row = res.rows[0];
      if (!row) return null;
      this.#hits++;
      return {
        value: JSON.parse(String(row.value)) as T,
        fetchedAt: String(row.fetched_at),
      };
    } catch {
      // Degrade gracefully — table may not exist yet if migrations are still running.
      return null;
    }
  }

  async set<T>(key: EntityKey, value: T, ttlSeconds: number): Promise<void> {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    try {
      await this.#db.execute({
        sql: `INSERT INTO aso_cache (key, value, fetched_at, expires_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT (key) DO UPDATE SET
                value = excluded.value,
                fetched_at = excluded.fetched_at,
                expires_at = excluded.expires_at`,
        args: [key, JSON.stringify(value), now, expiresAt],
      });
    } catch {
      // Best-effort — a failed cache write is not fatal; the next request will re-fetch.
    }
  }

  hitCount(): number { return this.#hits; }
  resetHitCount(): void { this.#hits = 0; }
}

let _cache: Cache | null = null;

export function getCache(): Cache {
  if (!_cache) {
    const url = process.env.ASO_DB_URL?.trim() || 'file:./aso-audit.db';
    const db = openDb(url);
    _cache = new LibSqlCache(db);
  }
  return _cache;
}

export function setCache(c: Cache): void {
  _cache = c;
}
