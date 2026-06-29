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
    id            TEXT PRIMARY KEY,
    app_id        TEXT NOT NULL,
    country       TEXT NOT NULL,
    version       INTEGER NOT NULL,
    stage         TEXT NOT NULL,
    category      TEXT NOT NULL,
    category_band TEXT NOT NULL,
    niche         TEXT,
    niche_band    TEXT,
    audience_json TEXT,
    tally_json    TEXT NOT NULL,
    divergence    TEXT NOT NULL,
    escalate      INTEGER NOT NULL,
    source        TEXT NOT NULL,
    created_at    TEXT NOT NULL
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
