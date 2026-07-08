/**
 * Unit tests for src/cost/gateway.ts
 * No real network calls — all fetch is stubbed via vi.fn() or setGateway().
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  PassthroughGateway,
  getGateway,
  setGateway,
} from './gateway';
import { fetchWithRetry } from '../sources/http';
import { getPacer, setPacer, SerialPacer } from './pacer';
import { getGovernor, setGovernor, InProcessGovernor } from './governor';
import { setCache, NoOpCache, LibSqlCache } from './cache';
import { createClient } from '@libsql/client';
import { runMigrations } from '../memory/migrate';

beforeEach(() => {
  // Use NoOpCache so gateway tests don't need a real DB with aso_cache table.
  setCache(new NoOpCache());
});

afterEach(() => {
  // Restore all vi.spyOn() wrappers so mock call history doesn't bleed between tests.
  vi.restoreAllMocks();
  // Restore singletons after each test that may have replaced them.
  setGateway(new PassthroughGateway());
  setPacer(new SerialPacer());
  getPacer().reset();
  setCache(new NoOpCache());
  const g = getGovernor();
  if ('reset' in g) (g as InProcessGovernor).reset();
});

describe('PassthroughGateway', () => {
  it('emits a provider_call log line on a successful upstream fetch', async () => {
    const { logger } = await import('../telemetry');
    const logSpy = vi.spyOn(logger, 'info');

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('{"results":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const gw = new PassthroughGateway();
    await gw.fetch('https://example.com/api', {
      kind: 'app', upstream: 'itunes', tenantId: 'tenant_test',
    });

    const call = logSpy.mock.calls.find(([, ctx]) => (ctx as any)?.event === 'provider_call');
    expect(call).toBeDefined();
    const logObj = call![1] as any;
    expect(logObj.provider).toBe('itunes');
    expect(logObj.status).toBe('ok');
    expect(typeof logObj.durationMs).toBe('number');
    logSpy.mockRestore();
  });

  it('passes the fetch through to the underlying global fetch with same URL and init', async () => {
    const mockResponse = new Response('ok', { status: 200 });
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse);

    const gw = new PassthroughGateway();
    // Use kind: 'asset' (uncacheable) so the gateway returns the original Response
    // reference unchanged — caching would buffer the body and create a new Response.
    const result = await gw.fetch('https://example.com/test', { kind: 'asset', upstream: 'vision' }, { method: 'GET' });

    expect(spy).toHaveBeenCalledWith('https://example.com/test', { method: 'GET' });
    expect(result).toBe(mockResponse);

    spy.mockRestore();
  });
});

describe('setGateway / getGateway', () => {
  it('getGateway returns a PassthroughGateway by default', () => {
    // Reset singleton to ensure fresh state
    setGateway(new PassthroughGateway());
    const gw = getGateway();
    expect(gw).toBeInstanceOf(PassthroughGateway);
  });

  it('setGateway replaces the singleton returned by getGateway', () => {
    const stub = {
      fetch: vi.fn().mockResolvedValue(new Response('stub', { status: 200 })),
    };
    setGateway(stub);
    expect(getGateway()).toBe(stub);
  });
});

describe('PassthroughGateway pacer integration', () => {
  it('calls getPacer().wait() for upstream: itunes', async () => {
    const mockWait = vi.fn().mockResolvedValue(undefined);
    setPacer({ wait: mockWait, reset: vi.fn() });

    const mockResponse = new Response('ok', { status: 200 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse);

    const gw = new PassthroughGateway();
    await gw.fetch('https://itunes.apple.com/', { kind: 'app', upstream: 'itunes' });

    expect(mockWait).toHaveBeenCalledOnce();
  });

  it('calls getPacer().wait() for upstream: reviews', async () => {
    const mockWait = vi.fn().mockResolvedValue(undefined);
    setPacer({ wait: mockWait, reset: vi.fn() });

    const mockResponse = new Response('ok', { status: 200 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse);

    const gw = new PassthroughGateway();
    await gw.fetch('https://itunes.apple.com/rss/customerreviews', { kind: 'app', upstream: 'reviews' });

    expect(mockWait).toHaveBeenCalledOnce();
  });

  it('does NOT call getPacer().wait() for non-iTunes upstreams (e.g. vision)', async () => {
    const mockWait = vi.fn().mockResolvedValue(undefined);
    setPacer({ wait: mockWait, reset: vi.fn() });

    const mockResponse = new Response('ok', { status: 200 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse);

    const gw = new PassthroughGateway();
    await gw.fetch('https://vision.example.com/', { kind: 'asset', upstream: 'vision' });

    expect(mockWait).not.toHaveBeenCalled();
  });
});

describe('fetchWithRetry routes through gateway', () => {
  it('calls the injected gateway stub instead of raw fetch', async () => {
    const stubbedResponse = new Response('{"ok":true}', { status: 200 });
    const stubFetch = vi.fn().mockResolvedValueOnce(stubbedResponse);
    setGateway({ fetch: stubFetch });

    const result = await fetchWithRetry('https://itunes.apple.com/lookup?id=123', {
      source: 'test',
      call: { kind: 'app', upstream: 'itunes', entityId: '123:us' },
    });

    expect(stubFetch).toHaveBeenCalledOnce();
    const [calledUrl, calledCall] = stubFetch.mock.calls[0] as [string, unknown, unknown];
    expect(calledUrl).toBe('https://itunes.apple.com/lookup?id=123');
    expect(calledCall).toMatchObject({ kind: 'app', upstream: 'itunes', entityId: '123:us' });
    expect(result).toBe(stubbedResponse);
  });
});

describe('cache hit is free — governor not counted, pacer not called', () => {
  it('a cache hit does not increment the governor call count or invoke the pacer', async () => {
    // Real in-memory LibSQL cache with one pre-populated entry
    const db = createClient({ url: ':memory:' });
    await runMigrations(db);
    const cache = new LibSqlCache(db);
    await cache.set('itunes:app1:us', '{"results":[]}', 3600);
    setCache(cache);

    // Real governor so we can inspect the call log
    const governor = new InProcessGovernor();
    setGovernor(governor);

    // Stub pacer so we can assert it's never called
    const mockWait = vi.fn().mockResolvedValue(undefined);
    setPacer({ wait: mockWait, reset: vi.fn() });

    const gw = new PassthroughGateway();
    // This should hit the cache and return immediately — no real fetch, no governor count
    const rawFetchSpy = vi.spyOn(globalThis, 'fetch');

    await gw.fetch(
      'https://itunes.apple.com/lookup',
      { kind: 'app', upstream: 'itunes', entityId: 'app1:us' },
    );

    // Cache hit must not have incremented the governor call log at all.
    expect(governor.meteredCount()).toBe(0);

    // Confirm a subsequent real call does count (sanity-check that meteredCount works).
    governor.preflight();
    expect(governor.meteredCount()).toBe(1);

    // Pacer must not have been called
    expect(mockWait).not.toHaveBeenCalled();

    // Real fetch must not have been called
    expect(rawFetchSpy).not.toHaveBeenCalled();

    rawFetchSpy.mockRestore();
  });
});
