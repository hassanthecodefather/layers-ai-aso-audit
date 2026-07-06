import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  TavilyWebSearch,
  ExaWebSearch,
  NoopWebSearch,
  getWebSearch,
  resetWebSearch,
} from './websearch';
import { setCache, NoOpCache } from '../../cost/cache';
import { setGateway, PassthroughGateway } from '../../cost/gateway';

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockFetch(body: unknown, status = 200) {
  // Use a real Response so gateway's `instanceof Response` check passes.
  const res = new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
  return vi.fn().mockResolvedValue(res);
}

const TAVILY_RESULTS = {
  results: [
    { title: 'Rivian R1T Review', url: 'https://example.com/rivian', content: 'Great truck' },
  ],
};
const TAVILY_EMPTY = { results: [] };

const EXA_RESULTS = {
  results: [
    { title: 'Rivian App Coverage', url: 'https://news.example.com/rivian-app' },
  ],
};
const EXA_EMPTY = { results: [] };

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  setCache(new NoOpCache());
  setGateway(new PassthroughGateway());
  resetWebSearch();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env['TAVILY_API_KEY'];
  delete process.env['EXA_API_KEY'];
  setCache(new NoOpCache());
  resetWebSearch();
});

// ── TavilyWebSearch ───────────────────────────────────────────────────────────

describe('TavilyWebSearch', () => {
  it('returns corroborated when results are found', async () => {
    vi.stubGlobal('fetch', mockFetch(TAVILY_RESULTS));
    const client = new TavilyWebSearch('test-key');
    const result = await client.probe('Rivian electric truck app');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe('corroborated');
    if (result.value.state !== 'corroborated') return;
    expect(result.value.sources).toHaveLength(1);
    expect(result.value.sources[0]!.title).toBe('Rivian R1T Review');
  });

  it('returns searched_and_empty when results array is empty', async () => {
    vi.stubGlobal('fetch', mockFetch(TAVILY_EMPTY));
    const client = new TavilyWebSearch('test-key');
    const result = await client.probe('obscure niche app');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe('searched_and_empty');
  });

  it('only-mirror results → searched_and_empty (Fix 3: mirror-domain filtering)', async () => {
    vi.stubGlobal('fetch', mockFetch({
      results: [
        { title: 'Rivian on App Store', url: 'https://apps.apple.com/us/app/rivian/id1570215232' },
        { title: 'Rivian on SensorTower', url: 'https://sensortower.com/ios/us/rivian/id1570215232' },
        { title: 'Rivian on AppAdvice', url: 'https://appadvice.com/app/rivian/1570215232' },
      ],
    }));
    const client = new TavilyWebSearch('test-key');
    const result = await client.probe('Rivian electric truck app');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe('searched_and_empty');
  });

  it('mixed results → corroborated with only non-mirror sources (Fix 3)', async () => {
    vi.stubGlobal('fetch', mockFetch({
      results: [
        { title: 'Rivian on App Store', url: 'https://apps.apple.com/us/app/rivian/id1570215232' },
        { title: 'Rivian App Review', url: 'https://techcrunch.com/rivian-app-review' },
      ],
    }));
    const client = new TavilyWebSearch('test-key');
    const result = await client.probe('Rivian electric truck app');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe('corroborated');
    if (result.value.state !== 'corroborated') return;
    expect(result.value.sources).toHaveLength(1);
    expect(result.value.sources[0]!.url).toBe('https://techcrunch.com/rivian-app-review');
  });

  it('returns errored on non-OK HTTP status', async () => {
    vi.stubGlobal('fetch', mockFetch({ error: 'Unauthorized' }, 401));
    const client = new TavilyWebSearch('bad-key');
    const result = await client.probe('query');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe('errored');
    if (result.value.state !== 'errored') return;
    expect(result.value.reason).toContain('401');
  });

  it('returns errored on network failure — never throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const client = new TavilyWebSearch('test-key');
    const result = await client.probe('query');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe('errored');
    if (result.value.state !== 'errored') return;
    expect(result.value.reason).toContain('ECONNREFUSED');
  });

  it('treats missing results field as searched_and_empty', async () => {
    vi.stubGlobal('fetch', mockFetch({}));
    const client = new TavilyWebSearch('test-key');
    const result = await client.probe('query');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe('searched_and_empty');
  });
});

// ── ExaWebSearch ──────────────────────────────────────────────────────────────

describe('ExaWebSearch', () => {
  it('returns corroborated when results are found', async () => {
    vi.stubGlobal('fetch', mockFetch(EXA_RESULTS));
    const client = new ExaWebSearch('test-key');
    const result = await client.probe('Rivian electric truck app');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe('corroborated');
    if (result.value.state !== 'corroborated') return;
    expect(result.value.sources[0]!.url).toBe('https://news.example.com/rivian-app');
  });

  it('returns searched_and_empty when results array is empty', async () => {
    vi.stubGlobal('fetch', mockFetch(EXA_EMPTY));
    const client = new ExaWebSearch('test-key');
    const result = await client.probe('obscure niche app');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe('searched_and_empty');
  });

  it('only-mirror results → searched_and_empty (Fix 3: mirror-domain filtering)', async () => {
    vi.stubGlobal('fetch', mockFetch({
      results: [
        { title: 'App on App Store', url: 'https://apps.apple.com/us/app/example/id123' },
        { title: 'App on Apptopia', url: 'https://apptopia.com/ios/app/id123' },
      ],
    }));
    const client = new ExaWebSearch('test-key');
    const result = await client.probe('example app');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe('searched_and_empty');
  });

  it('mixed results → corroborated with only non-mirror sources (Fix 3)', async () => {
    vi.stubGlobal('fetch', mockFetch({
      results: [
        { title: 'App on App Store', url: 'https://apps.apple.com/us/app/example/id123' },
        { title: 'Independent coverage', url: 'https://news.example.com/app-review' },
      ],
    }));
    const client = new ExaWebSearch('test-key');
    const result = await client.probe('example app');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe('corroborated');
    if (result.value.state !== 'corroborated') return;
    expect(result.value.sources).toHaveLength(1);
    expect(result.value.sources[0]!.url).toBe('https://news.example.com/app-review');
  });

  it('returns errored on non-OK HTTP status', async () => {
    vi.stubGlobal('fetch', mockFetch({ error: 'rate limited' }, 429));
    const client = new ExaWebSearch('test-key');
    const result = await client.probe('query');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe('errored');
  });

  it('returns errored on network failure — never throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    const client = new ExaWebSearch('test-key');
    const result = await client.probe('query');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe('errored');
  });
});

// ── NoopWebSearch ─────────────────────────────────────────────────────────────

describe('NoopWebSearch', () => {
  it('returns searched_and_empty without making any network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const client = new NoopWebSearch();
    const result = await client.probe('anything');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe('searched_and_empty');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('available is false', () => {
    expect(new NoopWebSearch().available).toBe(false);
  });
});

// ── Factory precedence ────────────────────────────────────────────────────────

describe('getWebSearch factory', () => {
  it('returns TavilyWebSearch when TAVILY_API_KEY is set', () => {
    process.env['TAVILY_API_KEY'] = 'tv-key';
    const provider = getWebSearch();
    expect(provider.id).toBe('tavily');
    expect(provider.available).toBe(true);
  });

  it('returns ExaWebSearch when only EXA_API_KEY is set', () => {
    process.env['EXA_API_KEY'] = 'exa-key';
    const provider = getWebSearch();
    expect(provider.id).toBe('exa');
    expect(provider.available).toBe(true);
  });

  it('prefers Tavily over Exa when both keys are set', () => {
    process.env['TAVILY_API_KEY'] = 'tv-key';
    process.env['EXA_API_KEY'] = 'exa-key';
    const provider = getWebSearch();
    expect(provider.id).toBe('tavily');
  });

  it('returns NoopWebSearch when no keys are set', () => {
    const provider = getWebSearch();
    expect(provider.id).toBe('noop-websearch');
    expect(provider.available).toBe(false);
  });

  it('caches the singleton — same instance on repeated calls', () => {
    process.env['TAVILY_API_KEY'] = 'tv-key';
    const a = getWebSearch();
    const b = getWebSearch();
    expect(a).toBe(b);
  });
});
