import { signAscToken } from './auth';
import { getGateway } from '../cost/gateway';
import { ok, err } from '../domain/result';
import type { Result } from '../domain/result';
import type { AppVersion, AscError } from './types';
import type { AscCredentials } from './credential-store';

const ASC_BASE = 'https://api.appstoreconnect.apple.com';

export interface AppStoreVersionsClient {
  getAppVersions(appId: string): Promise<Result<AppVersion[], AscError>>;
}

export class AppleAppStoreVersionsClient implements AppStoreVersionsClient {
  constructor(private readonly creds: AscCredentials) {}

  async getAppVersions(appId: string): Promise<Result<AppVersion[], AscError>> {
    const token = signAscToken(this.creds.keyId, this.creds.issuerId, this.creds.privateKeyPem);
    const url = `${ASC_BASE}/v1/apps/${encodeURIComponent(appId)}/appStoreVersions?filter[platform]=IOS&sort=-createdDate&limit=10`;

    let response: Response;
    try {
      response = await getGateway().fetch(url, { kind: 'app', upstream: 'asc' }, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (e) {
      return err({ kind: 'api_error', status: 0, detail: String(e) });
    }

    if (response.status === 401 || response.status === 403) {
      return err({ kind: 'auth_failed', status: response.status });
    }
    if (response.status === 404) {
      return err({ kind: 'not_found', appId });
    }
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      return err({ kind: 'rate_limited', retryAfterMs: retryAfter ? Number(retryAfter) * 1000 : 60_000 });
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return err({ kind: 'api_error', status: response.status, detail: detail.slice(0, 200) });
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      return err({ kind: 'parse_error', raw: 'non-JSON response' });
    }

    return ok(parseVersions(data));
  }
}

function parseVersions(data: unknown): AppVersion[] {
  const d = data as { data?: unknown[] };
  if (!Array.isArray(d?.data)) return [];
  return d.data.map((item: unknown) => {
    const i = item as { attributes?: Record<string, unknown> };
    const a = i?.attributes ?? {};
    return {
      versionString: typeof a['versionString'] === 'string' ? a['versionString'] : '',
      state: typeof a['appStoreState'] === 'string' ? a['appStoreState'] : '',
      createdDate: typeof a['createdDate'] === 'string' ? a['createdDate'] : '',
      earliestReleaseDate: typeof a['earliestReleaseDate'] === 'string' ? a['earliestReleaseDate'] : null,
    };
  });
}

export class StubAppStoreVersionsClient implements AppStoreVersionsClient {
  constructor(private readonly versions: AppVersion[]) {}
  async getAppVersions(_appId: string): Promise<Result<AppVersion[], AscError>> {
    return ok(this.versions);
  }
}

export class NoOpAppStoreVersionsClient implements AppStoreVersionsClient {
  async getAppVersions(_appId: string): Promise<Result<AppVersion[], AscError>> {
    return ok([]);
  }
}

export function getAppStoreVersionsClient(creds: AscCredentials): AppStoreVersionsClient {
  return new AppleAppStoreVersionsClient(creds);
}
