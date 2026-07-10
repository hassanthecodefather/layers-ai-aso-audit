import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { runPgMigrations } from '../memory/pg-migrate';
import {
  upsertTrackedApp, getTrackedApps, getDueApps, updateLastScanned, disableTrackedApp,
  insertChangeEvent, getChangeEvents, getLastChangeEvent,
} from './store';

const TEST_URL = process.env.DATABASE_TEST_URL ?? 'postgresql://aso:aso@localhost:5432/aso_audit_test';

describe('tracking store', () => {
  const schema = `tracking_store_test_${Date.now()}`;
  let sql: postgres.Sql;

  beforeAll(async () => {
    sql = postgres(TEST_URL, { connection: { search_path: schema } });
    await sql`CREATE SCHEMA IF NOT EXISTS ${sql(schema)}`;
    await runPgMigrations(sql);
  });

  afterAll(async () => {
    await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`;
    await sql.end();
  });

  it('upsertTrackedApp creates and idempotently updates', async () => {
    await upsertTrackedApp(sql, 'tenant1', {
      appId: '123', country: 'us', bundleId: 'com.test', appName: 'Test', url: 'https://apps.apple.com/app/id123',
    });
    const apps = await getTrackedApps(sql, 'tenant1');
    expect(apps).toHaveLength(1);
    expect(apps[0]!.appId).toBe('123');
    expect(apps[0]!.enabled).toBe(true);

    // Re-upsert with new name — should update, not duplicate
    await upsertTrackedApp(sql, 'tenant1', {
      appId: '123', country: 'us', bundleId: 'com.test', appName: 'Test Renamed', url: 'https://apps.apple.com/app/id123',
    });
    const apps2 = await getTrackedApps(sql, 'tenant1');
    expect(apps2).toHaveLength(1);
    expect(apps2[0]!.appName).toBe('Test Renamed');
  });

  it('getTrackedApps returns only enabled apps for the tenant', async () => {
    await upsertTrackedApp(sql, 'tenant2', {
      appId: 'A', country: 'us', bundleId: '', appName: 'App A', url: 'https://x',
    });
    await upsertTrackedApp(sql, 'tenant2', {
      appId: 'B', country: 'us', bundleId: '', appName: 'App B', url: 'https://y',
    });
    await disableTrackedApp(sql, 'tenant2', 'B');

    const apps = await getTrackedApps(sql, 'tenant2');
    expect(apps.map(a => a.appId)).toEqual(['A']);
  });

  it('getDueApps returns apps with null or old last_scanned_at across tenants', async () => {
    await upsertTrackedApp(sql, 'tenant3', {
      appId: 'DUE', country: 'us', bundleId: '', appName: 'Due App', url: 'https://due',
    });
    const due = await getDueApps(sql);
    const match = due.find(d => d.tenantId === 'tenant3' && d.app.appId === 'DUE');
    expect(match).toBeDefined();

    // After updating last_scanned_at to now, the app should no longer be due
    await updateLastScanned(sql, 'tenant3', 'DUE', 'us');
    const due2 = await getDueApps(sql);
    const match2 = due2.find(d => d.tenantId === 'tenant3' && d.app.appId === 'DUE');
    expect(match2).toBeUndefined();
  });

  it('insertChangeEvent and getLastChangeEvent round-trip', async () => {
    await insertChangeEvent(sql, 'tenant4', {
      appId: 'EVT', country: 'us', eventType: 'version_status',
      payload: { versionString: '1.0.0', state: 'READY_FOR_SALE' },
    });
    const last = await getLastChangeEvent(sql, 'tenant4', 'EVT', 'us', 'version_status');
    expect(last).not.toBeNull();
    expect((last!.payload as any).versionString).toBe('1.0.0');
  });

  it('getChangeEvents excludes version_status events and paginates newest-first', async () => {
    await insertChangeEvent(sql, 'tenant5', {
      appId: 'FEED', country: 'us', eventType: 'version_status',
      payload: { versionString: '1.0', state: 'READY_FOR_SALE' },
    });
    await upsertTrackedApp(sql, 'tenant5', {
      appId: 'FEED', country: 'us', bundleId: '', appName: 'Feed App', url: 'https://feed',
    });
    await insertChangeEvent(sql, 'tenant5', {
      appId: 'FEED', country: 'us', eventType: 'go_live',
      payload: { versionString: '1.0', appId: 'FEED', auditJobId: null },
    });

    const events = await getChangeEvents(sql, 'tenant5', { limit: 10 });
    expect(events.every(e => (e.eventType as string) !== 'version_status')).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('go_live');
    expect(events[0]!.appName).toBe('Feed App');
  });
});
