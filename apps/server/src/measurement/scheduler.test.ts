import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import { runPgMigrations } from '../memory/pg-migrate';

const mockLoadCredentials = vi.fn();
const mockRequestReport = vi.fn();
const mockPollReport = vi.fn();

vi.mock('../asc/credential-store', () => ({
  loadCredentials: (...args: any[]) => mockLoadCredentials(...args),
}));
vi.mock('./reporter', () => ({
  requestReport: (...args: any[]) => mockRequestReport(...args),
  pollReport: (...args: any[]) => mockPollReport(...args),
}));

import { startMeasurementScheduler } from './scheduler';

const TEST_URL = process.env.DATABASE_TEST_URL ?? 'postgresql://aso:aso@localhost:5432/aso_audit_test';
const fakeMastra = {} as any;

const CREDS = { ok: true, value: { keyId: 'k', issuerId: 'i', privateKeyPem: 'p' } };

async function insertGoLive(
  sql: postgres.Sql,
  tenantId: string,
  appId: string,
  versionString: string,
) {
  await sql`
    INSERT INTO aso_change_events (id, tenant_id, app_id, country, event_type, payload_json, created_at)
    VALUES (${`evt-${tenantId}-${appId}-${versionString}`}, ${tenantId}, ${appId}, 'us', 'go_live',
      ${JSON.stringify({ versionString, appId, auditJobId: null })}, NOW())
  `;
}

// Runs one tick manually by starting + immediately awaiting the first pass, then stopping.
async function runOneTick(sql: postgres.Sql) {
  const handle = startMeasurementScheduler(fakeMastra, sql);
  // Flush the immediate first pass (5 sequential awaited steps + their queries).
  for (let i = 0; i < 50; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 50));
  handle.stop();
}

describe('startMeasurementScheduler', () => {
  const schema = `measurement_sched_test_${Date.now()}`;
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

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadCredentials.mockResolvedValue(CREDS);
  });

  it('step 1 opens a window for an unprocessed go_live event', async () => {
    await insertGoLive(sql, 'T1', 'APP1', '1.0.0');
    // Prevent later steps from touching the new window in the same tick by making requestReport a no-op error-free stub.
    mockRequestReport.mockResolvedValue('req-x');
    mockPollReport.mockResolvedValue({ status: 'pending' });

    await runOneTick(sql);

    const rows = await sql`
      SELECT * FROM aso_measurement_windows WHERE tenant_id = 'T1' AND app_id = 'APP1' AND version_string = '1.0.0'
    `;
    expect(rows).toHaveLength(1);
  });

  it('step 1 skips a go_live event that already has a window (duplicate guard)', async () => {
    await insertGoLive(sql, 'T2', 'APP2', '2.0.0');
    mockRequestReport.mockResolvedValue('req-x');
    mockPollReport.mockResolvedValue({ status: 'pending' });

    await runOneTick(sql); // opens
    await runOneTick(sql); // must not open a second

    const rows = await sql`
      SELECT id FROM aso_measurement_windows WHERE tenant_id = 'T2' AND app_id = 'APP2' AND version_string = '2.0.0'
    `;
    expect(rows).toHaveLength(1);
  });

  it('step 1 skips if loadCredentials returns null', async () => {
    mockLoadCredentials.mockResolvedValue({ ok: true, value: null });
    await insertGoLive(sql, 'T3', 'APP3', '3.0.0');
    mockRequestReport.mockResolvedValue('req-x');
    mockPollReport.mockResolvedValue({ status: 'pending' });

    await runOneTick(sql);

    const rows = await sql`
      SELECT id FROM aso_measurement_windows WHERE tenant_id = 'T3' AND app_id = 'APP3'
    `;
    expect(rows).toHaveLength(0);
  });

  it('a failure in step 1 does not prevent step 2 from running', async () => {
    // Pre-seed an awaiting_baseline window directly (step 2 input) for tenant T4.
    await sql`
      INSERT INTO aso_measurement_windows
        (id, tenant_id, app_id, country, version_string, rec_keys_json, mixed_authorship, opened_at, regime, state)
      VALUES ('win_step2', 'T4', 'APP4', 'us', '4.0.0', '[]', FALSE, ${new Date('2026-06-01T00:00:00Z').toISOString()}, 'correlational', 'awaiting_baseline')
    `;
    // Make step 1 throw by having loadCredentials reject for T_FAIL only; insert a go_live so step 1 reaches loadCredentials.
    await insertGoLive(sql, 'T_FAIL', 'APP-FAIL', '9.9.9');
    mockLoadCredentials.mockImplementation((_sql: any, tenantId: string) => {
      if (tenantId === 'T_FAIL') return Promise.reject(new Error('boom'));
      return Promise.resolve(CREDS);
    });
    mockRequestReport.mockResolvedValue('req-step2');
    mockPollReport.mockResolvedValue({ status: 'pending' });

    await runOneTick(sql);

    // step 2 should have advanced win_step2 to polling_baseline despite step 1 failing
    const rows = await sql`SELECT state, baseline_request_id FROM aso_measurement_windows WHERE id = 'win_step2'`;
    expect(rows[0].state).toBe('polling_baseline');
    expect(rows[0].baseline_request_id).toBe('req-step2');
  });

  it('full state machine: awaiting_baseline → polling_baseline → awaiting_after → polling_after → closed', async () => {
    const readyRows = [{ date: '2026-06-01', impressions: 100, downloads: 10, conversionRate: 5, territory: 'US' }];
    // opened_at is > 30 days ago so step 4 fires.
    const openedAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    await sql`
      INSERT INTO aso_measurement_windows
        (id, tenant_id, app_id, country, version_string, rec_keys_json, mixed_authorship, opened_at, regime, state)
      VALUES ('win_fsm', 'T5', 'APP5', 'us', '5.0.0', '[]', FALSE, ${openedAt}, 'correlational', 'awaiting_baseline')
    `;

    // Tick A: step 2 submits baseline → polling_baseline
    mockRequestReport.mockResolvedValue('req-base');
    mockPollReport.mockResolvedValue({ status: 'pending' });
    await runOneTick(sql);
    let r = await sql`SELECT state FROM aso_measurement_windows WHERE id = 'win_fsm'`;
    expect(r[0].state).toBe('polling_baseline');

    // Tick B: step 3 polls ready → awaiting_after
    mockPollReport.mockResolvedValue({ status: 'ready', rows: readyRows });
    await runOneTick(sql);
    r = await sql`SELECT state FROM aso_measurement_windows WHERE id = 'win_fsm'`;
    // After this tick the window is awaiting_after (step 3), then step 4 (same tick, opened>30d) → polling_after
    // then step 5 polls ready → closed. So one full tick can cascade. Assert final closed.
    expect(r[0].state).toBe('closed');
  });

  it('measurement_verdict change event is emitted when window closes', async () => {
    const events = await sql`
      SELECT event_type, payload_json FROM aso_change_events WHERE tenant_id = 'T5' AND event_type = 'measurement_verdict'
    `;
    expect(events.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(events[0].payload_json);
    expect(payload.versionString).toBe('5.0.0');
    expect(payload.regime).toBe('correlational');
    expect(payload.metrics).toBeDefined();
  });

  it('window moves to error state when pollReport stays pending > 7 days', async () => {
    // Insert a polling_baseline window whose updated_at is 8 days old.
    await sql`
      INSERT INTO aso_measurement_windows
        (id, tenant_id, app_id, country, version_string, rec_keys_json, mixed_authorship, opened_at, regime, state, baseline_request_id, updated_at)
      VALUES ('win_stale', 'T6', 'APP6', 'us', '6.0.0', '[]', FALSE, ${new Date('2026-06-01T00:00:00Z').toISOString()}, 'correlational', 'polling_baseline', 'req-stale',
        ${new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()})
    `;
    mockPollReport.mockResolvedValue({ status: 'pending' });
    mockRequestReport.mockResolvedValue('req-x');

    await runOneTick(sql);

    const r = await sql`SELECT state, error_message FROM aso_measurement_windows WHERE id = 'win_stale'`;
    expect(r[0].state).toBe('error');
    expect(r[0].error_message).toBe('baseline_report_timeout');
  });
});
