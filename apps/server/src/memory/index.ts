import postgres from 'postgres';
import { openDb, runMigrations } from './migrate';
import { runPgMigrations } from './pg-migrate';
import { LibSqlStorageClient } from './libsql-storage-client';
import { PostgresStorageClient } from './postgres-storage-client';
import type { StorageClient } from './storage-client';

export type { StorageClient } from './storage-client';

let _pgSql: postgres.Sql | null = null;

/** Returns the shared postgres.Sql instance (created once when DATABASE_URL is set). */
export function getPgSql(): postgres.Sql | null {
  if (!_pgSql && process.env.DATABASE_URL) {
    _pgSql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });
  }
  return _pgSql;
}

let _pgStorage: Promise<StorageClient> | null = null;
let _libsqlStorage: Promise<StorageClient> | null = null;

export function getStorage(
  url = process.env.ASO_DB_URL?.trim() || 'file:./aso-audit.db',
): Promise<StorageClient> {
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    if (!_pgStorage) {
      _pgStorage = (async () => {
        const sql = getPgSql()!;
        await runPgMigrations(sql);
        return new PostgresStorageClient(sql);
      })();
    }
    return _pgStorage;
  }
  // LibSQL fallback
  if (!_libsqlStorage) {
    _libsqlStorage = (async () => {
      const db = openDb(url);
      await runMigrations(db);
      return new LibSqlStorageClient(db);
    })();
  }
  return _libsqlStorage;
}

/** Reset singletons — tests only. */
export function __resetStorageForTests(): void {
  _pgStorage = null;
  _libsqlStorage = null;
  _pgSql = null;
}

import { UserStore } from '../auth/user-store';

let pendingUserStore: Promise<UserStore> | null = null;

// UserStore always uses LibSQL — UserStore uses @libsql/client API directly.
export function getUserStore(
  url = process.env.ASO_DB_URL?.trim() || 'file:./aso-audit.db',
): Promise<UserStore> {
  if (!pendingUserStore) {
    pendingUserStore = (async () => {
      const db = openDb(url);
      await runMigrations(db);
      return new UserStore(db);
    })();
  }
  return pendingUserStore;
}

export function __resetUserStoreForTests(): void {
  pendingUserStore = null;
}
