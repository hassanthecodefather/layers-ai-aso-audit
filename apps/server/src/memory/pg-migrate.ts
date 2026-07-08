import postgres from 'postgres';
import { MIGRATIONS } from './migrate';

/**
 * Postgres-only DDL that uses Postgres-specific types (e.g. TIMESTAMPTZ).
 * Applied by runPgMigrations AFTER the shared MIGRATIONS array.
 * The shared limiter plan (2026-07-08-6a-shared-limiter.md) adds to this array.
 */
export const PG_ONLY_MIGRATIONS: readonly string[] = [
  // Phase 6a: rate slot table — added by shared-limiter plan
  `CREATE TABLE IF NOT EXISTS aso_rate_slots (
    key             TEXT PRIMARY KEY,
    next_allowed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `INSERT INTO aso_rate_slots (key, next_allowed_at)
     VALUES ('itunes', NOW())
     ON CONFLICT (key) DO NOTHING`,
  // Fix aso_competitor_tombstones PRIMARY KEY to include tenant_id for correct cross-tenant isolation.
  // LibSQL does not support DROP/ADD CONSTRAINT so this must live here, not in MIGRATIONS.
  // Wrapped in a DO block: the IF NOT EXISTS guard prevents re-running on already-correct schemas,
  // and the EXCEPTION handler makes concurrent startup (rolling restart) safe.
  `DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = 'aso_competitor_tombstones'::regclass
      AND i.indisprimary AND a.attname = 'tenant_id'
  ) THEN
    ALTER TABLE aso_competitor_tombstones DROP CONSTRAINT IF EXISTS aso_competitor_tombstones_pkey;
    ALTER TABLE aso_competitor_tombstones ADD PRIMARY KEY (tenant_id, app_id, country, competitor_app_id);
  END IF;
-- Only swallow concurrent-startup races (another instance already applied the same DDL).
-- Constraint violations from pre-existing dirty data are intentionally re-raised so the
-- operator sees a clear error instead of silently running with the wrong 3-column PK.
EXCEPTION WHEN duplicate_object OR duplicate_table OR lock_not_available THEN NULL;
END $$`,
  // Fix aso_rec_occurrences PRIMARY KEY to include tenant_id so two tenants
  // whose audits share the same rec_id (unlikely but possible with deterministic
  // hashing) don't corrupt each other's occurrence tracking via the ON CONFLICT.
  `DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = 'aso_rec_occurrences'::regclass
      AND i.indisprimary AND a.attname = 'tenant_id'
  ) THEN
    ALTER TABLE aso_rec_occurrences DROP CONSTRAINT IF EXISTS aso_rec_occurrences_pkey;
    ALTER TABLE aso_rec_occurrences ADD PRIMARY KEY (tenant_id, rec_id, snapshot_id);
  END IF;
EXCEPTION WHEN duplicate_object OR duplicate_table OR lock_not_available THEN NULL;
END $$`,
];

/**
 * Apply all migrations to the connected Postgres instance.
 * ALTER TABLE ... ADD COLUMN statements are rewritten to ADD COLUMN IF NOT
 * EXISTS before execution so that re-running migrations is idempotent.
 * The shared MIGRATIONS array intentionally omits IF NOT EXISTS because LibSQL
 * does not support it; this layer injects it only for Postgres.
 * The caller is responsible for setting search_path on the sql connection if
 * schema isolation is required (e.g. in tests).
 */
export async function runPgMigrations(sql: postgres.Sql): Promise<void> {
  for (const stmt of [...MIGRATIONS, ...PG_ONLY_MIGRATIONS]) {
    const normalized = /^\s*ALTER\s+TABLE\b/i.test(stmt)
      ? stmt.replace(/\bADD\s+COLUMN\b(?!\s+IF\s+NOT\s+EXISTS)/gi, 'ADD COLUMN IF NOT EXISTS')
      : stmt;
    await sql.unsafe(normalized);
  }
}
