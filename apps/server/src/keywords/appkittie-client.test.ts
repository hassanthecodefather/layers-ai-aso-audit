import { describe, it, expect, vi, afterEach } from 'vitest';
import { AppKittieClient } from './appkittie-client';
import { getKeywordProvider, StubAsaClient } from './asa-client';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeMcpResponse(data: unknown) {
  return {
    jsonrpc: '2.0',
    id: '1',
    result: {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      isError: false,
    },
  };
}

function mockFetch(responseBody: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { get: (_: string) => 'application/json' },
    json: () => Promise.resolve(responseBody),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env['APP_KITTI_API_KEY'];
});

// ── Normalization ─────────────────────────────────────────────────────────────

describe('AppKittieClient.getVolume — normalization', () => {
  it('maps popularity and difficulty from MCP response', async () => {
    const payload = { data: { keyword: 'ev charging', popularity: 45, difficulty: 32, appsCount: 120, trafficScore: 50 } };
    vi.stubGlobal('fetch', mockFetch(makeMcpResponse(payload)));

    const client = new AppKittieClient('test-key');
    const vol = await client.getVolume('ev charging', 'us');

    expect(vol.available).toBe(true);
    expect(vol.popularity).toBe(45);
    expect(vol.difficulty).toBe(32);
    expect(vol.label).toContain('45/100');
    expect(vol.label).toContain('32/100');
    expect(vol.label).toContain('AppKittie estimate');
  });

  it('uses country uppercased in the request', async () => {
    const payload = { data: { keyword: 'charging', popularity: 10, difficulty: 5, appsCount: 50, trafficScore: 12 } };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: 'OK',
      headers: { get: (_: string) => 'application/json' },
      json: () => Promise.resolve(makeMcpResponse(payload)),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new AppKittieClient('test-key');
    await client.getVolume('charging', 'gb');

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.params.arguments.country).toBe('GB');
    expect(body.params.arguments.source).toBe('apple_mobile');
  });

  it('defaults country to US when storefront is omitted', async () => {
    const payload = { data: { keyword: 'charging', popularity: 10, difficulty: 5, appsCount: 50, trafficScore: 12 } };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: 'OK',
      headers: { get: (_: string) => 'application/json' },
      json: () => Promise.resolve(makeMcpResponse(payload)),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new AppKittieClient('test-key');
    await client.getVolume('charging');

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.params.arguments.country).toBe('US');
  });

  it('sets Authorization header', async () => {
    const payload = { data: { keyword: 'x', popularity: 1, difficulty: 1, appsCount: 1, trafficScore: 1 } };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: 'OK',
      headers: { get: (_: string) => 'application/json' },
      json: () => Promise.resolve(makeMcpResponse(payload)),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new AppKittieClient('my-api-key');
    await client.getVolume('x');

    const headers = (fetchMock.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer my-api-key');
  });
});

// ── Graceful degradation ───────────────────────────────────────────────────────

describe('AppKittieClient.getVolume — graceful degradation', () => {
  it('returns available=false on HTTP error (no throw)', async () => {
    vi.stubGlobal('fetch', mockFetch({}, 500));

    const client = new AppKittieClient('test-key');
    const vol = await client.getVolume('ev');

    expect(vol.available).toBe(false);
    expect(vol.label).toBe('popularity unavailable');
  });

  it('returns available=false on network error (no throw)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const client = new AppKittieClient('test-key');
    const vol = await client.getVolume('ev');

    expect(vol.available).toBe(false);
    expect(vol.label).toBe('popularity unavailable');
  });

  it('returns available=false on MCP-level error', async () => {
    const errResponse = { jsonrpc: '2.0', id: '1', result: { content: [{ type: 'text', text: 'Tool error: bad param' }], isError: true } };
    vi.stubGlobal('fetch', mockFetch(errResponse));

    const client = new AppKittieClient('test-key');
    const vol = await client.getVolume('ev');

    expect(vol.available).toBe(false);
  });

  it('returns available=false on malformed JSON in content', async () => {
    const badResponse = { jsonrpc: '2.0', id: '1', result: { content: [{ type: 'text', text: '{not-json' }], isError: false } };
    vi.stubGlobal('fetch', mockFetch(badResponse));

    const client = new AppKittieClient('test-key');
    const vol = await client.getVolume('ev');

    expect(vol.available).toBe(false);
  });
});

// ── Factory (getKeywordProvider) ──────────────────────────────────────────────

describe('getKeywordProvider factory', () => {
  it('returns StubAsaClient when APP_KITTI_API_KEY is absent', () => {
    delete process.env['APP_KITTI_API_KEY'];
    const provider = getKeywordProvider();
    expect(provider).toBeInstanceOf(StubAsaClient);
  });

  it('returns AppKittieClient when APP_KITTI_API_KEY is set', () => {
    process.env['APP_KITTI_API_KEY'] = 'test-key';
    const provider = getKeywordProvider();
    expect(provider).toBeInstanceOf(AppKittieClient);
  });
});

// ── Live smoke (gated on real key) ────────────────────────────────────────────

const REAL_KEY = process.env['APP_KITTI_API_KEY'];

describe.skipIf(!REAL_KEY)('AppKittieClient live smoke (APP_KITTI_API_KEY required)', () => {
  it('returns real popularity and difficulty for "electric vehicle"', async () => {
    const client = new AppKittieClient(REAL_KEY!);
    const vol = await client.getVolume('electric vehicle', 'us');

    expect(vol.available).toBe(true);
    expect(typeof vol.popularity).toBe('number');
    expect(vol.popularity).toBeGreaterThanOrEqual(0);
    expect(vol.popularity).toBeLessThanOrEqual(100);
    expect(typeof vol.difficulty).toBe('number');
    expect(vol.difficulty).toBeGreaterThanOrEqual(0);
    expect(vol.label).toContain('AppKittie estimate');
  }, 15_000);
});
