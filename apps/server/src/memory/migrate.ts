import { createClient, type Client } from '@libsql/client';

/**
 * The migration runner for the agent's own `aso_*` tables.
 *
 * These live in the *same* LibSQL database Mastra uses (see `mastra/index.ts`),
 * so our tables sit beside Mastra's under a clear `aso_` namespace — that
 * shared file is the whole point of the namespace. We talk to it through a raw
 * `@libsql/client` (no ORM): `@mastra/libsql` only wraps the same client
 * internally.
 *
 * Every statement is idempotent (`CREATE TABLE/INDEX IF NOT EXISTS`), so the
 * runner is safe to call on every boot. Each phase of the build appends its
 * tables to {@link MIGRATIONS}; Phase 0 ships the runner with the list empty.
 */

/**
 * Ordered DDL statements. Idempotent and append-only: never edit a shipped
 * statement to change a table's shape — add a new `ALTER`/`CREATE` instead, so
 * existing databases migrate forward cleanly.
 */
export const MIGRATIONS: readonly string[] = [
  // ── Phase A1: ID-lite + P1 persistent memory (Build Appendix §A) ──────────
  // JSON-bearing columns (listing_json, evidence_json, tally_json, …) hold
  // serialised domain objects; the StorageClient validates them on read, so the
  // schema stays portable (no SQLite-only types) for the future Postgres swap.
  `CREATE TABLE IF NOT EXISTS aso_listing_snapshots (
    id              TEXT PRIMARY KEY,
    app_id          TEXT NOT NULL,
    country         TEXT NOT NULL,
    fetched_at      TEXT NOT NULL,
    listing_json    TEXT NOT NULL,
    signals_json    TEXT NOT NULL,
    report_json     TEXT NOT NULL,
    rubric_version  TEXT NOT NULL,
    prompt_hash     TEXT NOT NULL,
    model_id        TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS aso_listing_snapshots_app
    ON aso_listing_snapshots (app_id, country, fetched_at DESC)`,

  `CREATE TABLE IF NOT EXISTS aso_recommendations (
    id               TEXT PRIMARY KEY,
    app_id           TEXT NOT NULL,
    country          TEXT NOT NULL,
    rec_key          TEXT NOT NULL,
    value_key        TEXT NOT NULL,
    taxonomy_version TEXT,
    dimension        TEXT NOT NULL,
    intent           TEXT NOT NULL,
    target_field     TEXT,
    title            TEXT NOT NULL,
    body             TEXT NOT NULL,
    before_text      TEXT,
    after_text       TEXT,
    evidence_json    TEXT NOT NULL,
    status           TEXT NOT NULL,
    superseded_by    TEXT,
    first_seen_at    TEXT NOT NULL,
    last_seen_at     TEXT NOT NULL,
    applied_at       TEXT,
    proof_regime     TEXT NOT NULL
  )`,
  // One live row per logical recommendation (spec §A) — the dedup invariant.
  `CREATE UNIQUE INDEX IF NOT EXISTS aso_recommendations_reckey
    ON aso_recommendations (app_id, country, rec_key)`,

  `CREATE TABLE IF NOT EXISTS aso_identity_versions (
    id                    TEXT PRIMARY KEY,
    app_id                TEXT NOT NULL,
    country               TEXT NOT NULL,
    version               INTEGER NOT NULL,
    stage                 TEXT NOT NULL,
    category              TEXT NOT NULL,
    category_band         TEXT NOT NULL,
    niche                 TEXT,
    niche_band            TEXT,
    audience_json         TEXT,
    tally_json            TEXT NOT NULL,
    divergence            TEXT NOT NULL,
    escalate              INTEGER NOT NULL,
    source                TEXT NOT NULL,
    created_at            TEXT NOT NULL,
    overrode_evidence_json TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS aso_identity_versions_app
    ON aso_identity_versions (app_id, country, version DESC)`,

  `CREATE TABLE IF NOT EXISTS aso_competitors (
    id                TEXT PRIMARY KEY,
    identity_id       TEXT NOT NULL,
    competitor_app_id TEXT NOT NULL,
    basis             TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS aso_competitor_tombstones (
    app_id            TEXT NOT NULL,
    country           TEXT NOT NULL,
    competitor_app_id TEXT NOT NULL,
    rejected_at       TEXT NOT NULL,
    PRIMARY KEY (app_id, country, competitor_app_id)
  )`,

  `CREATE TABLE IF NOT EXISTS aso_rec_occurrences (
    rec_id        TEXT NOT NULL,
    snapshot_id   TEXT NOT NULL,
    was_dismissed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (rec_id, snapshot_id)
  )`,

  // ── Phase B1: Vision Pass — add vision_result column ────────────────────────
  // Append-only, idempotent: ALTER TABLE fails silently if the column already
  // exists in SQLite (PRAGMA table_info guard would be more portable but SQLite
  // does not support IF NOT EXISTS on ALTER TABLE). We rely on the try/catch in
  // runMigrations to make this safe on repeated boots.
  // NOTE: This migration is wrapped specially in runMigrations below.
  `ALTER TABLE aso_listing_snapshots ADD COLUMN vision_result_json TEXT`,

  // ── Phase C4: Keyword Candidates — add candidate_result column ──────────────
  `ALTER TABLE aso_listing_snapshots ADD COLUMN candidate_result_json TEXT`,

  // ── Phase D2: Theme Analysis — add theme_result column ──────────────────────
  `ALTER TABLE aso_listing_snapshots ADD COLUMN theme_result_json TEXT`,

  // ── Phase D3: Function-grounded competitor seeds — add column ───────────────
  // Stores the identity seeds (niche + category strings) used for AppKittie lookup
  // so selectFunctionCompetitors can skip the API on unchanged identity.
  `ALTER TABLE aso_listing_snapshots ADD COLUMN function_competitor_seeds_json TEXT`,

  // ── Phase F-K2: Competitor review mining result — add column ────────────────
  // Stores the mined competitor pain points so we can skip the LLM+review-fetch
  // on re-audits with unchanged D3 competitors.
  `ALTER TABLE aso_listing_snapshots ADD COLUMN competitor_mining_result_json TEXT`,

  // ── Phase E1: Source cache ────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS aso_cache (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS aso_cache_expires
  ON aso_cache (expires_at)`,

  // ── Phase B-Vision: Identity override evidence marker ─────────────────────────
  // Stores the evidence a human override contested so later runs can re-surface
  // the conflict. Added to the CREATE TABLE above for fresh DBs; this ALTER
  // handles existing databases (idempotent via runMigrations error-suppression).
  `ALTER TABLE aso_identity_versions ADD COLUMN overrode_evidence_json TEXT`,

  // ── Phase 6a: Auth — user accounts + refresh tokens ──────────────────────────
  `CREATE TABLE IF NOT EXISTS aso_users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS aso_refresh_tokens (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES aso_users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    revoked_at  TEXT,
    created_at  TEXT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS aso_refresh_tokens_user
    ON aso_refresh_tokens (user_id, revoked_at)`,

  // ── Phase 6a: Tenant isolation — add tenant_id to all aso_* data tables ──────
  // DEFAULT 'default' lets all existing single-user beta rows migrate forward.
  `ALTER TABLE aso_listing_snapshots     ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`,
  `ALTER TABLE aso_recommendations       ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`,
  `ALTER TABLE aso_rec_occurrences       ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`,
  `ALTER TABLE aso_identity_versions     ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`,
  `ALTER TABLE aso_competitor_tombstones ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`,

  // Fix the aso_recommendations unique index to include tenant_id, so two
  // tenants auditing the same app do not corrupt each other's recommendations
  // via the ON CONFLICT clause.
  `DROP INDEX IF EXISTS aso_recommendations_reckey`,
  `CREATE UNIQUE INDEX IF NOT EXISTS aso_recommendations_tenant_reckey
    ON aso_recommendations (tenant_id, app_id, country, rec_key)`,

  // Composite indexes for fast per-tenant lookups (supplement existing indexes)
  `CREATE INDEX IF NOT EXISTS aso_listing_snapshots_tenant_app
    ON aso_listing_snapshots (tenant_id, app_id, country, fetched_at DESC)`,
  `CREATE INDEX IF NOT EXISTS aso_recommendations_tenant_app
    ON aso_recommendations (tenant_id, app_id, country)`,
  `CREATE INDEX IF NOT EXISTS aso_identity_versions_tenant_app
    ON aso_identity_versions (tenant_id, app_id, country, version DESC)`,
  `CREATE INDEX IF NOT EXISTS aso_competitor_tombstones_tenant_app
    ON aso_competitor_tombstones (tenant_id, app_id, country)`,

  // aso_rec_occurrences has no app_id/country (it joins via rec_id → aso_recommendations);
  // index tenant_id alone for any future per-tenant queries.
  `CREATE INDEX IF NOT EXISTS aso_rec_occurrences_tenant
    ON aso_rec_occurrences (tenant_id)`,
];

/** Open a raw LibSQL client against the given url (defaults to the app DB). */
export function openDb(url = 'file:./aso-audit.db'): Client {
  return createClient({ url });
}

/**
 * Run every pending migration. Idempotent — running it repeatedly is a no-op
 * once the tables exist. Accepts either a url (opens and closes its own
 * client) or an existing client (left open for the caller to manage).
 *
 * ALTER TABLE migrations (like adding a column) are executed with error
 * suppression so they are safe to re-run if the column already exists.
 * SQLite does not support `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
 */
export async function runMigrations(
  target: string | Client = 'file:./aso-audit.db',
): Promise<void> {
  const ownsClient = typeof target === 'string';
  const db = ownsClient ? openDb(target) : target;
  try {
    for (const stmt of MIGRATIONS) {
      if (stmt.trimStart().toUpperCase().startsWith('ALTER TABLE')) {
        // ALTER TABLE is not idempotent in SQLite — ignore "duplicate column" errors.
        try {
          await db.execute(stmt);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // SQLite error for duplicate column: "duplicate column name: ..."
          if (!msg.toLowerCase().includes('duplicate column')) throw e;
        }
      } else {
        await db.execute(stmt);
      }
    }
  } finally {
    if (ownsClient) db.close();
  }
}
