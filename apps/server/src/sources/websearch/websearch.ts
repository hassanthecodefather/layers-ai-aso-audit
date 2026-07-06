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
    return MIRROR_DOMAINS.has(hostname);
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
      const body = JSON.stringify({
        api_key: this.#apiKey,
        query,
        search_depth: 'basic',
        max_results: 5,
      });
      const res = await getGateway().fetch(
        TAVILY_URL,
        { kind: 'app', upstream: 'websearch', entityId: `tavily:${queryKey(query)}` },
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        },
      );
      if (!res.ok) {
        console.warn(`[tavily] HTTP ${res.status} — treating as errored`);
        return ok({ state: 'errored', reason: `HTTP ${res.status}` });
      }
      const json = await res.json() as { results?: { title: string; url: string }[] };
      const results = json.results ?? [];
      const genuine = results.filter((r) => !isMirrorUrl(r.url));
      console.log(`[tavily] results=${results.length} raw (${results.length - genuine.length} mirror-filtered) → ${genuine.length === 0 ? 'searched_and_empty' : 'corroborated'}`);
      if (genuine.length === 0) return ok({ state: 'searched_and_empty' });
      return ok({
        state: 'corroborated',
        sources: genuine.map((r) => ({ title: r.title, url: r.url })),
      });
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
      const body = JSON.stringify({ query, num_results: 5 });
      const res = await getGateway().fetch(
        EXA_URL,
        { kind: 'app', upstream: 'websearch', entityId: `exa:${queryKey(query)}` },
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
        return ok({ state: 'errored', reason: `HTTP ${res.status}` });
      }
      const json = await res.json() as { results?: { title: string; url: string }[] };
      const results = json.results ?? [];
      const genuine = results.filter((r) => !isMirrorUrl(r.url));
      if (genuine.length === 0) return ok({ state: 'searched_and_empty' });
      return ok({
        state: 'corroborated',
        sources: genuine.map((r) => ({ title: r.title, url: r.url })),
      });
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
