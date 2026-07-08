import postgres from 'postgres';
import { storageClientConformance } from './storage-client.conformance';
import { PostgresStorageClient } from './postgres-storage-client';
import { runPgMigrations } from './pg-migrate';

const TEST_URL =
  process.env.DATABASE_TEST_URL ?? 'postgresql://aso:aso@localhost:5432/aso_audit_test';

storageClientConformance('Postgres', async () => {
  // Each call gets a unique Postgres schema — fully isolated, concurrent-safe.
  const schema = `aso_conf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const sql = postgres(TEST_URL, {
    connection: { search_path: schema },
    max: 3,
  });
  await sql`CREATE SCHEMA IF NOT EXISTS ${sql(schema)}`;
  await runPgMigrations(sql);
  const client = new PostgresStorageClient(sql);
  return {
    client,
    close: async () => {
      await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`;
      await sql.end();
    },
  };
});
