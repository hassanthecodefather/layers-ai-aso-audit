import { openDb, runMigrations } from './migrate';
import { LibSqlStorageClient } from './libsql-storage-client';
import type { StorageClient } from './storage-client';

export type { StorageClient } from './storage-client';

/**
 * The process-wide storage handle. One LibSQL client over the same DB Mastra
 * uses (see `mastra/index.ts`); migrations run once on first use, so the agent
 * code just calls `getStorage()` and never touches SQL or migration timing.
 *
 * In beta this is a singleton (one user, one process). P6/6a swaps the
 * implementation for a Postgres-backed `StorageClient` behind this same call —
 * a config change, per the §B contract.
 */
let pending: Promise<StorageClient> | null = null;

export function getStorage(
  url = process.env.ASO_DB_URL?.trim() || 'file:./aso-audit.db',
): Promise<StorageClient> {
  if (!pending) {
    pending = (async () => {
      const db = openDb(url);
      await runMigrations(db);
      return new LibSqlStorageClient(db);
    })();
  }
  return pending;
}

/** Reset the singleton — tests only, so each gets an isolated in-memory DB. */
export function __resetStorageForTests(): void {
  pending = null;
}
