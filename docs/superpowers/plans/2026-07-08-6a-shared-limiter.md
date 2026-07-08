# Phase 6a — Shared Rate Limiter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the in-process `SerialPacer` with a Postgres-backed `PostgresSharedPacer` so that multiple server instances share a single Apple API rate limit slot, keeping the aggregate call rate within Apple's ~20 calls/min ceiling.

**Architecture:** An `aso_rate_slots` table (one row per upstream, keyed `'itunes'`) is protected by `SELECT ... FOR UPDATE` — serializing concurrent callers across processes. `PostgresSharedPacer` claims a slot atomically, calculates wait time, updates the next-allowed timestamp, then sleeps. The `getPacer()` factory in `pacer.ts` returns `PostgresSharedPacer` when `DATABASE_URL` is set, falling back to the existing `SerialPacer` for local single-instance use.

**Tech Stack:** `postgres` (postgres.js v3, already installed by Phase 6a Postgres Swap plan), PostgreSQL 17, vitest

**Dependency:** This plan assumes the Postgres Swap plan (`2026-07-08-6a-postgres-swap.md`) is fully implemented — specifically Tasks 1–2 (Docker Compose running, `pg-migrate.ts` with `PG_ONLY_MIGRATIONS` and `runPgMigrations` in place).

## Global Constraints

- Node ≥20.12; always use `nvm use 24` before running node/npm commands
- Test runner: vitest — run from `apps/server` with `npx vitest run`
- TypeScript check: `cd apps/server && npx tsc --noEmit`
- No ORM — all SQL written directly as postgres.js template literals
- Specific `git add` only — never `git add -A` or `git add .`
- `DATABASE_TEST_URL=postgresql://aso:aso@localhost:5432/aso_audit_test`
- `SerialPacer` must not be modified — existing `pacer.test.ts` must still pass
- `getPacer()` is the only changed export in `pacer.ts` — `setPacer()` and `SerialPacer` are unchanged
- `PostgresSharedPacer` uses its own postgres.js connection pool — it does NOT use `getPgSql()` from `memory/index.ts`

---

### Task 1: Add `aso_rate_slots` migration to `PG_ONLY_MIGRATIONS`

**Files:**
- Modify: `apps/server/src/memory/pg-migrate.ts`

**Interfaces:**
- Consumes: `PG_ONLY_MIGRATIONS` (currently empty `readonly string[]`)
- Produces: `PG_ONLY_MIGRATIONS` with two DDL statements — `CREATE TABLE IF NOT EXISTS aso_rate_slots` and `INSERT ... ON CONFLICT DO NOTHING` seeding the `'itunes'` row

**Why this task is first:** `PostgresSharedPacer.wait()` requires the `aso_rate_slots` table and the `'itunes'` seed row to exist. Placing the migration here means `runPgMigrations` (called by both `getStorage()` and the boot sequence) creates the table atomically with all other schema changes.

- [ ] **Step 1: Read the current `pg-migrate.ts`**

Read `apps/server/src/memory/pg-migrate.ts` to confirm `PG_ONLY_MIGRATIONS` is empty and the file structure before editing.

- [ ] **Step 2: Update `PG_ONLY_MIGRATIONS`**

Replace the `PG_ONLY_MIGRATIONS` array in `apps/server/src/memory/pg-migrate.ts` with:

```typescript
export const PG_ONLY_MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS aso_rate_slots (
    key             TEXT PRIMARY KEY,
    next_allowed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `INSERT INTO aso_rate_slots (key, next_allowed_at)
     VALUES ('itunes', NOW())
     ON CONFLICT (key) DO NOTHING`,
];
```

- [ ] **Step 3: Run the existing pg-migrate test**

```bash
cd /Users/hassanali/Documents/layers-ai/layers-ai-aso-audit/apps/server
source ~/.nvm/nvm.sh && nvm use 24
npx vitest run src/memory/pg-migrate.test.ts
```

Expected: all 5 existing tests PASS (the new migration statements are idempotent; old tables still created)

- [ ] **Step 4: Verify the slot row exists in the test DB**

```bash
docker compose exec db psql -U aso -d aso_audit_test -c "SELECT * FROM aso_rate_slots;"
```

Expected: one row with `key='itunes'`. If the test schema was dropped after the test run, run migrations manually:

```bash
docker compose exec db psql -U aso -d aso_audit_test -c "
CREATE TABLE IF NOT EXISTS aso_rate_slots (
  key TEXT PRIMARY KEY,
  next_allowed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO aso_rate_slots (key, next_allowed_at) VALUES ('itunes', NOW()) ON CONFLICT (key) DO NOTHING;
SELECT * FROM aso_rate_slots;
"
```

Expected: one row with `key='itunes'`

- [ ] **Step 5: Commit**

```bash
cd /Users/hassanali/Documents/layers-ai/layers-ai-aso-audit
git add apps/server/src/memory/pg-migrate.ts
git commit -m "feat(6a): add aso_rate_slots migration to PG_ONLY_MIGRATIONS"
```

---

### Task 2: `PostgresSharedPacer` implementation and tests

**Files:**
- Create: `apps/server/src/cost/postgres-pacer.ts`
- Create: `apps/server/src/cost/postgres-pacer.test.ts`

**Interfaces:**
- Consumes: `Pacer` interface from `./pacer`
- Produces:
  - `PostgresSharedPacer` class implementing `Pacer`
    - `constructor(sql: postgres.Sql)`
    - `wait(retryAfterMs?: number): Promise<void>`
    - `reset(): void` — no-op

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/cost/postgres-pacer.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { PostgresSharedPacer } from './postgres-pacer';
import { runPgMigrations } from '../memory/pg-migrate';

const TEST_URL =
  process.env.DATABASE_TEST_URL ?? 'postgresql://aso:aso@localhost:5432/aso_audit_test';
const MIN_INTERVAL_MS = 3500;

describe('PostgresSharedPacer', () => {
  let sql: postgres.Sql;
  const schema = `pacer_test_${Date.now()}`;

  beforeAll(async () => {
    sql = postgres(TEST_URL, { connection: { search_path: schema } });
    await sql`CREATE SCHEMA IF NOT EXISTS ${sql(schema)}`;
    await runPgMigrations(sql);
  });

  afterAll(async () => {
    await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`;
    await sql.end();
  });

  it('sequential calls are spaced at least MIN_INTERVAL_MS apart', async () => {
    const pacer = new PostgresSharedPacer(
      postgres(TEST_URL, { connection: { search_path: schema }, max: 1 }),
    );

    const t0 = Date.now();
    await pacer.wait();
    const t1 = Date.now();
    await pacer.wait();
    const t2 = Date.now();

    const gap = t2 - t1;
    expect(gap).toBeGreaterThanOrEqual(MIN_INTERVAL_MS - 50); // 50ms tolerance
  }, 20_000);

  it('concurrent callers from two instances serialize — calls spaced >= MIN_INTERVAL_MS', async () => {
    // Reset the slot to now so both callers start from a clean state
    await sql`
      UPDATE aso_rate_slots SET next_allowed_at = NOW() WHERE key = 'itunes'
    `;

    const pacerA = new PostgresSharedPacer(
      postgres(TEST_URL, { connection: { search_path: schema }, max: 1 }),
    );
    const pacerB = new PostgresSharedPacer(
      postgres(TEST_URL, { connection: { search_path: schema }, max: 1 }),
    );

    const times: number[] = [];
    await Promise.all([
      pacerA.wait().then(() => times.push(Date.now())),
      pacerB.wait().then(() => times.push(Date.now())),
    ]);

    times.sort((a, b) => a - b);
    const gap = times[1] - times[0];
    expect(gap).toBeGreaterThanOrEqual(MIN_INTERVAL_MS - 50); // 50ms tolerance
  }, 20_000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/hassanali/Documents/layers-ai/layers-ai-aso-audit/apps/server
source ~/.nvm/nvm.sh && nvm use 24
npx vitest run src/cost/postgres-pacer.test.ts
```

Expected: FAIL — `PostgresSharedPacer` is not defined

- [ ] **Step 3: Implement `PostgresSharedPacer`**

Create `apps/server/src/cost/postgres-pacer.ts`:

```typescript
import postgres from 'postgres';
import type { Pacer } from './pacer';

const MIN_INTERVAL_MS = 3500;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class PostgresSharedPacer implements Pacer {
  constructor(private readonly sql: postgres.Sql) {}

  async wait(retryAfterMs = 0): Promise<void> {
    const intervalMs = Math.max(retryAfterMs, MIN_INTERVAL_MS);

    const result = await this.sql.begin(async (tx) => {
      const [row] = await tx<[{ next_allowed_at: Date }]>`
        SELECT next_allowed_at
        FROM aso_rate_slots
        WHERE key = 'itunes'
        FOR UPDATE
      `;
      const now = new Date();
      const waitMs = Math.max(row.next_allowed_at.getTime() - now.getTime(), 0);
      const newNext = new Date(
        Math.max(row.next_allowed_at.getTime(), now.getTime()) + intervalMs,
      );
      await tx`
        UPDATE aso_rate_slots
        SET next_allowed_at = ${newNext}
        WHERE key = 'itunes'
      `;
      return waitMs;
    });

    if (result > 0) await sleep(result);
  }

  reset(): void {
    // No-op: distributed pacer has no local state to reset.
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/hassanali/Documents/layers-ai/layers-ai-aso-audit/apps/server
source ~/.nvm/nvm.sh && nvm use 24
npx vitest run src/cost/postgres-pacer.test.ts
```

Expected: both tests PASS. The concurrent-serialization test is the Definition of Done gate for the shared limiter requirement.

If the concurrent test is flaky (gap occasionally < 3450ms), increase the tolerance slightly (e.g., `MIN_INTERVAL_MS - 100`) but do not lower it below `MIN_INTERVAL_MS - 200`.

- [ ] **Step 5: TypeScript check**

```bash
cd /Users/hassanali/Documents/layers-ai/layers-ai-aso-audit/apps/server
source ~/.nvm/nvm.sh && nvm use 24
npx tsc --noEmit 2>&1 | grep -v "audit-workflow\|storage-client.conformance"
```

Expected: no new errors

- [ ] **Step 6: Commit**

```bash
cd /Users/hassanali/Documents/layers-ai/layers-ai-aso-audit
git add apps/server/src/cost/postgres-pacer.ts apps/server/src/cost/postgres-pacer.test.ts
git commit -m "feat(6a): add PostgresSharedPacer with SELECT FOR UPDATE serialization"
```

---

### Task 3: Wire `getPacer()` factory

**Files:**
- Modify: `apps/server/src/cost/pacer.ts`

**Interfaces:**
- Consumes: `PostgresSharedPacer` from `./postgres-pacer`
- Produces: `getPacer()` returns `PostgresSharedPacer` when `process.env.DATABASE_URL` is set; `SerialPacer` otherwise

- [ ] **Step 1: Read the current `pacer.ts`**

Read `apps/server/src/cost/pacer.ts` to confirm the current structure before editing. Locate the `getPacer()` function.

- [ ] **Step 2: Update `getPacer()` in `pacer.ts`**

Replace the `getPacer()` function body only. The rest of the file (imports, `MIN_INTERVAL_MS`, `Pacer` interface, `SerialPacer`, `setPacer`) is unchanged:

```typescript
export function getPacer(): Pacer {
  if (!_pacer) {
    const dbUrl = process.env.DATABASE_URL;
    if (dbUrl) {
      const { PostgresSharedPacer } = require('./postgres-pacer') as typeof import('./postgres-pacer');
      const postgres = require('postgres') as typeof import('postgres');
      _pacer = new PostgresSharedPacer(postgres(dbUrl));
    } else {
      _pacer = new SerialPacer();
    }
  }
  return _pacer;
}
```

**Note on `require()` vs `import`:** Using `require()` here avoids a circular import if `postgres-pacer.ts` imports from `pacer.ts`. If `pacer.ts` does not use a barrel/re-export, replace the `require()` calls with top-level static imports instead:

```typescript
import postgres from 'postgres';
import { PostgresSharedPacer } from './postgres-pacer';

export function getPacer(): Pacer {
  if (!_pacer) {
    const dbUrl = process.env.DATABASE_URL;
    _pacer = dbUrl ? new PostgresSharedPacer(postgres(dbUrl)) : new SerialPacer();
  }
  return _pacer;
}
```

Use the static import form if there is no circular dependency. Read `postgres-pacer.ts` imports first to confirm.

- [ ] **Step 3: Verify existing `pacer.test.ts` still passes**

```bash
cd /Users/hassanali/Documents/layers-ai/layers-ai-aso-audit/apps/server
source ~/.nvm/nvm.sh && nvm use 24
npx vitest run src/cost/pacer.test.ts
```

Expected: all existing SerialPacer tests PASS — `SerialPacer` is unmodified

- [ ] **Step 4: Run the full server test suite**

```bash
cd /Users/hassanali/Documents/layers-ai/layers-ai-aso-audit/apps/server
source ~/.nvm/nvm.sh && nvm use 24
npx vitest run
```

Expected: all tests pass, including both `postgres-pacer.test.ts` tests and all `pacer.test.ts` tests

- [ ] **Step 5: TypeScript check**

```bash
cd /Users/hassanali/Documents/layers-ai/layers-ai-aso-audit/apps/server
source ~/.nvm/nvm.sh && nvm use 24
npx tsc --noEmit 2>&1 | grep -v "audit-workflow\|storage-client.conformance"
```

Expected: no new errors

- [ ] **Step 6: Commit**

```bash
cd /Users/hassanali/Documents/layers-ai/layers-ai-aso-audit
git add apps/server/src/cost/pacer.ts
git commit -m "feat(6a): wire getPacer() to use PostgresSharedPacer when DATABASE_URL is set"
```
