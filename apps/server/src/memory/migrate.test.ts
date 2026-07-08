import { describe, it, expect } from 'vitest';
import { openDb, runMigrations, MIGRATIONS } from './migrate';

/**
 * The migration runner is the foundation every `aso_*` table sits on, so the
 * contract under test is the *harness*, not any one table: it must run on a
 * fresh DB and — critically — be safe to run again on every boot.
 *
 * Uses an in-memory LibSQL database so the test is hermetic (no file, no
 * network). As phases append to `MIGRATIONS`, these same assertions guard that
 * the whole set stays idempotent.
 */
describe('runMigrations', () => {
  it('runs against a fresh database without error', async () => {
    const db = openDb(':memory:');
    try {
      await expect(runMigrations(db)).resolves.toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('is idempotent — running twice on the same DB is a no-op', async () => {
    const db = openDb(':memory:');
    try {
      await runMigrations(db);
      // The whole reason every statement is `IF NOT EXISTS`: a second boot
      // must not throw "table already exists".
      await expect(runMigrations(db)).resolves.toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('creates every table named in MIGRATIONS', async () => {
    const db = openDb(':memory:');
    try {
      await runMigrations(db);
      const created = new Set(
        (
          await db.execute(
            "SELECT name FROM sqlite_master WHERE type='table'",
          )
        ).rows.map((r) => String(r.name)),
      );
      // Derive the expected table names from the DDL itself, so this test
      // tracks MIGRATIONS automatically as later phases append tables.
      const expected = MIGRATIONS.map((stmt) =>
        /create table(?: if not exists)?\s+([a-z0-9_]+)/i.exec(stmt)?.[1],
      ).filter((n): n is string => Boolean(n));
      for (const table of expected) {
        expect(created).toContain(table);
      }
    } finally {
      db.close();
    }
  });

  it('creates aso_users table', async () => {
    const db = openDb(':memory:');
    await runMigrations(db);
    const res = await db.execute(`SELECT name FROM sqlite_master WHERE type='table' AND name='aso_users'`);
    expect(res.rows.length).toBe(1);
    db.close();
  });

  it('creates aso_refresh_tokens table', async () => {
    const db = openDb(':memory:');
    await runMigrations(db);
    const res = await db.execute(`SELECT name FROM sqlite_master WHERE type='table' AND name='aso_refresh_tokens'`);
    expect(res.rows.length).toBe(1);
    db.close();
  });

  it('aso_listing_snapshots has tenant_id column', async () => {
    const db = openDb(':memory:');
    await runMigrations(db);
    const res = await db.execute(`PRAGMA table_info(aso_listing_snapshots)`);
    const cols = res.rows.map((r) => r[1] as string);
    expect(cols).toContain('tenant_id');
    db.close();
  });

  it('aso_recommendations has tenant_id column', async () => {
    const db = openDb(':memory:');
    await runMigrations(db);
    const res = await db.execute(`PRAGMA table_info(aso_recommendations)`);
    const cols = res.rows.map((r) => r[1] as string);
    expect(cols).toContain('tenant_id');
    db.close();
  });

  it('aso_identity_versions has tenant_id column', async () => {
    const db = openDb(':memory:');
    await runMigrations(db);
    const res = await db.execute(`PRAGMA table_info(aso_identity_versions)`);
    const cols = res.rows.map((r) => r[1] as string);
    expect(cols).toContain('tenant_id');
    db.close();
  });

  it('aso_rec_occurrences has tenant_id column', async () => {
    const db = openDb(':memory:');
    await runMigrations(db);
    const res = await db.execute(`PRAGMA table_info(aso_rec_occurrences)`);
    const cols = res.rows.map((r) => r[1] as string);
    expect(cols).toContain('tenant_id');
    db.close();
  });
});
