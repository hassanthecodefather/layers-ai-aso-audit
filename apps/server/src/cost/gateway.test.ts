/**
 * Unit tests for src/cost/gateway.ts
 * No real network calls — all fetch is stubbed via vi.fn() or setGateway().
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  PassthroughGateway,
  getGateway,
  setGateway,
} from './gateway';
import { fetchWithRetry } from '../sources/http';

afterEach(() => {
  // Restore singleton after each test that may have replaced it.
  setGateway(new PassthroughGateway());
});

describe('PassthroughGateway', () => {
  it('passes the fetch through to the underlying global fetch with same URL and init', async () => {
    const mockResponse = new Response('ok', { status: 200 });
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse);

    const gw = new PassthroughGateway();
    const result = await gw.fetch('https://example.com/test', { kind: 'app', upstream: 'itunes' }, { method: 'GET' });

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
