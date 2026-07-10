import { describe, it, expect } from 'vitest';
import { StubAscAnalyticsClient, NoOpAscAnalyticsClient } from './analytics-client';
import type { ReportRow } from './types';

const ROWS: ReportRow[] = [
  { date: '2026-07-01', impressions: 1200, downloads: 80, conversionRate: 0.067, territory: 'US' },
];

describe('StubAscAnalyticsClient', () => {
  it('createReportRequest returns a requestId', async () => {
    const stub = new StubAscAnalyticsClient(ROWS);
    const result = await stub.createReportRequest('APP_STORE_ENGAGEMENT', {
      appId: '123', frequency: 'DAILY', startDate: '2026-07-01', endDate: '2026-07-07',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.value).toBe('string');
  });

  it('pollReportInstance returns ready with rows', async () => {
    const stub = new StubAscAnalyticsClient(ROWS);
    const created = await stub.createReportRequest('APP_STORE_ENGAGEMENT', {
      appId: '123', frequency: 'DAILY', startDate: '2026-07-01', endDate: '2026-07-07',
    });
    if (!created.ok) throw new Error('create failed');
    const result = await stub.pollReportInstance(created.value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('ready');
    if (result.value.status !== 'ready') return;
    expect(result.value.rows).toEqual(ROWS);
  });
});

describe('NoOpAscAnalyticsClient', () => {
  it('createReportRequest returns a fake id', async () => {
    const noop = new NoOpAscAnalyticsClient();
    const result = await noop.createReportRequest('APP_STORE_ENGAGEMENT', {
      appId: '123', frequency: 'DAILY', startDate: '2026-07-01', endDate: '2026-07-07',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe('noop-request-id');
  });

  it('pollReportInstance always returns pending', async () => {
    const noop = new NoOpAscAnalyticsClient();
    const result = await noop.pollReportInstance('any-id');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('pending');
  });
});

const LIVE = process.env.ASC_KEY_ID && process.env.ASC_ISSUER_ID && process.env.ASC_PRIVATE_KEY;
describe.skipIf(!LIVE)('AppleAscAnalyticsClient (live)', () => {
  it('createReportRequest returns a real requestId from Apple', async () => {
    const { getAscAnalyticsClient } = await import('./analytics-client');
    const client = getAscAnalyticsClient({
      keyId: process.env.ASC_KEY_ID!,
      issuerId: process.env.ASC_ISSUER_ID!,
      privateKeyPem: process.env.ASC_PRIVATE_KEY!,
    });
    // Use your own app ID from ASC
    const appId = process.env.ASC_TEST_APP_ID ?? '0000000000';
    const result = await client.createReportRequest('APP_STORE_ENGAGEMENT', {
      appId,
      frequency: 'DAILY',
      startDate: '2026-07-01',
      endDate: '2026-07-07',
    });
    // Log the raw result so we can inspect Apple's actual response shape
    console.log('[live] createReportRequest result:', JSON.stringify(result));
    expect(result.ok).toBe(true);
  });
});
