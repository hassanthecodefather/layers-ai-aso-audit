import { openDb, runMigrations } from './migrate';
import { LibSqlStorageClient } from './libsql-storage-client';
import { storageClientConformance } from './storage-client.conformance';

/**
 * Certify the LibSQL implementation against the engine-agnostic contract. When
 * the Postgres client lands (P6/6a), it gets its own one-liner here calling the
 * *same* `storageClientConformance` — that's the swap-is-a-config-change proof.
 */
storageClientConformance('LibSQL (in-memory)', async () => {
  const db = openDb(':memory:');
  await runMigrations(db);
  return { client: new LibSqlStorageClient(db), close: () => db.close() };
});
