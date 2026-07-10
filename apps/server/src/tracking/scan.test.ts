import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import postgres from 'postgres';
import { runPgMigrations } from '../memory/pg-migrate';
import { runScan } from './scan';
import { getLastChangeEvent, insertChangeEvent } from './store';

const TEST_URL = process.env.DATABASE_TEST_URL ?? 'postgresql://aso:aso@localhost:5432/aso_audit_test';

vi.mock('../asc/credential-store', () => ({
  loadCredentials: vi.fn().mockResolvedValue({ ok: true, value: { keyId: 'K', issuerId: 'I', privateKeyPem: '---BEGIN EC PRIVATE KEY---\nfake\n---END EC PRIVATE KEY---' } }),
}));

const mockGetVersions = vi.fn();
vi.mock('../asc/versions-client', () => ({
  getAppStoreVersionsClient: () => ({ getAppVersions: mockGetVersions }),
}));

const mockFetch = vi.fn();
vi.mock('../cost/gateway', () => ({
  getGateway: () => ({ fetch: mockFetch }),
}));

const mockInsertJob = vi.fn().mockResolvedValue({ id: 'job_123' });
vi.mock('../queue/job-store', () => ({
  insertJob: (...args: any[]) => mockInsertJob(...args),
}));

vi.mock('../memory/ids', () => ({
  newId: (prefix: string) => `${prefix}_test_id`,
}));

describe('runScan', () => {
  const schema = `tracking_scan_test_${Date.now()}`;
  let sql: postgres.Sql;

  const baseApp = {
    appId: '12345', country: 'us', bundleId: '', appName: 'My App',
    url: 'https://apps.apple.com/app/id12345',
    enabled: true, enabledAt: new Date().toISOString(), lastScannedAt: null,
  };

  beforeAll(async () => {
    sql = postgres(TEST_URL, { connection: { search_path: schema } });
    await sql`CREATE SCHEMA IF NOT EXISTS ${sql(schema)}`;
    await runPgMigrations(sql);
  });

  afterAll(async () => {
    await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`;
    await sql.end();
  });

  it('emits version_status event when version changes', async () => {
    mockGetVersions.mockResolvedValueOnce({ ok: true, value: [{ versionString: '2.0.0', state: 'PREPARE_FOR_SUBMISSION', createdDate: '2026-01-01T00:00:00Z', earliestReleaseDate: null }] });
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }));

    await insertChangeEvent(sql, 'scan-t1', {
      appId: '12345', country: 'us', eventType: 'version_status',
      payload: { versionString: '1.0.0', state: 'READY_FOR_SALE' },
    });

    await runScan(baseApp, 'scan-t1', sql, {} as any);

    const last = await getLastChangeEvent(sql, 'scan-t1', '12345', 'us', 'version_status');
    expect(last?.payload).toMatchObject({ versionString: '2.0.0', state: 'PREPARE_FOR_SUBMISSION' });
  });

  it('emits go_live and calls insertJob on READY_FOR_SALE transition with new version', async () => {
    mockGetVersions.mockResolvedValueOnce({ ok: true, value: [{ versionString: '3.0.0', state: 'READY_FOR_SALE', createdDate: '2026-01-02T00:00:00Z', earliestReleaseDate: null }] });
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    mockInsertJob.mockResolvedValueOnce({ id: 'job_go_live' });

    await insertChangeEvent(sql, 'scan-t2', {
      appId: '12345', country: 'us', eventType: 'version_status',
      payload: { versionString: '2.5.0', state: 'PENDING_DEVELOPER_RELEASE' },
    });

    await runScan(baseApp, 'scan-t2', sql, {} as any);

    const goLive = await getLastChangeEvent(sql, 'scan-t2', '12345', 'us', 'go_live');
    expect(goLive?.payload).toMatchObject({ versionString: '3.0.0' });
    expect(mockInsertJob).toHaveBeenCalled();
  });

  it('does NOT emit go_live for same version already in READY_FOR_SALE', async () => {
    mockInsertJob.mockClear();
    mockGetVersions.mockResolvedValueOnce({ ok: true, value: [{ versionString: '1.0.0', state: 'READY_FOR_SALE', createdDate: '2026-01-01T00:00:00Z', earliestReleaseDate: null }] });
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }));

    await insertChangeEvent(sql, 'scan-t3', {
      appId: '12345', country: 'us', eventType: 'version_status',
      payload: { versionString: '1.0.0', state: 'READY_FOR_SALE' },
    });

    await runScan(baseApp, 'scan-t3', sql, {} as any);

    expect(mockInsertJob).not.toHaveBeenCalled();
    const goLive = await getLastChangeEvent(sql, 'scan-t3', '12345', 'us', 'go_live');
    expect(goLive).toBeNull();
  });

  it('emits metadata_changed when title differs from snapshot', async () => {
    mockGetVersions.mockResolvedValueOnce({ ok: true, value: [] });

    const snapshot = { name: 'Old Name', subtitle: null, description: 'desc', iconUrl: null, rating: 4.5, ratingCount: 100 };
    await sql`
      INSERT INTO aso_listing_snapshots (id, app_id, country, tenant_id, fetched_at, listing_json, signals_json, report_json, rubric_version, prompt_hash, model_id)
      VALUES ('snap-meta', '12345', 'us', 'scan-t4', NOW() - INTERVAL '1 hour', ${JSON.stringify(snapshot)}, '{}', '{}', 'v1', 'h1', 'm1')
    `;
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      results: [{ trackName: 'New Name', subtitle: null, description: 'desc', artworkUrl512: null, averageUserRating: 4.5, userRatingCount: 100 }],
    }), { status: 200 }));

    await runScan(baseApp, 'scan-t4', sql, {} as any);

    const changed = await getLastChangeEvent(sql, 'scan-t4', '12345', 'us', 'metadata_changed');
    expect(changed?.payload).toMatchObject({ field: 'name', before: 'Old Name', after: 'New Name' });
  });

  it('emits reviews_shifted when rating changes by ≥0.1', async () => {
    mockGetVersions.mockResolvedValueOnce({ ok: true, value: [] });

    const snapshot = { name: 'App', subtitle: null, description: 'desc', iconUrl: null, rating: 4.2, ratingCount: 500 };
    await sql`
      INSERT INTO aso_listing_snapshots (id, app_id, country, tenant_id, fetched_at, listing_json, signals_json, report_json, rubric_version, prompt_hash, model_id)
      VALUES ('snap-rev', '12345', 'us', 'scan-t5', NOW() - INTERVAL '1 hour', ${JSON.stringify(snapshot)}, '{}', '{}', 'v1', 'h1', 'm1')
    `;
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      results: [{ trackName: 'App', subtitle: null, description: 'desc', artworkUrl512: null, averageUserRating: 4.4, userRatingCount: 500 }],
    }), { status: 200 }));

    await runScan(baseApp, 'scan-t5', sql, {} as any);

    const shifted = await getLastChangeEvent(sql, 'scan-t5', '12345', 'us', 'reviews_shifted');
    expect(shifted?.payload).toMatchObject({ ratingBefore: 4.2, ratingAfter: 4.4 });
  });

  it('check 2 and 3 still run when loadCredentials returns null (no credentials)', async () => {
    const { loadCredentials } = await import('../asc/credential-store');
    vi.mocked(loadCredentials).mockResolvedValueOnce({ ok: true, value: null });

    const snapshot = { name: 'App', subtitle: 'Old Sub', description: 'Old Desc', iconUrl: null, rating: 4.0, ratingCount: 10 };
    await sql`
      INSERT INTO aso_listing_snapshots (id, app_id, country, tenant_id, fetched_at, listing_json, signals_json, report_json, rubric_version, prompt_hash, model_id)
      VALUES ('snap-nocreds', '12345', 'us', 'scan-t6', NOW() - INTERVAL '1 hour', ${JSON.stringify(snapshot)}, '{}', '{}', 'v1', 'h1', 'm1')
    `;
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      results: [{ trackName: 'App', subtitle: 'Old Sub', description: 'New Desc', artworkUrl512: null, averageUserRating: 4.0, userRatingCount: 10 }],
    }), { status: 200 }));

    await runScan(baseApp, 'scan-t6', sql, {} as any);

    const changed = await getLastChangeEvent(sql, 'scan-t6', '12345', 'us', 'metadata_changed');
    expect(changed?.payload).toMatchObject({ field: 'description', before: 'Old Desc', after: 'New Desc' });
  });
});
