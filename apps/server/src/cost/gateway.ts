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

export { GovernorDenialError } from './governor';

export type EntityKind = 'app' | 'competitor' | 'asset';
export type UpstreamKind = 'itunes' | 'crawler' | 'reviews' | 'vision' | 'appkittie' | 'embedding';

const CACHE_TTL_SECONDS: Partial<Record<UpstreamKind, number>> = {
  itunes: 24 * 60 * 60,    // 24h
  reviews: 2 * 60 * 60,    // 2h
  crawler: 24 * 60 * 60,   // 24h
  appkittie: 24 * 60 * 60, // 24h
};

const CACHEABLE_UPSTREAMS = new Set<UpstreamKind>(['itunes', 'reviews', 'crawler', 'appkittie']);

export interface GatewayCall {
  kind: EntityKind;
  upstream: UpstreamKind;
  /** For cache key — e.g. `${appId}:${country}`, competitor appId, or asset URL fingerprint. */
  entityId?: string;
  /** Set true for --fresh runs to bypass cache lookup. */
  skipCache?: boolean;
}

export interface SourceGateway {
  /**
   * Make a metered HTTP fetch through the gateway.
   * E0: pure pass-through. E2: governor preflight. E3: pacer for iTunes. E1: cache lookup/store.
   */
  fetch(url: string, call: GatewayCall, init?: RequestInit): Promise<Response>;
}

export class PassthroughGateway implements SourceGateway {
  async fetch(url: string, call: GatewayCall, init?: RequestInit): Promise<Response> {
    // 1. Cache lookup — happens BEFORE governor so cache hits are truly free:
    //    no metered-call count, no pacer delay, no upstream call.
    const shouldCache =
      CACHEABLE_UPSTREAMS.has(call.upstream) &&
      call.kind !== 'asset' &&
      !call.skipCache;

    if (shouldCache) {
      const key = call.entityId
        ? `${call.upstream}:${call.entityId}`
        : `${call.upstream}:${createHash('sha256').update(url).digest('hex').slice(0, 16)}`;
      const hit = await getCache().get<string>(key);
      if (hit) {
        return new Response(hit.value, {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'X-Cache': 'HIT',
            'X-Fetched-At': hit.fetchedAt,
          },
        });
      }
    }

    // 2. Governor preflight — counts only real upstream calls (cache misses)
    const denial = getGovernor().preflight();
    if (!denial.ok) {
      throw new GovernorDenialError(denial.error, url, call);
    }

    // 3. Courtesy throttle — iTunes only (shared IP, ~20 calls/min ceiling)
    if (call.upstream === 'itunes' || call.upstream === 'reviews') {
      await getPacer().wait();
    }

    // 4. Real fetch
    const response = await fetch(url, init);

    // 5. Cache the response body on success
    if (shouldCache && response.ok) {
      const key = call.entityId
        ? `${call.upstream}:${call.entityId}`
        : `${call.upstream}:${createHash('sha256').update(url).digest('hex').slice(0, 16)}`;
      const text = await response.text();
      const ttl = CACHE_TTL_SECONDS[call.upstream] ?? 3600;
      await getCache().set(key, text, ttl);
      const contentType = response.headers.get('Content-Type') ?? 'application/json';
      return new Response(text, { status: response.status, headers: { 'Content-Type': contentType } });
    }

    return response;
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
