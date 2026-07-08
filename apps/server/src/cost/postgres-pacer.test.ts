import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { PostgresSharedPacer } from './postgres-pacer';
import { runPgMigrations } from '../memory/pg-migrate';

const TEST_URL =
  process.env.DATABASE_TEST_URL ?? 'postgresql://aso:aso@localhost:5432/aso_audit_test';
const MIN_INTERVAL_MS = 3500;

describe('PostgresSharedPacer', () => {
  let sql: postgres.Sql;
  const schema = `pacer_test_${Date.now()}`;
  const pacerSqls: postgres.Sql[] = [];

  beforeAll(async () => {
    sql = postgres(TEST_URL, { connection: { search_path: schema } });
    await sql`CREATE SCHEMA IF NOT EXISTS ${sql(schema)}`;
    await runPgMigrations(sql);
  });

  afterAll(async () => {
    await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`;
    await sql.end();
    // Close all pacer-owned connections to avoid leaked connection warnings
    await Promise.all(pacerSqls.map((s) => s.end()));
  });

  it('sequential calls are spaced at least MIN_INTERVAL_MS apart', async () => {
    const pacerSql = postgres(TEST_URL, { connection: { search_path: schema }, max: 1 });
    pacerSqls.push(pacerSql);
    const pacer = new PostgresSharedPacer(pacerSql);

    const t0 = Date.now();
    await pacer.wait();
    const t1 = Date.now();
    await pacer.wait();
    const t2 = Date.now();

    void t0; // used for context only
    const gap = t2 - t1;
    expect(gap).toBeGreaterThanOrEqual(MIN_INTERVAL_MS - 50); // 50ms tolerance
  }, 20_000);

  it('concurrent callers from two instances serialize — calls spaced >= MIN_INTERVAL_MS', async () => {
    // Reset the slot to now so both callers start from a clean state
    await sql`
      UPDATE aso_rate_slots SET next_allowed_at = NOW() WHERE key = 'itunes'
    `;

    const sqlA = postgres(TEST_URL, { connection: { search_path: schema }, max: 1 });
    const sqlB = postgres(TEST_URL, { connection: { search_path: schema }, max: 1 });
    pacerSqls.push(sqlA, sqlB);

    const pacerA = new PostgresSharedPacer(sqlA);
    const pacerB = new PostgresSharedPacer(sqlB);

    const times: number[] = [];
    await Promise.all([
      pacerA.wait().then(() => times.push(Date.now())),
      pacerB.wait().then(() => times.push(Date.now())),
    ]);

    times.sort((a, b) => a - b);
    expect(times).toHaveLength(2);
    const gap = times[1]! - times[0]!;
    expect(gap).toBeGreaterThanOrEqual(MIN_INTERVAL_MS - 50); // 50ms tolerance
  }, 20_000);
});
