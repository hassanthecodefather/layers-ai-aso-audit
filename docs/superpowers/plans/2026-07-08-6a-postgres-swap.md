# Phase 6a — Postgres Swap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the LibSQL/SQLite `StorageClient` implementation with a PostgreSQL-backed one, validated by running the existing engine-agnostic conformance suite against the new implementation.

**Architecture:** A new `PostgresStorageClient` implements the existing `StorageClient` interface using `postgres.js` (tagged-template SQL, no ORM). A `pg-migrate.ts` runner applies the shared `MIGRATIONS` array plus a new `PG_ONLY_MIGRATIONS` array to Postgres. The `getStorage()` factory in `memory/index.ts` checks `DATABASE_URL` and returns the Postgres implementation when set, falling back to LibSQL otherwise. `UserStore` (auth) and Mastra's internal `LibSQLStore` (workflow state) remain on LibSQL.

**Tech Stack:** `postgres` (postgres.js v3), PostgreSQL 17 via Docker Compose, vitest

## Global Constraints

- Node ≥20.12; always use `nvm use 24` before running node/npm commands
- Test runner: vitest — run from `apps/server` with `npx vitest run`
- TypeScript check: `cd apps/server && npx tsc --noEmit`
- No ORM — all SQL is written directly as postgres.js template literals
- Specific `git add` only — never `git add -A` or `git add .`
- `DATABASE_URL` format: `postgresql://user:password@host:port/dbname`
- `DATABASE_TEST_URL` must point to a separate database (`aso_audit_test`) to avoid clobbering dev data
- The `StorageClient` interface is unchanged — `PostgresStorageClient` must pass the full conformance suite including the cross-tenant isolation test
- `UserStore` stays on LibSQL — do not change `getUserStore()` or `UserStore`
- Mastra's `LibSQLStore` stays on LibSQL — do not change the Mastra instance in `mastra/index.ts`

---

### Task 1: Docker Compose + postgres.js + env vars

**Files:**
- Create: `compose.yml` (repo root)
- Modify: `.env` (repo root)
- Modify: `apps/server/package.json` (add `postgres` dep via npm install)

**Interfaces:**
- Produces: `compose.yml` with a healthy Postgres 17 service; `DATABASE_URL` and `DATABASE_TEST_URL` in `.env`

- [ ] **Step 1: Create `compose.yml`**

Create `/Users/hassanali/Documents/layers-ai/layers-ai-aso-audit/compose.yml`:

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

- [ ] **Step 2: Add env vars to `.env`**

Append to `/Users/hassanali/Documents/layers-ai/layers-ai-aso-audit/.env`:

```
# ── Phase 6a Postgres ──────────────────────────────────────────────────────
DATABASE_URL=postgresql://aso:aso@localhost:5432/aso_audit
DATABASE_TEST_URL=postgresql://aso:aso@localhost:5432/aso_audit_test
```

- [ ] **Step 3: Create the test database**

```bash
docker compose up -d
# Wait for healthcheck to pass (up to 30s)
docker compose exec db psql -U aso -c "CREATE DATABASE aso_audit_test;"
```

Expected: `CREATE DATABASE`

- [ ] **Step 4: Install postgres.js**

```bash
cd /Users/hassanali/Documents/layers-ai/layers-ai-aso-audit/apps/server
source ~/.nvm/nvm.sh && nvm use 24
npm install postgres
```

Expected: `postgres` added to `dependencies` in `package.json`

- [ ] **Step 5: Verify Postgres is reachable**

```bash
cd /Users/hassanali/Documents/layers-ai/layers-ai-aso-audit/apps/server
source ~/.nvm/nvm.sh && nvm use 24
node -e "
const postgres = require('postgres');
const sql = postgres(process.env.DATABASE_URL || 'postgresql://aso:aso@localhost:5432/aso_audit');
sql\`SELECT 1 AS ok\`.then(r => { console.log('connected:', r[0].ok === 1); sql.end(); }).catch(e => { console.error(e); process.exit(1); });
"
```

Expected: `connected: true`

- [ ] **Step 6: Commit**

```bash
cd /Users/hassanali/Documents/layers-ai/layers-ai-aso-audit
git add compose.yml .env apps/server/package.json apps/server/package-lock.json
git commit -m "feat(6a): add Docker Compose for Postgres 17 + install postgres.js"
```

---

### Task 2: Postgres migration runner (`pg-migrate.ts`)

**Files:**
- Create: `apps/server/src/memory/pg-migrate.ts`
- Create: `apps/server/src/memory/pg-migrate.test.ts`

**Interfaces:**
- Consumes: `MIGRATIONS` from `./migrate`
- Produces:
  - `PG_ONLY_MIGRATIONS: readonly string[]` — Postgres-only DDL (empty now; shared limiter plan adds to it)
  - `runPgMigrations(sql: postgres.Sql): Promise<void>` — applies all migrations to the connected DB

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/memory/pg-migrate.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { runPgMigrations } from './pg-migrate';

const TEST_URL = process.env.DATABASE_TEST_URL ?? 'postgresql://aso:aso@localhost:5432/aso_audit_test';

describe('runPgMigrations', () => {
  let sql: postgres.Sql;
  const schema = `pgmig_test_${Date.now()}`;

  beforeAll(async () => {
    sql = postgres(TEST_URL, { connection: { search_path: schema } });
    await sql`CREATE SCHEMA IF NOT EXISTS ${sql(schema)}`;
    await runPgMigrations(sql);
  });

  afterAll(async () => {
    await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`;
    await sql.end();
  });

  it('creates aso_listing_snapshots', async () => {
    const rows = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${schema} AND table_name = 'aso_listing_snapshots'
    `;
    expect(rows).toHaveLength(1);
  });

  it('creates aso_recommendations', async () => {
    const rows = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${schema} AND table_name = 'aso_recommendations'
    `;
    expect(rows).toHaveLength(1);
  });

  it('creates aso_users', async () => {
    const rows = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${schema} AND table_name = 'aso_users'
    `;
    expect(rows).toHaveLength(1);
  });

  it('creates aso_refresh_tokens', async () => {
    const rows = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${schema} AND table_name = 'aso_refresh_tokens'
    `;
    expect(rows).toHaveLength(1);
  });

  it('aso_listing_snapshots has tenant_id column', async () => {
    const rows = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${schema}
        AND table_name = 'aso_listing_snapshots'
        AND column_name = 'tenant_id'
    `;
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/hassanali/Documents/layers-ai/layers-ai-aso-audit/apps/server
source ~/.nvm/nvm.sh && nvm use 24
npx vitest run src/memory/pg-migrate.test.ts
```

Expected: FAIL — `pg-migrate.ts` does not exist yet

- [ ] **Step 3: Create `pg-migrate.ts`**

Create `apps/server/src/memory/pg-migrate.ts`:

```typescript
import postgres from 'postgres';
import { MIGRATIONS } from './migrate';

/**
 * Postgres-only DDL that uses Postgres-specific types (e.g. TIMESTAMPTZ).
 * Applied by runPgMigrations AFTER the shared MIGRATIONS array.
 * The shared limiter plan (2026-07-08-6a-shared-limiter.md) adds to this array.
 */
export const PG_ONLY_MIGRATIONS: readonly string[] = [
  // Phase 6a: rate slot table — added by shared-limiter plan
];

/**
 * Apply all migrations to the connected Postgres instance.
 * Unlike the LibSQL runner, Postgres supports ALTER TABLE ... ADD COLUMN IF NOT EXISTS
 * natively, so no error suppression is needed.
 *
 * The caller is responsible for setting search_path on the sql connection
 * if schema isolation is required (e.g. in tests).
 */
export async function runPgMigrations(sql: postgres.Sql): Promise<void> {
  for (const stmt of [...MIGRATIONS, ...PG_ONLY_MIGRATIONS]) {
    await sql.unsafe(stmt);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/hassanali/Documents/layers-ai/layers-ai-aso-audit/apps/server
source ~/.nvm/nvm.sh && nvm use 24
npx vitest run src/memory/pg-migrate.test.ts
```

Expected: all 5 tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/hassanali/Documents/layers-ai/layers-ai-aso-audit
git add apps/server/src/memory/pg-migrate.ts apps/server/src/memory/pg-migrate.test.ts
git commit -m "feat(6a): add Postgres migration runner and PG_ONLY_MIGRATIONS"
```

---

### Task 3: `PostgresStorageClient` implementation

**Files:**
- Create: `apps/server/src/memory/postgres-storage-client.ts`

**Interfaces:**
- Consumes: `StorageClient` interface from `./storage-client`; `runPgMigrations` from `./pg-migrate`
- Produces: `PostgresStorageClient` class implementing `StorageClient`

No standalone test — the conformance suite in Task 4 is the test gate.

- [ ] **Step 1: Create the file**

Create `apps/server/src/memory/postgres-storage-client.ts`:

```typescript
import postgres from 'postgres';
import { ok, err, type Result } from '../domain/result';
import { ListingSnapshotSchema, type ListingSnapshot } from '../domain/snapshot';
import {
  LedgerRecommendationSchema,
  type LedgerRecommendation,
} from '../domain/recommendation';
import { IdentityVersionSchema, type IdentityVersion } from '../domain/identity';
import type { StorageClient } from './storage-client';

export class PostgresStorageClient implements StorageClient {
  constructor(private readonly sql: postgres.Sql) {}

  // ── Snapshots ──────────────────────────────────────────────────────────────

  async putSnapshot(tenantId: string, s: ListingSnapshot): Promise<Result<void>> {
    try {
      await this.sql`
        INSERT INTO aso_listing_snapshots
          (id, app_id, country, tenant_id, fetched_at, listing_json, signals_json,
           report_json, rubric_version, prompt_hash, model_id, vision_result_json,
           candidate_result_json, theme_result_json,
           function_competitor_seeds_json, competitor_mining_result_json)
        VALUES (
          ${s.id}, ${s.appId}, ${s.country}, ${tenantId}, ${s.fetchedAt},
          ${JSON.stringify(s.listing)}, ${JSON.stringify(s.signals ?? null)},
          ${JSON.stringify(s.report)}, ${s.rubricVersion}, ${s.promptHash}, ${s.modelId},
          ${JSON.stringify(s.visionResult ?? null)},
          ${JSON.stringify(s.candidateResult ?? null)},
          ${JSON.stringify(s.themeResult ?? null)},
          ${s.functionCompetitorSeeds != null ? JSON.stringify(s.functionCompetitorSeeds) : null},
          ${JSON.stringify(s.competitorMiningResult ?? null)}
        )
      `;
      return ok(undefined);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }

  async latestSnapshot(
    tenantId: string,
    appId: string,
    country: string,
  ): Promise<Result<ListingSnapshot | null>> {
    try {
      const rows = await this.sql`
        SELECT * FROM aso_listing_snapshots
        WHERE tenant_id = ${tenantId} AND app_id = ${appId} AND country = ${country}
        ORDER BY fetched_at DESC LIMIT 1
      `;
      if (!rows[0]) return ok(null);
      return this.#parseSnapshot(rows[0]);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }

  // ── Recommendations ────────────────────────────────────────────────────────

  async upsertRecommendation(tenantId: string, r: LedgerRecommendation): Promise<Result<void>> {
    try {
      await this.sql`
        INSERT INTO aso_recommendations
          (id, app_id, country, tenant_id, rec_key, value_key, taxonomy_version,
           dimension, intent, target_field, title, body, before_text, after_text,
           evidence_json, status, superseded_by, first_seen_at, last_seen_at,
           applied_at, proof_regime)
        VALUES (
          ${r.id}, ${r.appId}, ${r.country}, ${tenantId}, ${r.recKey}, ${r.valueKey},
          ${r.taxonomyVersion ?? null}, ${r.dimension}, ${r.intent},
          ${r.targetField ?? null}, ${r.title}, ${r.body},
          ${r.beforeText ?? null}, ${r.afterText ?? null},
          ${JSON.stringify(r.evidence)}, ${r.status}, ${r.supersededBy ?? null},
          ${r.firstSeenAt}, ${r.lastSeenAt}, ${r.appliedAt ?? null}, ${r.proofRegime}
        )
        ON CONFLICT (tenant_id, app_id, country, rec_key) DO UPDATE SET
          title            = EXCLUDED.title,
          body             = EXCLUDED.body,
          before_text      = EXCLUDED.before_text,
          after_text       = EXCLUDED.after_text,
          evidence_json    = EXCLUDED.evidence_json,
          last_seen_at     = EXCLUDED.last_seen_at,
          status           = EXCLUDED.status,
          value_key        = EXCLUDED.value_key,
          taxonomy_version = EXCLUDED.taxonomy_version
      `;
      return ok(undefined);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }

  async recordOccurrence(
    tenantId: string,
    recId: string,
    snapshotId: string,
    wasDismissed: boolean,
  ): Promise<Result<void>> {
    try {
      await this.sql`
        INSERT INTO aso_rec_occurrences (rec_id, snapshot_id, tenant_id, was_dismissed)
        VALUES (${recId}, ${snapshotId}, ${tenantId}, ${wasDismissed ? 1 : 0})
        ON CONFLICT (rec_id, snapshot_id) DO NOTHING
      `;
      return ok(undefined);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }

  async ledger(
    tenantId: string,
    appId: string,
    country: string,
  ): Promise<Result<LedgerRecommendation[]>> {
    try {
      const rows = await this.sql`
        SELECT * FROM aso_recommendations
        WHERE tenant_id = ${tenantId} AND app_id = ${appId} AND country = ${country}
        ORDER BY first_seen_at ASC
      `;
      const results: LedgerRecommendation[] = [];
      for (const row of rows) {
        const parsed = this.#parseRecommendation(row);
        if (!parsed.ok) return err(parsed.error);
        results.push(parsed.value);
      }
      return ok(results);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }

  // ── Identity ───────────────────────────────────────────────────────────────

  async appendIdentity(tenantId: string, v: IdentityVersion): Promise<Result<void>> {
    try {
      await this.sql`
        INSERT INTO aso_identity_versions
          (id, app_id, country, tenant_id, version, stage, category, category_band,
           niche, niche_band, audience_json, tally_json, divergence, escalate,
           source, created_at, overrode_evidence_json)
        VALUES (
          ${v.id}, ${v.appId}, ${v.country}, ${tenantId}, ${v.version},
          ${v.stage}, ${v.category}, ${v.categoryBand},
          ${v.niche ?? null}, ${v.nicheBand ?? null},
          ${v.audience != null ? JSON.stringify(v.audience) : null},
          ${JSON.stringify(v.tally)}, ${v.divergence}, ${v.escalate ? 1 : 0},
          ${v.source}, ${v.createdAt},
          ${v.overrodeEvidence != null ? JSON.stringify(v.overrodeEvidence) : null}
        )
      `;
      return ok(undefined);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }

  async latestIdentity(
    tenantId: string,
    appId: string,
    country: string,
  ): Promise<Result<IdentityVersion | null>> {
    try {
      const rows = await this.sql`
        SELECT * FROM aso_identity_versions
        WHERE tenant_id = ${tenantId} AND app_id = ${appId} AND country = ${country}
        ORDER BY version DESC LIMIT 1
      `;
      if (!rows[0]) return ok(null);
      return this.#parseIdentity(rows[0]);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }

  async maxIdentityVersion(
    tenantId: string,
    appId: string,
    country: string,
  ): Promise<Result<number>> {
    try {
      const rows = await this.sql`
        SELECT MAX(version) AS max_version FROM aso_identity_versions
        WHERE tenant_id = ${tenantId} AND app_id = ${appId} AND country = ${country}
      `;
      return ok(Number(rows[0]?.max_version ?? 0));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }

  // ── Tombstones ─────────────────────────────────────────────────────────────

  async tombstoneCompetitor(
    tenantId: string,
    appId: string,
    country: string,
    competitorAppId: string,
  ): Promise<Result<void>> {
    try {
      await this.sql`
        INSERT INTO aso_competitor_tombstones
          (tenant_id, app_id, country, competitor_app_id, rejected_at)
        VALUES (${tenantId}, ${appId}, ${country}, ${competitorAppId}, ${new Date().toISOString()})
        ON CONFLICT (app_id, country, competitor_app_id) DO NOTHING
      `;
      return ok(undefined);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }

  async tombstones(
    tenantId: string,
    appId: string,
    country: string,
  ): Promise<Result<Set<string>>> {
    try {
      const rows = await this.sql`
        SELECT competitor_app_id FROM aso_competitor_tombstones
        WHERE tenant_id = ${tenantId} AND app_id = ${appId} AND country = ${country}
      `;
      return ok(new Set(rows.map((r) => String(r.competitor_app_id))));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }

  // ── Private parsers ────────────────────────────────────────────────────────

  #parseSnapshot(row: postgres.Row): Result<ListingSnapshot> {
    const visionResultRaw =
      row.vision_result_json != null ? JSON.parse(String(row.vision_result_json)) : undefined;
    const candidateResultRaw =
      row.candidate_result_json != null
        ? JSON.parse(String(row.candidate_result_json))
        : undefined;
    const themeResultRaw =
      row.theme_result_json != null ? JSON.parse(String(row.theme_result_json)) : undefined;
    const functionCompetitorSeedsRaw =
      row.function_competitor_seeds_json != null
        ? JSON.parse(String(row.function_competitor_seeds_json))
        : undefined;
    const competitorMiningResultRaw =
      row.competitor_mining_result_json != null
        ? JSON.parse(String(row.competitor_mining_result_json))
        : undefined;

    const parsed = ListingSnapshotSchema.safeParse({
      id: String(row.id),
      appId: String(row.app_id),
      country: String(row.country),
      fetchedAt: String(row.fetched_at),
      listing: JSON.parse(String(row.listing_json)),
      signals: row.signals_json != null ? JSON.parse(String(row.signals_json)) : undefined,
      report: JSON.parse(String(row.report_json)),
      rubricVersion: String(row.rubric_version),
      promptHash: String(row.prompt_hash),
      modelId: String(row.model_id),
      visionResult: visionResultRaw,
      candidateResult: candidateResultRaw,
      themeResult: themeResultRaw,
      functionCompetitorSeeds: functionCompetitorSeedsRaw,
      competitorMiningResult: competitorMiningResultRaw,
    });
    return parsed.success ? ok(parsed.data) : err(parsed.error.message);
  }

  #parseRecommendation(row: postgres.Row): Result<LedgerRecommendation> {
    const parsed = LedgerRecommendationSchema.safeParse({
      id: String(row.id),
      appId: String(row.app_id),
      country: String(row.country),
      recKey: String(row.rec_key),
      valueKey: String(row.value_key),
      taxonomyVersion: row.taxonomy_version != null ? String(row.taxonomy_version) : undefined,
      dimension: String(row.dimension),
      intent: String(row.intent),
      targetField: row.target_field != null ? String(row.target_field) : undefined,
      title: String(row.title),
      body: String(row.body),
      beforeText: row.before_text != null ? String(row.before_text) : undefined,
      afterText: row.after_text != null ? String(row.after_text) : undefined,
      evidence: JSON.parse(String(row.evidence_json)),
      status: String(row.status),
      supersededBy: row.superseded_by != null ? String(row.superseded_by) : undefined,
      firstSeenAt: String(row.first_seen_at),
      lastSeenAt: String(row.last_seen_at),
      appliedAt: row.applied_at != null ? String(row.applied_at) : undefined,
      proofRegime: String(row.proof_regime),
    });
    return parsed.success ? ok(parsed.data) : err(parsed.error.message);
  }

  #parseIdentity(row: postgres.Row): Result<IdentityVersion> {
    const parsed = IdentityVersionSchema.safeParse({
      id: String(row.id),
      appId: String(row.app_id),
      country: String(row.country),
      version: Number(row.version),
      stage: String(row.stage),
      category: String(row.category),
      categoryBand: String(row.category_band),
      niche: row.niche != null ? String(row.niche) : undefined,
      nicheBand: row.niche_band != null ? String(row.niche_band) : undefined,
      audience: row.audience_json != null ? JSON.parse(String(row.audience_json)) : undefined,
      tally: JSON.parse(String(row.tally_json)),
      divergence: String(row.divergence),
      escalate: Boolean(row.escalate),
      source: String(row.source),
      createdAt: String(row.created_at),
      overrodeEvidence:
        row.overrode_evidence_json != null
          ? JSON.parse(String(row.overrode_evidence_json))
          : undefined,
    });
    return parsed.success ? ok(parsed.data) : err(parsed.error.message);
  }
}
```

- [ ] **Step 2: TypeScript check**

```bash
cd /Users/hassanali/Documents/layers-ai/layers-ai-aso-audit/apps/server
source ~/.nvm/nvm.sh && nvm use 24
npx tsc --noEmit 2>&1 | grep -v "audit-workflow\|conformance"
```

Expected: no new errors (3 pre-existing errors in `audit-workflow.ts` and `storage-client.conformance.ts` are unrelated)

- [ ] **Step 3: Commit**

```bash
cd /Users/hassanali/Documents/layers-ai/layers-ai-aso-audit
git add apps/server/src/memory/postgres-storage-client.ts
git commit -m "feat(6a): add PostgresStorageClient implementation"
```

---

### Task 4: Conformance suite against Postgres

**Files:**
- Create: `apps/server/src/memory/postgres-storage-client.test.ts`

**Interfaces:**
- Consumes: `storageClientConformanceSuite` from `./storage-client.conformance`; `PostgresStorageClient` from `./postgres-storage-client`; `runPgMigrations` from `./pg-migrate`

- [ ] **Step 1: Write the conformance test file**

Create `apps/server/src/memory/postgres-storage-client.test.ts`:

```typescript
import postgres from 'postgres';
import { storageClientConformanceSuite } from './storage-client.conformance';
import { PostgresStorageClient } from './postgres-storage-client';
import { runPgMigrations } from './pg-migrate';

const TEST_URL =
  process.env.DATABASE_TEST_URL ?? 'postgresql://aso:aso@localhost:5432/aso_audit_test';

storageClientConformanceSuite(async () => {
  // Each call gets a unique Postgres schema — fully isolated, concurrent-safe.
  const schema = `aso_conf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const sql = postgres(TEST_URL, {
    connection: { search_path: schema },
    max: 3,
  });
  await sql`CREATE SCHEMA IF NOT EXISTS ${sql(schema)}`;
  await runPgMigrations(sql);
  const client = new PostgresStorageClient(sql);
  return {
    client,
    close: async () => {
      await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`;
      await sql.end();
    },
  };
});
```

- [ ] **Step 2: Run the conformance suite**

```bash
cd /Users/hassanali/Documents/layers-ai/layers-ai-aso-audit/apps/server
source ~/.nvm/nvm.sh && nvm use 24
npx vitest run src/memory/postgres-storage-client.test.ts
```

Expected: all conformance tests PASS, including the cross-tenant isolation test (`cross-tenant isolation: snapshot written under tenant-A is invisible to tenant-B`).

If any test fails, diagnose by reading the error carefully — it will be a SQL dialect difference or a missing column in the INSERT. Fix `postgres-storage-client.ts` and re-run.

- [ ] **Step 3: Run full server test suite to check for regressions**

```bash
cd /Users/hassanali/Documents/layers-ai/layers-ai-aso-audit/apps/server
source ~/.nvm/nvm.sh && nvm use 24
npx vitest run
```

Expected: all existing tests still pass

- [ ] **Step 4: Commit**

```bash
cd /Users/hassanali/Documents/layers-ai/layers-ai-aso-audit
git add apps/server/src/memory/postgres-storage-client.test.ts
git commit -m "feat(6a): StorageClient conformance suite passes against Postgres"
```

---

### Task 5: Wire factory and boot sequence

**Files:**
- Modify: `apps/server/src/memory/index.ts`
- Modify: `apps/server/src/mastra/index.ts`

**Interfaces:**
- Consumes: `PostgresStorageClient`, `runPgMigrations`, `PG_ONLY_MIGRATIONS`
- Produces: `getStorage()` returns `PostgresStorageClient` when `DATABASE_URL` is set; `mastra/index.ts` calls `runPgMigrations` at boot when `DATABASE_URL` is set

- [ ] **Step 1: Update `apps/server/src/memory/index.ts`**

Replace the file with:

```typescript
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
    _pgSql = postgres(process.env.DATABASE_URL);
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
```

- [ ] **Step 2: Update `apps/server/src/mastra/index.ts` boot sequence**

Find the block at the bottom of `mastra/index.ts`:

```typescript
if (!isTest) {
  runMigrations(DB_URL).catch((e) =>
    console.error('[memory] migration failed at startup:', e),
  );
  void verifyLlmStartup();
}
```

Replace with:

```typescript
if (!isTest) {
  const pgUrl = process.env.DATABASE_URL;
  if (pgUrl) {
    import('../memory/pg-migrate').then(({ runPgMigrations }) =>
      import('../memory').then(({ getPgSql }) => {
        const sql = getPgSql();
        if (sql) runPgMigrations(sql).catch((e) =>
          console.error('[memory] Postgres migration failed at startup:', e),
        );
      }),
    );
  } else {
    runMigrations(DB_URL).catch((e) =>
      console.error('[memory] migration failed at startup:', e),
    );
  }
  void verifyLlmStartup();
}
```

- [ ] **Step 3: TypeScript check**

```bash
cd /Users/hassanali/Documents/layers-ai/layers-ai-aso-audit/apps/server
source ~/.nvm/nvm.sh && nvm use 24
npx tsc --noEmit 2>&1 | grep -v "audit-workflow\|storage-client.conformance"
```

Expected: no new errors

- [ ] **Step 4: Run full test suite**

```bash
cd /Users/hassanali/Documents/layers-ai/layers-ai-aso-audit/apps/server
source ~/.nvm/nvm.sh && nvm use 24
npx vitest run
```

Expected: all tests pass (existing LibSQL tests use in-memory SQLite; Postgres tests use `DATABASE_TEST_URL`)

- [ ] **Step 5: Smoke-test with real Postgres**

Ensure Docker Compose is running, then:

```bash
cd /Users/hassanali/Documents/layers-ai/layers-ai-aso-audit/apps/server
source ~/.nvm/nvm.sh && nvm use 24
DATABASE_URL=postgresql://aso:aso@localhost:5432/aso_audit node -e "
process.env.DATABASE_URL = 'postgresql://aso:aso@localhost:5432/aso_audit';
const { getStorage } = require('./dist/memory/index.js');
getStorage().then(s => { console.log('storage ok:', s.constructor.name); process.exit(0); }).catch(e => { console.error(e); process.exit(1); });
"
```

Or simply start the server and confirm it boots without errors:

```bash
DATABASE_URL=postgresql://aso:aso@localhost:5432/aso_audit npx tsx src/mastra/index.ts 2>&1 | head -10
```

Expected: no migration errors in the output

- [ ] **Step 6: Commit**

```bash
cd /Users/hassanali/Documents/layers-ai/layers-ai-aso-audit
git add apps/server/src/memory/index.ts apps/server/src/mastra/index.ts
git commit -m "feat(6a): wire getStorage() and boot to use Postgres when DATABASE_URL is set"
```
