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
  // Phase 6b: durable audit job queue
  `CREATE TABLE IF NOT EXISTS aso_audit_jobs (
    id                   TEXT PRIMARY KEY,
    run_id               TEXT NOT NULL UNIQUE,
    tenant_id            TEXT NOT NULL,
    url                  TEXT NOT NULL,
    reopen_identity      INTEGER NOT NULL DEFAULT 0,
    status               TEXT NOT NULL,
    step                 TEXT,
    suspend_payload_json TEXT,
    resume_data_json     TEXT,
    result_json          TEXT,
    error_message        TEXT,
    attempt              INTEGER NOT NULL DEFAULT 0,
    max_attempts         INTEGER NOT NULL DEFAULT 3,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    claimed_at           TIMESTAMPTZ,
    completed_at         TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS aso_audit_jobs_status_created ON aso_audit_jobs (status, created_at)`,
  `CREATE INDEX IF NOT EXISTS aso_audit_jobs_run_id ON aso_audit_jobs (run_id)`,
  // Auth tables — moved from LibSQL so refresh tokens work across multiple instances
  `CREATE TABLE IF NOT EXISTS aso_users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS aso_refresh_tokens (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES aso_users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS aso_refresh_tokens_user_id ON aso_refresh_tokens (user_id)`,
  // HTTP response cache — Postgres counterpart of the LibSQL aso_cache table.
  // Uses TIMESTAMPTZ for proper expiry comparisons across replicas with different timezones.
  `CREATE TABLE IF NOT EXISTS aso_cache (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS aso_cache_expires ON aso_cache (expires_at)`,
  // Phase P7-A: per-tenant App Store Connect credentials (encrypted)
  `CREATE TABLE IF NOT EXISTS aso_asc_credentials (
    tenant_id        TEXT PRIMARY KEY,
    key_id           TEXT NOT NULL,
    issuer_id        TEXT NOT NULL,
    private_key_enc  TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  // Phase P7-B: continuous tracking registry
  `CREATE TABLE IF NOT EXISTS aso_tracked_apps (
    tenant_id       TEXT NOT NULL,
    app_id          TEXT NOT NULL,
    country         TEXT NOT NULL DEFAULT 'us',
    bundle_id       TEXT NOT NULL DEFAULT '',
    app_name        TEXT NOT NULL,
    url             TEXT NOT NULL,
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    enabled_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_scanned_at TIMESTAMPTZ,
    PRIMARY KEY (tenant_id, app_id, country)
  )`,
  // Phase P7-B: append-only change event log
  `CREATE TABLE IF NOT EXISTS aso_change_events (
    id           TEXT PRIMARY KEY,
    tenant_id    TEXT NOT NULL,
    app_id       TEXT NOT NULL,
    country      TEXT NOT NULL DEFAULT 'us',
    event_type   TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS aso_change_events_tenant_created
    ON aso_change_events (tenant_id, created_at DESC)`,
  // Phase P7-C: per-version measurement window state machine
  `CREATE TABLE IF NOT EXISTS aso_measurement_windows (
    id                  TEXT PRIMARY KEY,
    tenant_id           TEXT NOT NULL,
    app_id              TEXT NOT NULL,
    country             TEXT NOT NULL DEFAULT 'us',
    version_string      TEXT NOT NULL,
    rec_keys_json       TEXT NOT NULL DEFAULT '[]',
    mixed_authorship    BOOLEAN NOT NULL DEFAULT FALSE,
    opened_at           TIMESTAMPTZ NOT NULL,
    regime              TEXT NOT NULL DEFAULT 'correlational',
    state               TEXT NOT NULL,
    baseline_request_id TEXT,
    after_request_id    TEXT,
    baseline_json       TEXT,
    after_json          TEXT,
    verdict_json        TEXT,
    error_message       TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS aso_measurement_windows_tenant_state
    ON aso_measurement_windows (tenant_id, state, updated_at DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS aso_measurement_windows_uniq_version
    ON aso_measurement_windows (tenant_id, app_id, country, version_string)`,
  `ALTER TABLE aso_listing_snapshots ADD COLUMN screenshot_hash TEXT`,
  `ALTER TABLE aso_audit_jobs ADD COLUMN cost_json TEXT`,
  `ALTER TABLE aso_audit_jobs ADD COLUMN advanced_audit BOOLEAN NOT NULL DEFAULT FALSE`,
  // Phase P8-B: listing update tracking with review workflow
  `CREATE TABLE IF NOT EXISTS aso_listing_updates (
    id                   TEXT PRIMARY KEY,
    tenant_id            TEXT NOT NULL,
    app_id               TEXT NOT NULL,
    audit_job_id         TEXT REFERENCES aso_audit_jobs(id),
    proposed_fields      JSONB NOT NULL,
    applied_fields       JSONB,
    asc_localization_id  TEXT,
    status               TEXT NOT NULL DEFAULT 'draft',
    rejection_reason     TEXT,
    submitted_at         TIMESTAMPTZ,
    resolved_at          TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS aso_listing_updates_tenant_app
    ON aso_listing_updates (tenant_id, app_id)`,
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
