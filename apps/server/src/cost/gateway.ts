/**
 * SourceGateway — single chokepoint for all external HTTP fetches.
 *
 * E0: pure pass-through. Future phases plug in here:
 *   E1 — cache lookup / store
 *   E2 — spend/loop governor preflight
 *   E3 — iTunes courtesy pacer
 */

import { getGovernor, GovernorDenialError } from './governor';

export { GovernorDenialError } from './governor';

export type EntityKind = 'app' | 'competitor' | 'asset';
export type UpstreamKind = 'itunes' | 'crawler' | 'reviews' | 'vision' | 'appkittie' | 'embedding';

export interface GatewayCall {
  kind: EntityKind;
  upstream: UpstreamKind;
  /** For cache key — e.g. `${appId}:${country}`, competitor appId, or asset URL fingerprint. */
  entityId?: string;
}

export interface SourceGateway {
  /**
   * Make a metered HTTP fetch through the gateway.
   * E0: pure pass-through. E2 will add governor preflight. E3 will add pacer
   * for iTunes. E1 will add cache lookup/store.
   */
  fetch(url: string, call: GatewayCall, init?: RequestInit): Promise<Response>;
}

export class PassthroughGateway implements SourceGateway {
  async fetch(url: string, call: GatewayCall, init?: RequestInit): Promise<Response> {
    const denial = getGovernor().preflight();
    if (!denial.ok) {
      throw new GovernorDenialError(denial.error, url, call);
    }
    return fetch(url, init);
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
