# Phase 6a — Postgres Swap Design

## Goal

Replace the LibSQL/SQLite storage engine with self-hosted PostgreSQL so that multiple server instances share one durable data store. The swap is validated by running the existing `StorageClient` conformance suite against the new `PostgresStorageClient` implementation.

## Context

The beta ran on a single LibSQL/SQLite file per machine. Phase 6a requires shared storage so that two instances see the same audit data. LibSQL's HTTP mode exists but adds operational complexity; a standard Postgres instance is the right choice for a self-hosted, Docker-based deployment. The `StorageClient` interface is the seam — only the implementation changes; all workflow, audit-memory, and route code is unaffected.

Start fresh: existing beta SQLite data is not migrated. Postgres starts with empty tables; re-running an audit regenerates snapshots from the live App Store.

---

## Section 1: Infrastructure

### Docker Compose

`compose.yml` at repository root:

```yaml
services:
  db:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_USER: aso
      POSTGRES_PASSWORD: aso
      POSTGRES_DB: aso_audit
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U aso -d aso_audit"]
      interval: 5s
      timeout: 3s
      retries: 10

volumes:
  pgdata:
```

### Environment variables

Added to `.env` (and `.env.example`):

```
DATABASE_URL=postgresql://aso:aso@localhost:5432/aso_audit
DATABASE_TEST_URL=postgresql://aso:aso@localhost:5432/aso_audit_test
```

`LIBSQL_URL` and `LIBSQL_AUTH_TOKEN` remain in `.env` as optional; if `DATABASE_URL` is set it takes precedence in the factory.

---

## Section 2: Migration Runner

### File

`apps/server/src/memory/pg-migrate.ts`

### Behaviour

Imports the same `MIGRATIONS` array from `migrate.ts` and applies each statement to Postgres via `postgres.js`. Key difference from the LibSQL runner: Postgres supports `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` natively, so duplicate-column errors never occur — no error suppression needed. Non-`ALTER` statements are idempotent by construction (`IF NOT EXISTS`).

```typescript
export async function runPgMigrations(url: string): Promise<void>
```

Called once on server boot alongside (or instead of) `runMigrations`. The `mastra/index.ts` boot sequence checks `DATABASE_URL`; if present, calls `runPgMigrations`.

### SQL compatibility

All statements in the existing `MIGRATIONS` array are standard SQL compatible with Postgres 17:
- `CREATE TABLE IF NOT EXISTS` ✓
- `CREATE INDEX IF NOT EXISTS` ✓
- `DROP INDEX IF EXISTS` ✓
- `ALTER TABLE ... ADD COLUMN` ✓ (Postgres adds `IF NOT EXISTS` support natively)
- `ON CONFLICT (...)` ✓

---

## Section 3: PostgresStorageClient

### File

`apps/server/src/memory/postgres-storage-client.ts`

### Interface

Implements `StorageClient` identically to `LibSQLStorageClient`. All 10 method signatures are unchanged. The only differences are internal:

| LibSQL | Postgres (postgres.js) |
|---|---|
| `{ sql: '...', args: [...] }` | Tagged template `` sql`... ${val}` `` |
| `INSERT OR IGNORE INTO` | `INSERT INTO ... ON CONFLICT DO NOTHING` |
| `ON CONFLICT(cols) DO UPDATE` | `ON CONFLICT (cols) DO UPDATE SET` (same) |
| `row['col_name']` | `row.col_name` (typed by postgres.js) |

Boolean columns (`was_dismissed`) are stored as `INTEGER` (0/1) in both engines — no type change.

### Constructor

```typescript
export class PostgresStorageClient implements StorageClient {
  constructor(private sql: postgres.Sql) {}
}
```

A `postgres.Sql` instance is passed in; the class does not own the connection pool.

### Factory

`apps/server/src/memory/index.ts` — `getStorage()` updated:

```typescript
export async function getStorage(): Promise<StorageClient> {
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    if (!_pgStorage) {
      const sql = postgres(dbUrl);
      await runPgMigrations(dbUrl);
      _pgStorage = new PostgresStorageClient(sql);
    }
    return _pgStorage;
  }
  // fallback: existing LibSQL path
  ...
}
```

---

## Section 4: Conformance Suite

### File

`apps/server/src/memory/postgres-storage-client.test.ts`

### Behaviour

Imports and runs `storageClientConformanceSuite` (the same function used in `libsql-storage-client.test.ts`) with a `makeClient()` factory that:

1. Connects to `DATABASE_TEST_URL`
2. Creates a unique schema name per test run (`aso_test_<uuid>`)
3. Runs `runPgMigrations` scoped to that schema
4. Returns a `PostgresStorageClient`
5. Tears down the schema in `afterAll`

Each test run gets a clean schema, so tests are fully isolated and can run against a shared Postgres instance without conflicts.

### Definition of Done (6a swap)

From `specification.md §F`:
> LibSQL→Postgres swap passes the same StorageClient test suite.

The conformance suite includes the cross-tenant isolation test added in Task 2 of the auth phase — this must also pass against Postgres.

---

## New dependencies

| Package | Purpose |
|---|---|
| `postgres` | postgres.js — TypeScript-first Postgres client |

No ORM. All SQL is written directly, matching the project's existing raw-SQL style.

---

## New environment variables

| Variable | Purpose | Required |
|---|---|---|
| `DATABASE_URL` | Postgres connection string | Yes (when using Postgres) |
| `DATABASE_TEST_URL` | Separate test database | Yes for Postgres conformance tests |
