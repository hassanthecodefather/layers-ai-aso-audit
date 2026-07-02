/**
 * Keyword volume client seam — Phase C2/C4.
 *
 * Provider precedence (getKeywordProvider):
 *   APP_KITTI_API_KEY set  → AppKittieClient (interim default)
 *   ASA creds set          → (future) real ASA OAuth2 client
 *   else                   → StubAsaClient ("popularity unavailable")
 *
 * The seam stays here; the concrete providers live in their own files so
 * switching is a one-line factory change, not a refactor.
 *
 * StubAsaClient returns `available: false` — never fabricates a zero.
 * An unkeyed result and a genuine zero-volume term are different things.
 */

import { AppKittieClient } from './appkittie-client';

export interface AsaVolume {
  /** True only when the provider responded with real data. */
  available: boolean;
  /** Relative popularity 0–100 (Apple Search Ads scale or AppKittie estimate). Present only when available=true. */
  popularity?: number;
  /** Search difficulty 0–100 (AppKittie). Present only when available=true and the provider supplies it. */
  difficulty?: number;
  /** Human-readable label for the prompt/report. */
  label: string;
}

export interface AsaClient {
  getVolume(term: string, storefront?: string): Promise<AsaVolume>;
}

/**
 * Stub: returns `unavailable` for every term.
 * Replace with the real OAuth2 client once the ASA key is configured.
 */
export class StubAsaClient implements AsaClient {
  async getVolume(_term: string, _storefront?: string): Promise<AsaVolume> {
    return { available: false, label: 'popularity unavailable' };
  }
}

/**
 * Provider factory — checks env vars in precedence order:
 *   1. APP_KITTI_API_KEY → AppKittieClient (interim default)
 *   2. (future) ASA_CLIENT_ID + ASA_TEAM_ID + ASA_KEY_ID + ASA_PRIVATE_KEY → real ASA client
 *   3. StubAsaClient (no-op fallback)
 */
export function getKeywordProvider(): AsaClient {
  const appKittieKey = process.env['APP_KITTI_API_KEY'];
  if (appKittieKey) {
    return new AppKittieClient(appKittieKey);
  }
  // Real ASA OAuth2 client: check for ASA_CLIENT_ID + ASA_TEAM_ID + ASA_KEY_ID + ASA_PRIVATE_KEY
  // Not yet built — key pending.
  return new StubAsaClient();
}

/** @deprecated Use getKeywordProvider() — kept for backward compatibility. */
export function getAsaClient(): AsaClient {
  return getKeywordProvider();
}
