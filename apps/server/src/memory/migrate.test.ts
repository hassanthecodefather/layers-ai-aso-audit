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
});
