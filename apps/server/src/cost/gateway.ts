/**
 * SourceGateway — single chokepoint for all external HTTP fetches.
 *
 * E0: pure pass-through. Future phases plug in here:
 *   E1 — cache lookup / store  ✓
 *   E2 — spend/loop governor preflight  ✓
 *   E3 — iTunes courtesy pacer  ✓
 */

import { createHash } from 'node:crypto';
import { getGovernor, GovernorDenialError } from './governor';
import { getPacer } from './pacer';
import { getCache } from './cache';
import { logger } from '../telemetry';

export { GovernorDenialError } from './governor';

export type EntityKind = 'app' | 'competitor' | 'asset';
export type UpstreamKind = 'itunes' | 'competitors' | 'crawler' | 'reviews' | 'vision' | 'appkittie' | 'embedding' | 'websearch';

const CACHE_TTL_SECONDS: Partial<Record<UpstreamKind, number>> = {
  itunes: 24 * 60 * 60,         // 24h  — core metadata changes slowly
  competitors: 7 * 24 * 60 * 60, // 7d   — search results stable week-to-week
  reviews: 2 * 60 * 60,          // 2h   — reviews accumulate fast
  crawler: 24 * 60 * 60,         // 24h
  appkittie: 24 * 60 * 60,       // 24h
  websearch: 7 * 24 * 60 * 60,   // 7d   — corroboration is stable
};

const CACHEABLE_UPSTREAMS = new Set<UpstreamKind>(['itunes', 'competitors', 'reviews', 'crawler', 'appkittie', 'websearch']);

export interface GatewayCall {
  kind: EntityKind;
  upstream: UpstreamKind;
  /** For cache key — e.g. `${appId}:${country}`, competitor appId, or asset URL fingerprint. */
  entityId?: string;
  /** Set true for --fresh runs to bypass cache lookup. */
  skipCache?: boolean;
  /** Audit tenant — threaded through for telemetry. */
  tenantId?: string;
}

export interface SourceGateway {
  /**
   * Make a metered HTTP fetch through the gateway.
   * E0: pure pass-through. E2: governor preflight. E3: pacer for iTunes. E1: cache lookup/store.
   */
  fetch(url: string, call: GatewayCall, init?: RequestInit): Promise<Response>;
}

export class PassthroughGateway implements SourceGateway {
  // In-run same-key coalescing: maps cache key → in-flight body-text promise.
  // When two concurrent requests target the same cacheable entity, the second
  // waits for the first's result rather than issuing a duplicate upstream call.
  #inFlight = new Map<string, Promise<string>>();

  async fetch(url: string, call: GatewayCall, init?: RequestInit): Promise<Response> {
    const shouldCache =
      CACHEABLE_UPSTREAMS.has(call.upstream) &&
      call.kind !== 'asset' &&
      !call.skipCache;

    // Compute the cache key once — used in both the lookup and the store.
    const key = shouldCache
      ? (call.entityId
          ? `${call.upstream}:${call.entityId}`
          : `${call.upstream}:${createHash('sha256').update(url).digest('hex').slice(0, 16)}`)
      : null;

    // 1. Cache lookup — happens BEFORE governor so cache hits are truly free.
    if (key) {
      const hit = await getCache().get<string>(key);
      if (hit) {
        return new Response(hit.value, {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'X-Cache': 'HIT', 'X-Fetched-At': hit.fetchedAt },
        });
      }
    }

    // 2. In-flight coalescing — also free (no governor, no pacer).
    if (key) {
      const pending = this.#inFlight.get(key);
      if (pending) {
        const coalescedStartMs = Date.now();
        const text = await pending; // rejects if the primary fetch failed; fetchWithRetry will retry
        logger.info({
          event: 'provider_call',
          provider: call.upstream,
          operation: call.kind,
          durationMs: Date.now() - coalescedStartMs,
          status: 'ok',
          coalesced: true,
          ...(call.tenantId ? { tenantId: call.tenantId } : {}),
        });
        return new Response(text, {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'X-Cache': 'HIT-COALESCED' },
        });
      }
    }

    // 3. Governor preflight — counts only real upstream calls (cache misses).
    const denial = getGovernor().preflight();
    if (!denial.ok) {
      throw new GovernorDenialError(denial.error, url, call);
    }

    // 4. Courtesy throttle — iTunes/reviews only (shared IP, ~20 calls/min ceiling).
    if (call.upstream === 'itunes' || call.upstream === 'reviews') {
      await getPacer().wait();
    }

    const startMs = Date.now();

    // 5a. Cacheable path: register an in-flight promise BEFORE awaiting the fetch
    //     so any concurrent caller that passes step 2 after us coalesces correctly.
    if (key) {
      const bodyPromise = fetch(url, init).then(async (response) => {
        if (!response.ok) throw response; // non-OK: reject so the caller sees the real response
        const text = await response.text();
        const ttl = CACHE_TTL_SECONDS[call.upstream] ?? 3600;
        await getCache().set(key, text, ttl);
        return text;
      });
      this.#inFlight.set(key, bodyPromise); // synchronous — before any await
      try {
        const text = await bodyPromise;
        this.#logProviderCall(call, startMs, 'ok', { httpStatus: 200 });
        return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        if (e instanceof Response) {
          this.#logProviderCall(call, startMs, 'error', { httpStatus: (e as Response).status });
          return e; // non-OK HTTP: pass through to fetchWithRetry
        }
        throw e; // network / timeout error
      } finally {
        this.#inFlight.delete(key);
      }
    }

    // 5b. Non-cacheable path: plain pass-through.
    const res = await fetch(url, init);
    this.#logProviderCall(call, startMs, res.ok ? 'ok' : 'error', { httpStatus: res.status });
    return res;
  }

  #logProviderCall(call: GatewayCall, startMs: number, status: 'ok' | 'error' | 'timeout', extra: { httpStatus?: number; errorMessage?: string } = {}): void {
    logger.info({
      event: 'provider_call',
      provider: call.upstream,
      operation: call.kind,
      durationMs: Date.now() - startMs,
      status,
      ...(call.tenantId ? { tenantId: call.tenantId } : {}),
      ...(extra.httpStatus !== undefined ? { httpStatus: extra.httpStatus } : {}),
      ...(extra.errorMessage ? { errorMessage: extra.errorMessage } : {}),
    });
  }
}

let _gateway: SourceGateway | null = null;

export function getGateway(): SourceGateway {
  if (!_gateway) _gateway = new PassthroughGateway();
  return _gateway;
}

/** Replace the singleton — used in tests to inject a stub. */
export function setGateway(g: SourceGateway): void {
  _gateway = g;
}
