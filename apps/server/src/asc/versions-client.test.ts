import { describe, it, expect } from 'vitest';
import { StubAppStoreVersionsClient, NoOpAppStoreVersionsClient } from './versions-client';

describe('StubAppStoreVersionsClient', () => {
  it('returns canned AppVersion list', async () => {
    const stub = new StubAppStoreVersionsClient([
      { versionString: '2.1.0', state: 'READY_FOR_SALE', createdDate: '2026-01-01T00:00:00Z', earliestReleaseDate: null },
    ]);
    const result = await stub.getAppVersions('any');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0].versionString).toBe('2.1.0');
    expect(result.value[0].state).toBe('READY_FOR_SALE');
  });
});

describe('NoOpAppStoreVersionsClient', () => {
  it('returns empty array', async () => {
    const noop = new NoOpAppStoreVersionsClient();
    const result = await noop.getAppVersions('any');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });
});

// Live smoke test — only runs when real creds are present
const LIVE = process.env.ASC_KEY_ID && process.env.ASC_ISSUER_ID && process.env.ASC_PRIVATE_KEY;
describe.skipIf(!LIVE)('AppleAppStoreVersionsClient (live)', () => {
  it('returns versions for a real app', async () => {
    const { getAppStoreVersionsClient } = await import('./versions-client');
    const client = getAppStoreVersionsClient({
      keyId: process.env.ASC_KEY_ID!,
      issuerId: process.env.ASC_ISSUER_ID!,
      privateKeyPem: process.env.ASC_PRIVATE_KEY!,
    });
    // Apple Pages app — always exists in the App Store
    const result = await client.getAppVersions('361309726');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeGreaterThan(0);
    expect(result.value[0].state).toBeTruthy();
  });
});
