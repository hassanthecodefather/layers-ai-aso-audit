import { createHash } from 'node:crypto';
import { ok, type Result } from '../../domain/result';
import { getGateway } from '../../cost/gateway';

/**
 * The external-corroboration tier of the identity ladder (spec ID "No
 * footprint? A confidence ladder, not a cliff").
 *
 * Tri-state contract (spec ID "Absence is information"):
 *   corroborated    — at least one off-store result found; raises confidence
 *   searched_and_empty — genuinely queried, found nothing; small penalty
 *   errored         — transport failure; never penalises (tool error ≠ absence)
 *
 * Keys land in .env → factory wires the real client; fallback is NoopWebSearch.
 * REST over the gateway (metered + cached 7d), never MCP (browser-auth only).
 */
export type WebSearchProbe =
  | { state: 'corroborated'; sources: { title: string; url: string }[] }
  | { state: 'searched_and_empty' }
  | { state: 'errored'; reason: string };

export interface WebSearchProvider {
  readonly id: string;
  /** Whether a real search backend is configured. */
  readonly available: boolean;
  /** Probe for an off-store footprint corroborating `query`. Never throws. */
  probe(query: string): Promise<Result<WebSearchProbe>>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function queryKey(query: string): string {
  return createHash('sha256').update(query).digest('hex').slice(0, 16);
}

// Tavily returns HTTP 400 on long queries (identity fact sheets can exceed this).
const MAX_QUERY_CHARS = 400;

function capQuery(query: string): string {
  if (query.length <= MAX_QUERY_CHARS) return query;
  // Trim at the last word boundary before the cap so the query stays readable.
  const truncated = query.slice(0, MAX_QUERY_CHARS);
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated;
}

function survivorHosts(results: { url: string }[]): string {
  return results
    .map((r) => { try { return new URL(r.url).hostname; } catch { return r.url; } })
    .join(', ');
}

// App Store mirrors and aggregator sites — their pages are reposts of Apple's
// own data, not independent third-party coverage, so they must not count as
// off-store corroboration.
const MIRROR_DOMAINS = new Set([
  'apps.apple.com',
  'apptopia.com',
  'appadvice.com',
  'justuseapp.com',
  'sensortower.com',
  'appfigures.com',
  'mobileaction.co',
  'appannie.com',
  'data.ai',
]);

function isMirrorUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    // Suffix match, not exact: aggregators serve listings from subdomains
    // (app.sensortower.com, foo.data.ai). Match the registrable root or any
    // subdomain of it, so a listed root catches its whole domain.
    for (const d of MIRROR_DOMAINS) {
      if (hostname === d || hostname.endsWith(`.${d}`)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ── Tavily ────────────────────────────────────────────────────────────────────

const TAVILY_URL = 'https://api.tavily.com/search';

export class TavilyWebSearch implements WebSearchProvider {
  readonly id = 'tavily';
  readonly available = true;
  #apiKey: string;

  constructor(apiKey: string) {
    this.#apiKey = apiKey;
  }

  async probe(query: string): Promise<Result<WebSearchProbe>> {
    try {
      const cappedQuery = capQuery(query);
      const body = JSON.stringify({
        api_key: this.#apiKey,
        query: cappedQuery,
        search_depth: 'basic',
        max_results: 5,
      });
      const res = await getGateway().fetch(
        TAVILY_URL,
        // Cache key must hash the capped query — that is what Tavily actually receives.
        // Hashing the raw query would produce different keys for queries whose only
        // difference is beyond the 400-char cap, causing duplicate API calls.
        { kind: 'app', upstream: 'websearch', entityId: `tavily:${queryKey(cappedQuery)}` },
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        },
      );
      if (!res.ok) {
        // Drain the response body so the underlying connection returns to the pool.
        // Skipping this on repeated 429s / 5xxs progressively exhausts the pool.
        await res.body?.cancel();
        console.warn(`[tavily] HTTP ${res.status} — treating as errored`);
        return ok({ state: 'errored', reason: `HTTP ${res.status}` });
      }
      const json = await res.json() as { results?: { title: string; url: string }[] };
      const results = json.results ?? [];
      const genuine = results.filter((r) => !isMirrorUrl(r.url));
      // Derive state once and use it in both the log and the return — a single
      // source of truth so adding a third state can't produce a log/return mismatch.
      const state: 'searched_and_empty' | 'corroborated' =
        genuine.length === 0 ? 'searched_and_empty' : 'corroborated';
      const survivorNote = genuine.length > 0 ? ` · survivors: ${survivorHosts(genuine)}` : '';
      console.log(`[tavily] results=${results.length} raw (${results.length - genuine.length} mirror-filtered) → ${state}${survivorNote}`);
      if (state === 'searched_and_empty') return ok({ state });
      return ok({ state, sources: genuine.map((r) => ({ title: r.title, url: r.url })) });
    } catch (e) {
      return ok({ state: 'errored', reason: e instanceof Error ? e.message : String(e) });
    }
  }
}

// ── Exa ──────────────────────────────────────────────────────────────────────

const EXA_URL = 'https://api.exa.ai/search';

export class ExaWebSearch implements WebSearchProvider {
  readonly id = 'exa';
  readonly available = true;
  #apiKey: string;

  constructor(apiKey: string) {
    this.#apiKey = apiKey;
  }

  async probe(query: string): Promise<Result<WebSearchProbe>> {
    try {
      const cappedQuery = capQuery(query);
      const body = JSON.stringify({ query: cappedQuery, num_results: 5 });
      const res = await getGateway().fetch(
        EXA_URL,
        { kind: 'app', upstream: 'websearch', entityId: `exa:${queryKey(cappedQuery)}` },
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.#apiKey}`,
          },
          body,
        },
      );
      if (!res.ok) {
        await res.body?.cancel();
        console.warn(`[exa] HTTP ${res.status} — treating as errored`);
        return ok({ state: 'errored', reason: `HTTP ${res.status}` });
      }
      const json = await res.json() as { results?: { title: string; url: string }[] };
      const results = json.results ?? [];
      const genuine = results.filter((r) => !isMirrorUrl(r.url));
      const state: 'searched_and_empty' | 'corroborated' =
        genuine.length === 0 ? 'searched_and_empty' : 'corroborated';
      const survivorNote = genuine.length > 0 ? ` · survivors: ${survivorHosts(genuine)}` : '';
      console.log(`[exa] results=${results.length} raw (${results.length - genuine.length} mirror-filtered) → ${state}${survivorNote}`);
      if (state === 'searched_and_empty') return ok({ state });
      return ok({ state, sources: genuine.map((r) => ({ title: r.title, url: r.url })) });
    } catch (e) {
      return ok({ state: 'errored', reason: e instanceof Error ? e.message : String(e) });
    }
  }
}

// ── Noop ──────────────────────────────────────────────────────────────────────

/**
 * The keyless default: the lookup is defined to have run and found nothing.
 * `searched_and_empty` (not `errored`) — ID-lite simply starts one rung lower.
 */
export class NoopWebSearch implements WebSearchProvider {
  readonly id = 'noop-websearch';
  readonly available = false;

  async probe(_query: string): Promise<Result<WebSearchProbe>> {
    return ok({ state: 'searched_and_empty' });
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

let singleton: WebSearchProvider | null = null;

/**
 * Active web-search provider.
 * Precedence: TAVILY_API_KEY → TavilyWebSearch
 *             EXA_API_KEY   → ExaWebSearch
 *             (none)        → NoopWebSearch
 */
export function getWebSearch(): WebSearchProvider {
  if (!singleton) singleton = createWebSearch();
  return singleton;
}

function createWebSearch(): WebSearchProvider {
  const tavilyKey = process.env['TAVILY_API_KEY'];
  if (tavilyKey) { console.log('[websearch] provider=tavily'); return new TavilyWebSearch(tavilyKey); }
  const exaKey = process.env['EXA_API_KEY'];
  if (exaKey) { console.log('[websearch] provider=exa'); return new ExaWebSearch(exaKey); }
  console.warn('[websearch] provider=noop (no TAVILY_API_KEY / EXA_API_KEY — footprint always empty)');
  return new NoopWebSearch();
}

/** Replace the singleton — for tests. */
export function setWebSearch(p: WebSearchProvider): void {
  singleton = p;
}

/** Reset to factory default (re-reads env) — for tests. */
export function resetWebSearch(): void {
  singleton = null;
}
