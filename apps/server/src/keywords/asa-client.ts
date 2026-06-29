/**
 * ASA (Apple Search Ads) popularity client — Phase C2.
 *
 * The real OAuth2 client (scope `searchadsorg`, JWT `client_secret`) is the
 * drop-in replacement when the key lands. Until then StubAsaClient returns
 * `available: false` — volume-dependent rankings are labelled
 * "popularity unavailable" so the audit is honest about what it doesn't know.
 *
 * Returns `unavailable` (not zero) — a zero-volume result and an unkeyed
 * result are different things and must not be conflated.
 */

export interface AsaVolume {
  /** True only when the ASA API responded with real data. */
  available: boolean;
  /** Relative popularity 0–100 (Apple Search Ads scale). Present only when available=true. */
  popularity?: number;
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
 * Factory: returns the real client when ASA credentials are set, otherwise
 * falls back to the stub so the keyword linter continues to work without a key.
 */
export function getAsaClient(): AsaClient {
  // Real client drop-in: check for ASA_CLIENT_ID + ASA_TEAM_ID + ASA_KEY_ID + ASA_PRIVATE_KEY
  // and return a real OAuth2 client when present. Not yet built — key pending.
  return new StubAsaClient();
}
