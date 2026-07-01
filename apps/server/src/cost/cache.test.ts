/**
 * Unit tests for src/cost/cache.ts — LibSQL-backed HTTP response cache.
 *
 * Uses a real in-memory LibSQL database so we exercise the actual SQL,
 * including the ON CONFLICT upsert and TTL expiry logic.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createClient } from '@libsql/client';
import { runMigrations } from '../memory/migrate';
import { LibSqlCache, NoOpCache } from './cache';

async function makeCache() {
  const db = createClient({ url: ':memory:' });
  await runMigrations(db);
  return new LibSqlCache(db);
}

// ── LibSqlCache ────────────────────────────────────────────────────────────────

describe('LibSqlCache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('get() returns null for an absent key', async () => {
    const cache = await makeCache();
    const result = await cache.get('itunes:missing-key');
    expect(result).toBeNull();
  });

  it('set() + get() round-trips the value and fetchedAt correctly', async () => {
    const cache = await makeCache();
    const value = { foo: 'bar', nested: { n: 42 } };

    await cache.set('itunes:123:us', value, 3600);
    const entry = await cache.get<typeof value>('itunes:123:us');

    expect(entry).not.toBeNull();
    expect(entry!.value).toEqual(value);
    expect(entry!.fetchedAt).toBeDefined();
    // fetchedAt should be a valid ISO-8601 date string
    expect(new Date(entry!.fetchedAt).toISOString()).toBe(entry!.fetchedAt);
  });

  it('get() returns null after TTL expires (expired entry)', async () => {
    const cache = await makeCache();

    // Set with TTL=1s, then advance time by 2s using fake timers
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    await cache.set('itunes:expired', 'stale-value', 1);

    // Advance time past TTL
    vi.setSystemTime(now + 2000);

    const result = await cache.get('itunes:expired');
    expect(result).toBeNull();
  });

  it('get() returns the entry when TTL has not yet expired', async () => {
    const cache = await makeCache();

    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    await cache.set('itunes:fresh', 'live-value', 3600);

    // Advance time but stay within TTL
    vi.setSystemTime(now + 1000);

    const result = await cache.get<string>('itunes:fresh');
    expect(result).not.toBeNull();
    expect(result!.value).toBe('live-value');
  });

  it('hitCount() increments on cache hit but not on miss', async () => {
    const cache = await makeCache();

    // Miss — hitCount stays 0
    await cache.get('itunes:no-such-key');
    expect(cache.hitCount()).toBe(0);

    // Set and hit
    await cache.set('itunes:hit-me', { data: 1 }, 3600);
    await cache.get('itunes:hit-me');
    expect(cache.hitCount()).toBe(1);

    // Another hit
    await cache.get('itunes:hit-me');
    expect(cache.hitCount()).toBe(2);
  });

  it('resetHitCount() zeroes the counter', async () => {
    const cache = await makeCache();

    await cache.set('reviews:abc', 'body', 3600);
    await cache.get('reviews:abc');
    await cache.get('reviews:abc');
    expect(cache.hitCount()).toBe(2);

    cache.resetHitCount();
    expect(cache.hitCount()).toBe(0);
  });

  it('set() upserts — re-setting the same key overwrites with the new value', async () => {
    const cache = await makeCache();

    await cache.set('itunes:upsert', 'original', 3600);
    await cache.set('itunes:upsert', 'updated', 3600);

    const result = await cache.get<string>('itunes:upsert');
    expect(result!.value).toBe('updated');
  });
});

// ── NoOpCache ──────────────────────────────────────────────────────────────────

describe('NoOpCache', () => {
  it('get() always returns null and never throws', async () => {
    const cache = new NoOpCache();
    const result = await cache.get('itunes:anything');
    expect(result).toBeNull();
  });

  it('set() is a no-op — subsequent get() still returns null', async () => {
    const cache = new NoOpCache();
    await cache.set('itunes:something', { data: 42 }, 3600);
    const result = await cache.get('itunes:something');
    expect(result).toBeNull();
  });

  it('hitCount() always returns 0', () => {
    const cache = new NoOpCache();
    expect(cache.hitCount()).toBe(0);
  });

  it('resetHitCount() is a no-op and does not throw', () => {
    const cache = new NoOpCache();
    expect(() => cache.resetHitCount()).not.toThrow();
    expect(cache.hitCount()).toBe(0);
  });
});
