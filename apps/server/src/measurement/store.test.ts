import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { runPgMigrations } from '../memory/pg-migrate';
import { openWindow, getWindowsInState, updateWindowState } from './store';

const TEST_URL = process.env.DATABASE_TEST_URL ?? 'postgresql://aso:aso@localhost:5432/aso_audit_test';

describe('measurement store', () => {
  const schema = `measurement_store_test_${Date.now()}`;
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

  it('openWindow creates a row in awaiting_baseline state', async () => {
    const w = await openWindow(sql, 'tenantA', {
      appId: 'APP1', country: 'us', versionString: '1.0.0',
      openedAt: new Date('2026-06-01T00:00:00Z'), recKeys: ['k1'], mixedAuthorship: false,
    });
    expect(w).not.toBeNull();
    expect(w!.state).toBe('awaiting_baseline');
    expect(w!.id.startsWith('win_')).toBe(true);
    expect(w!.recKeys).toEqual(['k1']);
    expect(w!.regime).toBe('correlational');
    expect(w!.baselineRequestId).toBeNull();
  });

  it('openWindow returns null and does not create second window for duplicate (tenantId, appId, country, versionString)', async () => {
    const first = await openWindow(sql, 'tenantB', {
      appId: 'APP2', country: 'us', versionString: '2.0.0',
      openedAt: new Date('2026-06-01T00:00:00Z'), recKeys: [], mixedAuthorship: false,
    });
    expect(first).not.toBeNull();

    const dup = await openWindow(sql, 'tenantB', {
      appId: 'APP2', country: 'us', versionString: '2.0.0',
      openedAt: new Date('2026-06-02T00:00:00Z'), recKeys: ['x'], mixedAuthorship: true,
    });
    expect(dup).toBeNull();

    const rows = await sql`
      SELECT id FROM aso_measurement_windows
      WHERE tenant_id = 'tenantB' AND app_id = 'APP2' AND country = 'us' AND version_string = '2.0.0'
    `;
    expect(rows).toHaveLength(1);
  });

  it('getWindowsInState returns only windows matching the given state', async () => {
    await openWindow(sql, 'tenantC', {
      appId: 'APP3', country: 'us', versionString: '3.0.0',
      openedAt: new Date('2026-06-01T00:00:00Z'), recKeys: [], mixedAuthorship: false,
    });
    const awaiting = await getWindowsInState(sql, 'awaiting_baseline');
    const c = awaiting.find((w) => w.tenantId === 'tenantC');
    expect(c).toBeDefined();

    const polling = await getWindowsInState(sql, 'polling_after');
    expect(polling.find((w) => w.tenantId === 'tenantC')).toBeUndefined();
  });

  it('updateWindowState advances state and persists provided updates (baselineRequestId stored, unprovided fields unchanged)', async () => {
    const w = await openWindow(sql, 'tenantD', {
      appId: 'APP4', country: 'us', versionString: '4.0.0',
      openedAt: new Date('2026-06-01T00:00:00Z'), recKeys: ['k4'], mixedAuthorship: true,
    });
    expect(w).not.toBeNull();

    await updateWindowState(sql, w!.id, 'polling_baseline', { baselineRequestId: 'req-123' });

    const polling = await getWindowsInState(sql, 'polling_baseline');
    const found = polling.find((x) => x.id === w!.id);
    expect(found).toBeDefined();
    expect(found!.state).toBe('polling_baseline');
    expect(found!.baselineRequestId).toBe('req-123');
    // unprovided fields unchanged
    expect(found!.recKeys).toEqual(['k4']);
    expect(found!.mixedAuthorship).toBe(true);
    expect(found!.afterRequestId).toBeNull();

    // A second update that provides only afterRequestId must not wipe baselineRequestId
    await updateWindowState(sql, w!.id, 'polling_after', { afterRequestId: 'req-after' });
    const after = await getWindowsInState(sql, 'polling_after');
    const found2 = after.find((x) => x.id === w!.id);
    expect(found2!.baselineRequestId).toBe('req-123');
    expect(found2!.afterRequestId).toBe('req-after');
  });
});
