import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { runPgMigrations } from './pg-migrate';

const TEST_URL = process.env.DATABASE_TEST_URL ?? 'postgresql://aso:aso@localhost:5432/aso_audit_test';

describe('runPgMigrations', () => {
  let sql: postgres.Sql;
  const schema = `pgmig_test_${Date.now()}`;

  beforeAll(async () => {
    sql = postgres(TEST_URL, { connection: { search_path: schema } });
    await sql`CREATE SCHEMA IF NOT EXISTS ${sql(schema)}`;
    await runPgMigrations(sql);
  });

  afterAll(async () => {
    await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`;
    await sql.end();
  });

  it('creates aso_listing_snapshots', async () => {
    const rows = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${schema} AND table_name = 'aso_listing_snapshots'
    `;
    expect(rows).toHaveLength(1);
  });

  it('creates aso_recommendations', async () => {
    const rows = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${schema} AND table_name = 'aso_recommendations'
    `;
    expect(rows).toHaveLength(1);
  });

  it('creates aso_users', async () => {
    const rows = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${schema} AND table_name = 'aso_users'
    `;
    expect(rows).toHaveLength(1);
  });

  it('creates aso_refresh_tokens', async () => {
    const rows = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${schema} AND table_name = 'aso_refresh_tokens'
    `;
    expect(rows).toHaveLength(1);
  });

  it('aso_listing_snapshots has tenant_id column', async () => {
    const rows = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${schema}
        AND table_name = 'aso_listing_snapshots'
        AND column_name = 'tenant_id'
    `;
    expect(rows).toHaveLength(1);
  });

  it('creates aso_audit_jobs', async () => {
    const rows = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${schema} AND table_name = 'aso_audit_jobs'
    `;
    expect(rows).toHaveLength(1);
  });

  it('aso_audit_jobs has required columns', async () => {
    const rows = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${schema} AND table_name = 'aso_audit_jobs'
    `;
    const cols = rows.map((r) => r.column_name);
    expect(cols).toContain('run_id');
    expect(cols).toContain('tenant_id');
    expect(cols).toContain('status');
    expect(cols).toContain('suspend_payload_json');
    expect(cols).toContain('resume_data_json');
    expect(cols).toContain('attempt');
    expect(cols).toContain('claimed_at');
  });
});
