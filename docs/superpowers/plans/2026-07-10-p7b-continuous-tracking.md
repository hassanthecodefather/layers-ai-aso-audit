# P7-B: Continuous Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After an audit, let tenants opt in to daily lightweight scans that detect version changes, metadata drift, and review shifts — emitting typed change events and triggering a full re-audit on go-live.

**Architecture:** A scheduler (`setInterval` hourly) queries `aso_tracked_apps` for due rows, runs three cheap reads per app (ASC version status, iTunes metadata, iTunes review delta), inserts events into `aso_change_events`, and calls `insertJob` when a new version transitions to `READY_FOR_SALE`. No LLM, no vision, no crawler in the scan itself. All scan errors are caught per-app and do not crash the scheduler loop.

**Tech Stack:** TypeScript, postgres.js, `@mastra/core`, React (Vite), Vitest, Postgres (Dockerised for tests).

## Global Constraints

- Migrations append to `PG_ONLY_MIGRATIONS` in `apps/server/src/memory/pg-migrate.ts` — never edit existing entries; always add new statements at the end of the array.
- All new routes registered via `registerApiRoute` from `@mastra/core/server` and added to the `apiRoutes` spread in `apps/server/src/mastra/index.ts`.
- All routes guard with `getAuthenticatedTenantId(c)` from `../auth/middleware` — return `c.json({ error: 'Unauthorized' }, 401)` if null.
- All routes get `sql` via `getPgSql()` from `../memory` — return `c.json({ error: 'Database unavailable' }, 503)` if null.
- Tests use **real Postgres** with a unique per-file schema (pattern from `apps/server/src/asc/routes.test.ts`): `const schema = \`tracking_<suffix>_test_${Date.now()}\``; `beforeAll` creates schema + runs `runPgMigrations`; `afterAll` drops schema + calls `sql.end()`.
- `DATABASE_TEST_URL` defaults to `postgresql://aso:aso@localhost:5432/aso_audit_test`.
- Run tests with `nvm use 24 && pnpm --filter @layers/server test` from `apps/server/`.
- `bundle_id` is stored but not used in scan logic. The API accepts it as optional (defaults to `''`). The DB column is `TEXT NOT NULL DEFAULT ''`.
- No analytics client calls in any scan code (deferred to P7-C).
- Change events for `version_status` are internal baseline records — never returned by `GET /activity`.

---

## File Map

| Action | Path | Purpose |
|--------|------|---------|
| Create | `apps/server/src/tracking/types.ts` | `TrackedApp`, `ChangeEventType`, `ChangeEvent`, `ActivityEvent` |
| Modify | `apps/server/src/memory/pg-migrate.ts` | Add `aso_tracked_apps` + `aso_change_events` migrations |
| Create | `apps/server/src/tracking/store.ts` | All DB operations for both tables |
| Create | `apps/server/src/tracking/store.test.ts` | Real-Postgres tests for store functions |
| Create | `apps/server/src/tracking/routes.ts` | POST/GET/DELETE `/tracking` + GET `/activity` |
| Create | `apps/server/src/tracking/routes.test.ts` | Route handler tests |
| Modify | `apps/server/src/mastra/index.ts` | Register `trackingRoutes` + start `trackingScheduler` |
| Create | `apps/server/src/tracking/scan.ts` | `runScan` — three checks per app |
| Create | `apps/server/src/tracking/scan.test.ts` | Scan logic tests with mocked external calls |
| Create | `apps/server/src/tracking/scheduler.ts` | `startTrackingScheduler` — hourly loop |
| Create | `apps/server/src/tracking/scheduler.test.ts` | Scheduler error-isolation tests |
| Modify | `apps/web/src/lib/api.ts` | Add `getTrackedApps`, `startTracking`, `stopTracking`, `fetchActivity` |
| Create | `apps/web/src/components/TrackingCard.tsx` | "Watch this app" / "Tracking active" card |
| Create | `apps/web/src/components/ActivityFeed.tsx` | Chronological change-event list |
| Modify | `apps/web/src/App.tsx` | Add Activity tab + view-state toggle |

---

## Task 1: Types, DB Migrations, and Store Functions

**Files:**
- Create: `apps/server/src/tracking/types.ts`
- Modify: `apps/server/src/memory/pg-migrate.ts`
- Create: `apps/server/src/tracking/store.ts`
- Test: `apps/server/src/tracking/store.test.ts`

**Interfaces:**
- Produces: `TrackedApp`, `ChangeEventType`, `ChangeEvent`, `ActivityEvent` (used by Tasks 2, 3, 4)
- Produces: `upsertTrackedApp`, `getTrackedApps`, `getDueApps`, `updateLastScanned`, `disableTrackedApp`, `insertChangeEvent`, `getChangeEvents`, `getLastChangeEvent` (used by Tasks 2, 3, 4)

---

- [ ] **Step 1.1: Write the failing store tests**

Create `apps/server/src/tracking/store.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { runPgMigrations } from '../memory/pg-migrate';
import {
  upsertTrackedApp, getTrackedApps, getDueApps, updateLastScanned, disableTrackedApp,
  insertChangeEvent, getChangeEvents, getLastChangeEvent,
} from './store';

const TEST_URL = process.env.DATABASE_TEST_URL ?? 'postgresql://aso:aso@localhost:5432/aso_audit_test';

describe('tracking store', () => {
  const schema = `tracking_store_test_${Date.now()}`;
  let sql: postgres.Sql;

  beforeAll(async () => {
    sql = postgres(TEST_URL, { connection: { search_path: schema } });
    await sql`CREATE SCHEMA IF NOT EXISTS ${sql(schema)}`;
    await runPgMigrations(sql);
  });

  afterAll(async () => {
    await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`;
    await sql.end();
  });

  it('upsertTrackedApp creates and idempotently updates', async () => {
    await upsertTrackedApp(sql, 'tenant1', {
      appId: '123', country: 'us', bundleId: 'com.test', appName: 'Test', url: 'https://apps.apple.com/app/id123',
    });
    const apps = await getTrackedApps(sql, 'tenant1');
    expect(apps).toHaveLength(1);
    expect(apps[0]!.appId).toBe('123');
    expect(apps[0]!.enabled).toBe(true);

    // Re-upsert with new name — should update, not duplicate
    await upsertTrackedApp(sql, 'tenant1', {
      appId: '123', country: 'us', bundleId: 'com.test', appName: 'Test Renamed', url: 'https://apps.apple.com/app/id123',
    });
    const apps2 = await getTrackedApps(sql, 'tenant1');
    expect(apps2).toHaveLength(1);
    expect(apps2[0]!.appName).toBe('Test Renamed');
  });

  it('getTrackedApps returns only enabled apps for the tenant', async () => {
    await upsertTrackedApp(sql, 'tenant2', {
      appId: 'A', country: 'us', bundleId: '', appName: 'App A', url: 'https://x',
    });
    await upsertTrackedApp(sql, 'tenant2', {
      appId: 'B', country: 'us', bundleId: '', appName: 'App B', url: 'https://y',
    });
    await disableTrackedApp(sql, 'tenant2', 'B');

    const apps = await getTrackedApps(sql, 'tenant2');
    expect(apps.map(a => a.appId)).toEqual(['A']);
  });

  it('getDueApps returns apps with null or old last_scanned_at across tenants', async () => {
    await upsertTrackedApp(sql, 'tenant3', {
      appId: 'DUE', country: 'us', bundleId: '', appName: 'Due App', url: 'https://due',
    });
    const due = await getDueApps(sql);
    const match = due.find(d => d.tenantId === 'tenant3' && d.app.appId === 'DUE');
    expect(match).toBeDefined();

    // After updating last_scanned_at to now, the app should no longer be due
    await updateLastScanned(sql, 'tenant3', 'DUE', 'us');
    const due2 = await getDueApps(sql);
    const match2 = due2.find(d => d.tenantId === 'tenant3' && d.app.appId === 'DUE');
    expect(match2).toBeUndefined();
  });

  it('insertChangeEvent and getLastChangeEvent round-trip', async () => {
    await insertChangeEvent(sql, 'tenant4', {
      appId: 'EVT', country: 'us', eventType: 'version_status',
      payload: { versionString: '1.0.0', state: 'READY_FOR_SALE' },
    });
    const last = await getLastChangeEvent(sql, 'tenant4', 'EVT', 'us', 'version_status');
    expect(last).not.toBeNull();
    expect((last!.payload as any).versionString).toBe('1.0.0');
  });

  it('getChangeEvents excludes version_status events and paginates newest-first', async () => {
    await insertChangeEvent(sql, 'tenant5', {
      appId: 'FEED', country: 'us', eventType: 'version_status',
      payload: { versionString: '1.0', state: 'READY_FOR_SALE' },
    });
    await upsertTrackedApp(sql, 'tenant5', {
      appId: 'FEED', country: 'us', bundleId: '', appName: 'Feed App', url: 'https://feed',
    });
    await insertChangeEvent(sql, 'tenant5', {
      appId: 'FEED', country: 'us', eventType: 'go_live',
      payload: { versionString: '1.0', appId: 'FEED', auditJobId: null },
    });

    const events = await getChangeEvents(sql, 'tenant5', { limit: 10 });
    expect(events.every(e => e.eventType !== 'version_status')).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('go_live');
    expect(events[0]!.appName).toBe('Feed App');
  });
});
```

- [ ] **Step 1.2: Run tests to verify they fail**

```bash
cd apps/server && nvm use 24 && pnpm test -- tracking/store.test.ts
```

Expected: FAIL with "Cannot find module './store'"

- [ ] **Step 1.3: Write `types.ts`**

Create `apps/server/src/tracking/types.ts`:

```ts
export type ChangeEventType = 'go_live' | 'metadata_changed' | 'reviews_shifted' | 'version_status';

export type TrackedApp = {
  appId: string;
  country: string;
  bundleId: string;
  appName: string;
  url: string;
  enabled: boolean;
  enabledAt: string;
  lastScannedAt: string | null;
};

export type ChangeEvent = {
  id: string;
  tenantId: string;
  appId: string;
  country: string;
  eventType: ChangeEventType;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type ActivityEvent = {
  id: string;
  appId: string;
  appName: string;
  country: string;
  eventType: 'go_live' | 'metadata_changed' | 'reviews_shifted';
  payload: Record<string, unknown>;
  createdAt: string;
};
```

- [ ] **Step 1.4: Add DB migrations to `pg-migrate.ts`**

Open `apps/server/src/memory/pg-migrate.ts`. Append to the `PG_ONLY_MIGRATIONS` array (after the `aso_asc_credentials` block, before the closing `]`):

```ts
  // Phase P7-B: continuous tracking registry
  `CREATE TABLE IF NOT EXISTS aso_tracked_apps (
    tenant_id       TEXT NOT NULL,
    app_id          TEXT NOT NULL,
    country         TEXT NOT NULL DEFAULT 'us',
    bundle_id       TEXT NOT NULL DEFAULT '',
    app_name        TEXT NOT NULL,
    url             TEXT NOT NULL,
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    enabled_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_scanned_at TIMESTAMPTZ,
    PRIMARY KEY (tenant_id, app_id, country)
  )`,
  // Phase P7-B: append-only change event log
  `CREATE TABLE IF NOT EXISTS aso_change_events (
    id           TEXT PRIMARY KEY,
    tenant_id    TEXT NOT NULL,
    app_id       TEXT NOT NULL,
    country      TEXT NOT NULL DEFAULT 'us',
    event_type   TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS aso_change_events_tenant_created
    ON aso_change_events (tenant_id, created_at DESC)`,
```

- [ ] **Step 1.5: Write `store.ts`**

Create `apps/server/src/tracking/store.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { TrackedApp, ChangeEventType, ChangeEvent, ActivityEvent } from './types';

interface TrackedAppRow {
  tenant_id: string;
  app_id: string;
  country: string;
  bundle_id: string;
  app_name: string;
  url: string;
  enabled: boolean;
  enabled_at: Date;
  last_scanned_at: Date | null;
}

interface ChangeEventRow {
  id: string;
  tenant_id: string;
  app_id: string;
  country: string;
  event_type: string;
  payload_json: string;
  created_at: Date;
}

interface ActivityRow extends ChangeEventRow {
  app_name: string | null;
}

function rowToTrackedApp(r: TrackedAppRow): TrackedApp {
  return {
    appId: r.app_id,
    country: r.country,
    bundleId: r.bundle_id,
    appName: r.app_name,
    url: r.url,
    enabled: r.enabled,
    enabledAt: r.enabled_at.toISOString(),
    lastScannedAt: r.last_scanned_at?.toISOString() ?? null,
  };
}

function rowToChangeEvent(r: ChangeEventRow): ChangeEvent {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    appId: r.app_id,
    country: r.country,
    eventType: r.event_type as ChangeEventType,
    payload: JSON.parse(r.payload_json) as Record<string, unknown>,
    createdAt: r.created_at.toISOString(),
  };
}

export async function upsertTrackedApp(
  sql: postgres.Sql,
  tenantId: string,
  app: { appId: string; country: string; bundleId: string; appName: string; url: string },
): Promise<void> {
  await sql`
    INSERT INTO aso_tracked_apps (tenant_id, app_id, country, bundle_id, app_name, url, enabled, enabled_at)
    VALUES (${tenantId}, ${app.appId}, ${app.country}, ${app.bundleId}, ${app.appName}, ${app.url}, TRUE, NOW())
    ON CONFLICT (tenant_id, app_id, country) DO UPDATE SET
      bundle_id = EXCLUDED.bundle_id,
      app_name  = EXCLUDED.app_name,
      url       = EXCLUDED.url,
      enabled   = TRUE
  `;
}

export async function getTrackedApps(sql: postgres.Sql, tenantId: string): Promise<TrackedApp[]> {
  const rows = await sql<TrackedAppRow[]>`
    SELECT tenant_id, app_id, country, bundle_id, app_name, url, enabled, enabled_at, last_scanned_at
    FROM aso_tracked_apps
    WHERE tenant_id = ${tenantId} AND enabled = TRUE
    ORDER BY enabled_at DESC
  `;
  return rows.map(rowToTrackedApp);
}

export async function getDueApps(
  sql: postgres.Sql,
): Promise<Array<{ tenantId: string; app: TrackedApp }>> {
  const rows = await sql<TrackedAppRow[]>`
    SELECT tenant_id, app_id, country, bundle_id, app_name, url, enabled, enabled_at, last_scanned_at
    FROM aso_tracked_apps
    WHERE enabled = TRUE
      AND (last_scanned_at IS NULL OR last_scanned_at < NOW() - INTERVAL '23 hours')
    ORDER BY last_scanned_at ASC NULLS FIRST
  `;
  return rows.map(r => ({ tenantId: r.tenant_id, app: rowToTrackedApp(r) }));
}

export async function updateLastScanned(
  sql: postgres.Sql,
  tenantId: string,
  appId: string,
  country: string,
): Promise<void> {
  await sql`
    UPDATE aso_tracked_apps
    SET last_scanned_at = NOW()
    WHERE tenant_id = ${tenantId} AND app_id = ${appId} AND country = ${country}
  `;
}

export async function disableTrackedApp(
  sql: postgres.Sql,
  tenantId: string,
  appId: string,
): Promise<void> {
  await sql`
    UPDATE aso_tracked_apps
    SET enabled = FALSE
    WHERE tenant_id = ${tenantId} AND app_id = ${appId}
  `;
}

export async function insertChangeEvent(
  sql: postgres.Sql,
  tenantId: string,
  event: { appId: string; country: string; eventType: ChangeEventType; payload: Record<string, unknown> },
): Promise<void> {
  await sql`
    INSERT INTO aso_change_events (id, tenant_id, app_id, country, event_type, payload_json)
    VALUES (
      ${randomUUID()},
      ${tenantId},
      ${event.appId},
      ${event.country},
      ${event.eventType},
      ${JSON.stringify(event.payload)}
    )
  `;
}

export async function getLastChangeEvent(
  sql: postgres.Sql,
  tenantId: string,
  appId: string,
  country: string,
  eventType: ChangeEventType,
): Promise<ChangeEvent | null> {
  const rows = await sql<ChangeEventRow[]>`
    SELECT id, tenant_id, app_id, country, event_type, payload_json, created_at
    FROM aso_change_events
    WHERE tenant_id = ${tenantId} AND app_id = ${appId} AND country = ${country}
      AND event_type = ${eventType}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return rows[0] ? rowToChangeEvent(rows[0]) : null;
}

export async function getChangeEvents(
  sql: postgres.Sql,
  tenantId: string,
  opts: { limit: number; before?: Date },
): Promise<ActivityEvent[]> {
  const rows = await sql<ActivityRow[]>`
    SELECT e.id, e.tenant_id, e.app_id, e.country, e.event_type, e.payload_json, e.created_at,
           t.app_name
    FROM aso_change_events e
    LEFT JOIN aso_tracked_apps t
      ON t.tenant_id = e.tenant_id AND t.app_id = e.app_id AND t.country = e.country
    WHERE e.tenant_id = ${tenantId}
      AND e.event_type != 'version_status'
      AND (${opts.before ?? null}::timestamptz IS NULL OR e.created_at < ${opts.before ?? null}::timestamptz)
    ORDER BY e.created_at DESC
    LIMIT ${opts.limit}
  `;
  return rows.map(r => ({
    id: r.id,
    appId: r.app_id,
    appName: r.app_name ?? r.app_id,
    country: r.country,
    eventType: r.event_type as ActivityEvent['eventType'],
    payload: JSON.parse(r.payload_json) as Record<string, unknown>,
    createdAt: r.created_at.toISOString(),
  }));
}
```

- [ ] **Step 1.6: Run tests and verify they pass**

```bash
cd apps/server && pnpm test -- tracking/store.test.ts
```

Expected: All 5 tests PASS.

- [ ] **Step 1.7: Commit**

```bash
git add apps/server/src/tracking/types.ts \
        apps/server/src/tracking/store.ts \
        apps/server/src/tracking/store.test.ts \
        apps/server/src/memory/pg-migrate.ts
git commit -m "feat(p7b): tracking types, DB migrations, and store functions"
```

---

## Task 2: Tracking API Routes + Activity Route

**Files:**
- Create: `apps/server/src/tracking/routes.ts`
- Create: `apps/server/src/tracking/routes.test.ts`
- Modify: `apps/server/src/mastra/index.ts`

**Interfaces:**
- Consumes: `upsertTrackedApp`, `getTrackedApps`, `disableTrackedApp`, `getChangeEvents` from `./store`
- Consumes: `TrackedApp`, `ActivityEvent` from `./types`
- Produces: exported `trackingRoutes` array (used by `mastra/index.ts`)

---

- [ ] **Step 2.1: Write the failing route tests**

Create `apps/server/src/tracking/routes.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import postgres from 'postgres';
import { runPgMigrations } from '../memory/pg-migrate';
import { trackingRoutes } from './routes';
import { insertChangeEvent } from './store';

const TEST_URL = process.env.DATABASE_TEST_URL ?? 'postgresql://aso:aso@localhost:5432/aso_audit_test';

function makeCtx(opts: { body?: unknown; tenantId?: string; params?: Record<string, string>; query?: Record<string, string> }) {
  return {
    req: {
      json: async () => opts.body ?? {},
      header: (name: string) =>
        name === 'Authorization' && opts.tenantId ? `Bearer FAKE_${opts.tenantId}` : undefined,
      param: (key: string) => opts.params?.[key] ?? '',
      query: (key: string) => opts.query?.[key],
    },
    json: (body: unknown, status?: number) => ({ body, status: status ?? 200 }),
  };
}

vi.mock('../auth/middleware', () => ({
  getAuthenticatedTenantId: (c: any) => {
    const h = c.req.header('Authorization') as string | undefined;
    if (!h?.startsWith('Bearer FAKE_')) return null;
    return h.slice('Bearer FAKE_'.length);
  },
}));

let testSql: postgres.Sql;
vi.mock('../memory', () => ({ getPgSql: () => testSql }));

describe('tracking routes', () => {
  const schema = `tracking_routes_test_${Date.now()}`;

  beforeAll(async () => {
    testSql = postgres(TEST_URL, { connection: { search_path: schema } });
    await testSql`CREATE SCHEMA IF NOT EXISTS ${testSql(schema)}`;
    await runPgMigrations(testSql);
  });

  afterAll(async () => {
    await testSql`DROP SCHEMA IF EXISTS ${testSql(schema)} CASCADE`;
    await testSql.end();
  });

  it('POST /tracking creates a tracked app (201)', async () => {
    const route = trackingRoutes.find((r: any) => r.path === '/tracking' && r.method === 'POST');
    const ctx = makeCtx({
      tenantId: 'r-tenant1',
      body: { appId: '111', country: 'us', bundleId: 'com.test', appName: 'Test App', url: 'https://x' },
    });
    const res = await (route as any).handler(ctx);
    expect(res.status).toBe(201);
  });

  it('POST /tracking is idempotent', async () => {
    const route = trackingRoutes.find((r: any) => r.path === '/tracking' && r.method === 'POST');
    const body = { appId: '222', country: 'us', bundleId: '', appName: 'Idm', url: 'https://y' };
    await (route as any).handler(makeCtx({ tenantId: 'r-tenant2', body }));
    const res = await (route as any).handler(makeCtx({ tenantId: 'r-tenant2', body }));
    expect(res.status).toBe(201);
  });

  it('POST /tracking returns 400 when required fields missing', async () => {
    const route = trackingRoutes.find((r: any) => r.path === '/tracking' && r.method === 'POST');
    const res = await (route as any).handler(makeCtx({ tenantId: 'r-t', body: { appId: '333' } }));
    expect(res.status).toBe(400);
  });

  it('GET /tracking returns list of enabled apps', async () => {
    const postRoute = trackingRoutes.find((r: any) => r.path === '/tracking' && r.method === 'POST');
    await (postRoute as any).handler(makeCtx({
      tenantId: 'r-tenant3',
      body: { appId: '444', country: 'gb', bundleId: '', appName: 'GB App', url: 'https://gb' },
    }));
    const getRoute = trackingRoutes.find((r: any) => r.path === '/tracking' && r.method === 'GET');
    const res = await (getRoute as any).handler(makeCtx({ tenantId: 'r-tenant3' }));
    expect(res.body).toHaveLength(1);
    expect((res.body as any[])[0].appId).toBe('444');
  });

  it('DELETE /tracking/:appId disables the app', async () => {
    const postRoute = trackingRoutes.find((r: any) => r.path === '/tracking' && r.method === 'POST');
    await (postRoute as any).handler(makeCtx({
      tenantId: 'r-tenant4',
      body: { appId: '555', country: 'us', bundleId: '', appName: 'Del App', url: 'https://del' },
    }));
    const delRoute = trackingRoutes.find((r: any) => r.path === '/tracking/:appId' && r.method === 'DELETE');
    const res = await (delRoute as any).handler(makeCtx({ tenantId: 'r-tenant4', params: { appId: '555' } }));
    expect(res.status).toBe(204);

    const getRoute = trackingRoutes.find((r: any) => r.path === '/tracking' && r.method === 'GET');
    const getRes = await (getRoute as any).handler(makeCtx({ tenantId: 'r-tenant4' }));
    expect((getRes.body as any[])).toHaveLength(0);
  });

  it('GET /activity returns events without version_status', async () => {
    await insertChangeEvent(testSql, 'r-tenant5', {
      appId: 'ACT', country: 'us', eventType: 'version_status',
      payload: { versionString: '1.0', state: 'READY_FOR_SALE' },
    });
    await insertChangeEvent(testSql, 'r-tenant5', {
      appId: 'ACT', country: 'us', eventType: 'go_live',
      payload: { versionString: '1.0', appId: 'ACT', auditJobId: null },
    });

    const actRoute = trackingRoutes.find((r: any) => r.path === '/activity' && r.method === 'GET');
    const res = await (actRoute as any).handler(makeCtx({ tenantId: 'r-tenant5' }));
    expect((res.body as any[]).every((e: any) => e.eventType !== 'version_status')).toBe(true);
    expect(res.body).toHaveLength(1);
  });

  it('returns 401 when unauthenticated', async () => {
    const route = trackingRoutes.find((r: any) => r.path === '/tracking' && r.method === 'GET');
    const res = await (route as any).handler(makeCtx({}));
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2.2: Run tests to verify they fail**

```bash
cd apps/server && pnpm test -- tracking/routes.test.ts
```

Expected: FAIL with "Cannot find module './routes'"

- [ ] **Step 2.3: Write `routes.ts`**

Create `apps/server/src/tracking/routes.ts`:

```ts
import { registerApiRoute } from '@mastra/core/server';
import { getAuthenticatedTenantId } from '../auth/middleware';
import { getPgSql } from '../memory';
import { upsertTrackedApp, getTrackedApps, disableTrackedApp, getChangeEvents } from './store';

export const trackingRoutes = [
  registerApiRoute('/tracking', {
    method: 'POST',
    handler: async (c) => {
      const tenantId = await getAuthenticatedTenantId(c);
      if (!tenantId) return c.json({ error: 'Unauthorized' }, 401);
      const sql = getPgSql();
      if (!sql) return c.json({ error: 'Database unavailable' }, 503);

      const body = await c.req.json().catch(() => ({})) as {
        appId?: string; country?: string; bundleId?: string; appName?: string; url?: string;
      };

      if (!body.appId?.trim() || !body.appName?.trim() || !body.url?.trim()) {
        return c.json({ error: 'appId, appName, and url are required' }, 400);
      }

      await upsertTrackedApp(sql, tenantId, {
        appId: body.appId.trim(),
        country: (body.country ?? 'us').trim().toLowerCase(),
        bundleId: body.bundleId?.trim() ?? '',
        appName: body.appName.trim(),
        url: body.url.trim(),
      });
      return new Response(null, { status: 201 });
    },
  }),

  registerApiRoute('/tracking', {
    method: 'GET',
    handler: async (c) => {
      const tenantId = await getAuthenticatedTenantId(c);
      if (!tenantId) return c.json({ error: 'Unauthorized' }, 401);
      const sql = getPgSql();
      if (!sql) return c.json({ error: 'Database unavailable' }, 503);

      const apps = await getTrackedApps(sql, tenantId);
      return c.json(apps);
    },
  }),

  registerApiRoute('/tracking/:appId', {
    method: 'DELETE',
    handler: async (c) => {
      const tenantId = await getAuthenticatedTenantId(c);
      if (!tenantId) return c.json({ error: 'Unauthorized' }, 401);
      const sql = getPgSql();
      if (!sql) return c.json({ error: 'Database unavailable' }, 503);

      const appId = c.req.param('appId');
      await disableTrackedApp(sql, tenantId, appId);
      return new Response(null, { status: 204 });
    },
  }),

  registerApiRoute('/activity', {
    method: 'GET',
    handler: async (c) => {
      const tenantId = await getAuthenticatedTenantId(c);
      if (!tenantId) return c.json({ error: 'Unauthorized' }, 401);
      const sql = getPgSql();
      if (!sql) return c.json({ error: 'Database unavailable' }, 503);

      const limitRaw = c.req.query('limit') ?? '20';
      const beforeRaw = c.req.query('before');
      const limit = Math.min(Math.max(1, parseInt(limitRaw, 10) || 20), 50);
      const before = beforeRaw ? new Date(beforeRaw) : undefined;

      const events = await getChangeEvents(sql, tenantId, { limit, before });
      return c.json(events);
    },
  }),
];
```

- [ ] **Step 2.4: Run tests and verify they pass**

```bash
cd apps/server && pnpm test -- tracking/routes.test.ts
```

Expected: All 7 tests PASS.

- [ ] **Step 2.5: Register routes in `mastra/index.ts`**

Add the import at the top of `apps/server/src/mastra/index.ts` (after the `ascRoutes` import):

```ts
import { trackingRoutes } from '../tracking/routes';
```

Add `...trackingRoutes` to the `apiRoutes` spread:

```ts
apiRoutes: [...auditRoutes, ...authRoutes, ...healthRoutes, ...ascRoutes, ...trackingRoutes, ...getWebStaticRoutes()],
```

- [ ] **Step 2.6: Commit**

```bash
git add apps/server/src/tracking/routes.ts \
        apps/server/src/tracking/routes.test.ts \
        apps/server/src/mastra/index.ts
git commit -m "feat(p7b): tracking and activity routes"
```

---

## Task 3: Lightweight Scan (Three Checks)

**Files:**
- Create: `apps/server/src/tracking/scan.ts`
- Create: `apps/server/src/tracking/scan.test.ts`

**Interfaces:**
- Consumes: `TrackedApp` from `./types`; `insertChangeEvent`, `getLastChangeEvent` from `./store`
- Consumes: `loadCredentials` from `../asc/credential-store`; `getAppStoreVersionsClient` from `../asc/versions-client`; `getGateway` from `../cost/gateway`; `insertJob` from `../queue/job-store`; `newId` from `../memory/ids`
- Produces: `runScan(app, tenantId, sql, mastra): Promise<void>` (used by Task 4)

The scan fetches iTunes Lookup data and compares check 2/3 against `aso_listing_snapshots.listing_json`. The `listing_json` column stores a serialised `AppListing` object with fields: `name`, `subtitle`, `description`, `iconUrl`, `rating`, `ratingCount`. Parse it with `JSON.parse` — no need to import the Zod schema.

---

- [ ] **Step 3.1: Write the failing scan tests**

Create `apps/server/src/tracking/scan.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import postgres from 'postgres';
import { runPgMigrations } from '../memory/pg-migrate';
import { runScan } from './scan';
import { getLastChangeEvent, insertChangeEvent } from './store';

const TEST_URL = process.env.DATABASE_TEST_URL ?? 'postgresql://aso:aso@localhost:5432/aso_audit_test';

const FAKE_CREDS = { keyId: 'K', issuerId: 'I', privateKeyPem: '---BEGIN EC PRIVATE KEY---\nfake\n---END EC PRIVATE KEY---' };

vi.mock('../asc/credential-store', () => ({
  loadCredentials: vi.fn().mockResolvedValue({ ok: true, value: FAKE_CREDS }),
}));

const mockGetVersions = vi.fn();
vi.mock('../asc/versions-client', () => ({
  getAppStoreVersionsClient: () => ({ getAppVersions: mockGetVersions }),
}));

const mockFetch = vi.fn();
vi.mock('../cost/gateway', () => ({
  getGateway: () => ({ fetch: mockFetch }),
}));

const mockInsertJob = vi.fn().mockResolvedValue({ id: 'job_123' });
vi.mock('../queue/job-store', () => ({
  insertJob: (...args: any[]) => mockInsertJob(...args),
}));

vi.mock('../memory/ids', () => ({
  newId: (prefix: string) => `${prefix}_test_id`,
}));

describe('runScan', () => {
  const schema = `tracking_scan_test_${Date.now()}`;
  let sql: postgres.Sql;

  const baseApp = {
    appId: '12345', country: 'us', bundleId: '', appName: 'My App',
    url: 'https://apps.apple.com/app/id12345',
    enabled: true, enabledAt: new Date().toISOString(), lastScannedAt: null,
  };

  beforeAll(async () => {
    sql = postgres(TEST_URL, { connection: { search_path: schema } });
    await sql`CREATE SCHEMA IF NOT EXISTS ${sql(schema)}`;
    await runPgMigrations(sql);
  });

  afterAll(async () => {
    await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`;
    await sql.end();
  });

  it('emits version_status event when version changes', async () => {
    mockGetVersions.mockResolvedValueOnce({ ok: true, value: [{ versionString: '2.0.0', state: 'PREPARE_FOR_SUBMISSION', createdDate: '2026-01-01T00:00:00Z', earliestReleaseDate: null }] });
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }));

    await insertChangeEvent(sql, 'scan-t1', {
      appId: '12345', country: 'us', eventType: 'version_status',
      payload: { versionString: '1.0.0', state: 'READY_FOR_SALE' },
    });

    await runScan(baseApp, 'scan-t1', sql, {} as any);

    const last = await getLastChangeEvent(sql, 'scan-t1', '12345', 'us', 'version_status');
    expect(last?.payload).toMatchObject({ versionString: '2.0.0', state: 'PREPARE_FOR_SUBMISSION' });
  });

  it('emits go_live and calls insertJob on READY_FOR_SALE transition with new version', async () => {
    mockGetVersions.mockResolvedValueOnce({ ok: true, value: [{ versionString: '3.0.0', state: 'READY_FOR_SALE', createdDate: '2026-01-02T00:00:00Z', earliestReleaseDate: null }] });
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    mockInsertJob.mockResolvedValueOnce({ id: 'job_go_live' });

    await insertChangeEvent(sql, 'scan-t2', {
      appId: '12345', country: 'us', eventType: 'version_status',
      payload: { versionString: '2.5.0', state: 'PENDING_DEVELOPER_RELEASE' },
    });

    await runScan(baseApp, 'scan-t2', sql, {} as any);

    const goLive = await getLastChangeEvent(sql, 'scan-t2', '12345', 'us', 'go_live');
    expect(goLive?.payload).toMatchObject({ versionString: '3.0.0' });
    expect(mockInsertJob).toHaveBeenCalled();
  });

  it('does NOT emit go_live for same version already in READY_FOR_SALE', async () => {
    mockInsertJob.mockClear();
    mockGetVersions.mockResolvedValueOnce({ ok: true, value: [{ versionString: '1.0.0', state: 'READY_FOR_SALE', createdDate: '2026-01-01T00:00:00Z', earliestReleaseDate: null }] });
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }));

    await insertChangeEvent(sql, 'scan-t3', {
      appId: '12345', country: 'us', eventType: 'version_status',
      payload: { versionString: '1.0.0', state: 'READY_FOR_SALE' },
    });

    await runScan(baseApp, 'scan-t3', sql, {} as any);

    expect(mockInsertJob).not.toHaveBeenCalled();
    const goLive = await getLastChangeEvent(sql, 'scan-t3', '12345', 'us', 'go_live');
    expect(goLive).toBeNull();
  });

  it('emits metadata_changed when title differs from snapshot', async () => {
    mockGetVersions.mockResolvedValueOnce({ ok: true, value: [] });

    const snapshot = { name: 'Old Name', subtitle: null, description: 'desc', iconUrl: null, rating: 4.5, ratingCount: 100 };
    await sql`
      INSERT INTO aso_listing_snapshots (id, app_id, country, tenant_id, fetched_at, listing_json, signals_json, report_json, rubric_version, prompt_hash, model_id)
      VALUES ('snap-meta', '12345', 'us', 'scan-t4', NOW() - INTERVAL '1 hour', ${JSON.stringify(snapshot)}, '{}', '{}', 'v1', 'h1', 'm1')
    `;
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      results: [{ trackName: 'New Name', subtitle: null, description: 'desc', artworkUrl512: null, averageUserRating: 4.5, userRatingCount: 100 }],
    }), { status: 200 }));

    await runScan(baseApp, 'scan-t4', sql, {} as any);

    const changed = await getLastChangeEvent(sql, 'scan-t4', '12345', 'us', 'metadata_changed');
    expect(changed?.payload).toMatchObject({ field: 'name', before: 'Old Name', after: 'New Name' });
  });

  it('emits reviews_shifted when rating changes by ≥0.1', async () => {
    mockGetVersions.mockResolvedValueOnce({ ok: true, value: [] });

    const snapshot = { name: 'App', subtitle: null, description: 'desc', iconUrl: null, rating: 4.2, ratingCount: 500 };
    await sql`
      INSERT INTO aso_listing_snapshots (id, app_id, country, tenant_id, fetched_at, listing_json, signals_json, report_json, rubric_version, prompt_hash, model_id)
      VALUES ('snap-rev', '12345', 'us', 'scan-t5', NOW() - INTERVAL '1 hour', ${JSON.stringify(snapshot)}, '{}', '{}', 'v1', 'h1', 'm1')
    `;
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      results: [{ trackName: 'App', subtitle: null, description: 'desc', artworkUrl512: null, averageUserRating: 4.4, userRatingCount: 500 }],
    }), { status: 200 }));

    await runScan(baseApp, 'scan-t5', sql, {} as any);

    const shifted = await getLastChangeEvent(sql, 'scan-t5', '12345', 'us', 'reviews_shifted');
    expect(shifted?.payload).toMatchObject({ ratingBefore: 4.2, ratingAfter: 4.4 });
  });

  it('check 2 and 3 still run when loadCredentials returns null (no credentials)', async () => {
    const { loadCredentials } = await import('../asc/credential-store');
    vi.mocked(loadCredentials).mockResolvedValueOnce({ ok: true, value: null });

    const snapshot = { name: 'App', subtitle: 'Old Sub', description: 'd', iconUrl: null, rating: 4.0, ratingCount: 10 };
    await sql`
      INSERT INTO aso_listing_snapshots (id, app_id, country, tenant_id, fetched_at, listing_json, signals_json, report_json, rubric_version, prompt_hash, model_id)
      VALUES ('snap-nocreds', '12345', 'us', 'scan-t6', NOW() - INTERVAL '1 hour', ${JSON.stringify(snapshot)}, '{}', '{}', 'v1', 'h1', 'm1')
    `;
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      results: [{ trackName: 'App', subtitle: 'New Sub', description: 'd', artworkUrl512: null, averageUserRating: 4.0, userRatingCount: 10 }],
    }), { status: 200 }));

    await runScan(baseApp, 'scan-t6', sql, {} as any);

    const changed = await getLastChangeEvent(sql, 'scan-t6', '12345', 'us', 'metadata_changed');
    expect(changed?.payload).toMatchObject({ field: 'subtitle', before: 'Old Sub', after: 'New Sub' });
  });
});
```

- [ ] **Step 3.2: Run tests to verify they fail**

```bash
cd apps/server && pnpm test -- tracking/scan.test.ts
```

Expected: FAIL with "Cannot find module './scan'"

- [ ] **Step 3.3: Write `scan.ts`**

Create `apps/server/src/tracking/scan.ts`:

```ts
import type postgres from 'postgres';
import type { Mastra } from '@mastra/core';
import type { TrackedApp } from './types';
import { loadCredentials, type AscCredentials } from '../asc/credential-store';
import { getAppStoreVersionsClient } from '../asc/versions-client';
import { getGateway } from '../cost/gateway';
import { insertJob } from '../queue/job-store';
import { newId } from '../memory/ids';
import { insertChangeEvent, getLastChangeEvent } from './store';

export async function runScan(
  app: TrackedApp,
  tenantId: string,
  sql: postgres.Sql,
  _mastra: Mastra,
): Promise<void> {
  const credsResult = await loadCredentials(sql, tenantId);
  if (credsResult.ok && credsResult.value) {
    try {
      await runVersionCheck(app, tenantId, sql, credsResult.value);
    } catch (e) {
      console.error(`[tracking] version check failed for ${tenantId}/${app.appId}:`, e);
    }
  }

  try {
    await runItunesChecks(app, tenantId, sql);
  } catch (e) {
    console.error(`[tracking] iTunes checks failed for ${tenantId}/${app.appId}:`, e);
  }
}

async function runVersionCheck(
  app: TrackedApp,
  tenantId: string,
  sql: postgres.Sql,
  creds: AscCredentials,
): Promise<void> {
  const client = getAppStoreVersionsClient(creds);
  const result = await client.getAppVersions(app.appId);
  if (!result.ok) {
    console.warn(`[tracking] getAppVersions failed:`, result.error);
    return;
  }
  const top = result.value[0];
  if (!top) return;

  const lastEvent = await getLastChangeEvent(sql, tenantId, app.appId, app.country, 'version_status');
  const lastPayload = lastEvent?.payload as { versionString: string; state: string } | undefined;

  const versionChanged = !lastPayload || lastPayload.versionString !== top.versionString;
  const stateChanged = !lastPayload || lastPayload.state !== top.state;

  if (versionChanged || stateChanged) {
    await insertChangeEvent(sql, tenantId, {
      appId: app.appId, country: app.country,
      eventType: 'version_status',
      payload: { versionString: top.versionString, state: top.state },
    });

    const isNewVersion = !lastPayload || lastPayload.versionString !== top.versionString;
    if (top.state === 'READY_FOR_SALE' && isNewVersion) {
      let auditJobId: string | null = null;
      try {
        const job = await insertJob(sql, { runId: newId('run'), tenantId, url: app.url });
        auditJobId = job.id;
      } catch (e) {
        console.error(`[tracking] insertJob failed for go_live ${tenantId}/${app.appId}:`, e);
      }
      await insertChangeEvent(sql, tenantId, {
        appId: app.appId, country: app.country,
        eventType: 'go_live',
        payload: { versionString: top.versionString, appId: app.appId, auditJobId },
      });
    }
  }
}

async function runItunesChecks(
  app: TrackedApp,
  tenantId: string,
  sql: postgres.Sql,
): Promise<void> {
  const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(app.appId)}&country=${encodeURIComponent(app.country)}&entity=software`;
  const res = await getGateway().fetch(url, { kind: 'app', upstream: 'itunes' });
  if (!res.ok) {
    console.warn(`[tracking] iTunes lookup returned ${res.status} for ${app.appId}`);
    return;
  }
  const data = await res.json() as { results?: Record<string, unknown>[] };
  const result = data.results?.[0];
  if (!result) {
    console.warn(`[tracking] iTunes lookup returned no result for ${app.appId}`);
    return;
  }

  // Baseline: last snapshot from aso_listing_snapshots
  // listing_json stores a serialised AppListing: { name, subtitle, description, iconUrl, rating, ratingCount }
  const [snapshotRow] = await sql<{ listing_json: string }[]>`
    SELECT listing_json FROM aso_listing_snapshots
    WHERE tenant_id = ${tenantId} AND app_id = ${app.appId} AND country = ${app.country}
    ORDER BY fetched_at DESC
    LIMIT 1
  `;

  if (!snapshotRow) return;

  const baseline = JSON.parse(snapshotRow.listing_json) as {
    name?: string;
    subtitle?: string | null;
    description?: string;
    iconUrl?: string | null;
    rating?: number | null;
    ratingCount?: number | null;
  };

  // Check 2: metadata diff
  const fields = [
    { key: 'name',        before: baseline.name        ?? null, after: (result.trackName  as string | undefined) ?? null },
    { key: 'subtitle',    before: baseline.subtitle    ?? null, after: (result.subtitle   as string | null | undefined) ?? null },
    { key: 'description', before: baseline.description ?? null, after: (result.description as string | undefined) ?? null },
    { key: 'iconUrl',     before: baseline.iconUrl     ?? null, after: (result.artworkUrl512 as string | null | undefined) ?? null },
  ] as const;

  for (const { key, before, after } of fields) {
    if (before !== after) {
      await insertChangeEvent(sql, tenantId, {
        appId: app.appId, country: app.country,
        eventType: 'metadata_changed',
        payload: { field: key, before, after },
      });
    }
  }

  // Check 3: review delta
  const lastReviews = await getLastChangeEvent(sql, tenantId, app.appId, app.country, 'reviews_shifted');
  const baseRating  = lastReviews ? (lastReviews.payload as any).ratingAfter  : (baseline.rating     ?? null);
  const baseCount   = lastReviews ? (lastReviews.payload as any).countAfter   : (baseline.ratingCount ?? null);

  const currentRating = (result.averageUserRating as number | undefined) ?? null;
  const currentCount  = (result.userRatingCount  as number | undefined) ?? null;

  const ratingDelta = baseRating !== null && currentRating !== null ? Math.abs(currentRating - baseRating) : null;
  const countDelta  = baseCount  !== null && currentCount  !== null ? Math.abs(currentCount  - baseCount)  : null;

  if ((ratingDelta !== null && ratingDelta >= 0.1) || (countDelta !== null && countDelta >= 5)) {
    await insertChangeEvent(sql, tenantId, {
      appId: app.appId, country: app.country,
      eventType: 'reviews_shifted',
      payload: { ratingBefore: baseRating, ratingAfter: currentRating, countBefore: baseCount, countAfter: currentCount },
    });
  }
}
```

- [ ] **Step 3.4: Run tests and verify they pass**

```bash
cd apps/server && pnpm test -- tracking/scan.test.ts
```

Expected: All 6 tests PASS.

- [ ] **Step 3.5: Commit**

```bash
git add apps/server/src/tracking/scan.ts apps/server/src/tracking/scan.test.ts
git commit -m "feat(p7b): lightweight scan — version, metadata, review checks"
```

---

## Task 4: Scheduler

**Files:**
- Create: `apps/server/src/tracking/scheduler.ts`
- Create: `apps/server/src/tracking/scheduler.test.ts`
- Modify: `apps/server/src/mastra/index.ts`

**Interfaces:**
- Consumes: `getDueApps`, `updateLastScanned` from `./store`; `runScan` from `./scan`
- Produces: `startTrackingScheduler(mastra, sql): SchedulerHandle` (called from `mastra/index.ts`)

---

- [ ] **Step 4.1: Write the failing scheduler tests**

Create `apps/server/src/tracking/scheduler.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { startTrackingScheduler } from './scheduler';

const mockGetDueApps   = vi.fn();
const mockUpdateScanned = vi.fn().mockResolvedValue(undefined);
const mockRunScan      = vi.fn();

vi.mock('./store', () => ({
  getDueApps:        (...args: any[]) => mockGetDueApps(...args),
  updateLastScanned: (...args: any[]) => mockUpdateScanned(...args),
}));

vi.mock('./scan', () => ({
  runScan: (...args: any[]) => mockRunScan(...args),
}));

describe('startTrackingScheduler', () => {
  const fakeSql = {} as any;
  const fakeMastra = {} as any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  it('fires an immediate first pass on start', async () => {
    mockGetDueApps.mockResolvedValueOnce([]);
    startTrackingScheduler(fakeMastra, fakeSql);
    // Flush the immediate tick
    await vi.runAllTimersAsync();
    expect(mockGetDueApps).toHaveBeenCalledTimes(1);
  });

  it('scans due apps and updates last_scanned_at', async () => {
    const dueApp = { tenantId: 'T1', app: { appId: 'A1', country: 'us', appName: 'App', url: 'https://x', bundleId: '', enabled: true, enabledAt: '', lastScannedAt: null } };
    mockGetDueApps.mockResolvedValueOnce([dueApp]).mockResolvedValue([]);
    mockRunScan.mockResolvedValueOnce(undefined);

    const handle = startTrackingScheduler(fakeMastra, fakeSql);
    await vi.runAllTimersAsync();

    expect(mockRunScan).toHaveBeenCalledWith(dueApp.app, 'T1', fakeSql, fakeMastra);
    expect(mockUpdateScanned).toHaveBeenCalledWith(fakeSql, 'T1', 'A1', 'us');
    handle.stop();
  });

  it('updateLastScanned is called even when runScan throws', async () => {
    const dueApp = { tenantId: 'T2', app: { appId: 'A2', country: 'us', appName: 'App', url: 'https://y', bundleId: '', enabled: true, enabledAt: '', lastScannedAt: null } };
    mockGetDueApps.mockResolvedValueOnce([dueApp]).mockResolvedValue([]);
    mockRunScan.mockRejectedValueOnce(new Error('scan failed'));

    const handle = startTrackingScheduler(fakeMastra, fakeSql);
    await vi.runAllTimersAsync();

    expect(mockUpdateScanned).toHaveBeenCalledWith(fakeSql, 'T2', 'A2', 'us');
    handle.stop();
  });

  it('a scan error does not prevent other apps from being scanned', async () => {
    const due = [
      { tenantId: 'T3', app: { appId: 'FAIL', country: 'us', appName: 'Fail', url: 'https://f', bundleId: '', enabled: true, enabledAt: '', lastScannedAt: null } },
      { tenantId: 'T3', app: { appId: 'OK', country: 'us', appName: 'Ok', url: 'https://ok', bundleId: '', enabled: true, enabledAt: '', lastScannedAt: null } },
    ];
    mockGetDueApps.mockResolvedValueOnce(due).mockResolvedValue([]);
    mockRunScan
      .mockRejectedValueOnce(new Error('first fails'))
      .mockResolvedValueOnce(undefined);

    const handle = startTrackingScheduler(fakeMastra, fakeSql);
    await vi.runAllTimersAsync();

    expect(mockRunScan).toHaveBeenCalledTimes(2);
    expect(mockUpdateScanned).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it('stop() cancels the interval', async () => {
    mockGetDueApps.mockResolvedValue([]);
    const handle = startTrackingScheduler(fakeMastra, fakeSql);
    await vi.runAllTimersAsync(); // first pass
    handle.stop();

    vi.advanceTimersByTime(60 * 60 * 1000 * 3); // 3 hours
    await vi.runAllTimersAsync();

    // Only the one initial tick should have run
    expect(mockGetDueApps).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 4.2: Run tests to verify they fail**

```bash
cd apps/server && pnpm test -- tracking/scheduler.test.ts
```

Expected: FAIL with "Cannot find module './scheduler'"

- [ ] **Step 4.3: Write `scheduler.ts`**

Create `apps/server/src/tracking/scheduler.ts`:

```ts
import type postgres from 'postgres';
import type { Mastra } from '@mastra/core';
import { getDueApps, updateLastScanned } from './store';
import { runScan } from './scan';

export interface SchedulerHandle {
  stop: () => void;
}

export function startTrackingScheduler(
  mastra: Mastra,
  sql: postgres.Sql,
): SchedulerHandle {
  const INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  async function tick(): Promise<void> {
    let due: Awaited<ReturnType<typeof getDueApps>>;
    try {
      due = await getDueApps(sql);
    } catch (e) {
      console.error('[tracking] getDueApps failed:', e);
      return;
    }

    for (const { tenantId, app } of due) {
      try {
        await runScan(app, tenantId, sql, mastra);
      } catch (e) {
        console.error(`[tracking] scan error for ${tenantId}/${app.appId}:`, e);
      }
      try {
        await updateLastScanned(sql, tenantId, app.appId, app.country);
      } catch (e) {
        console.error(`[tracking] updateLastScanned failed for ${tenantId}/${app.appId}:`, e);
      }
    }
  }

  // Immediate first pass — recovers any apps that went unscanned during downtime
  void tick();
  const timer = setInterval(() => void tick(), INTERVAL_MS);

  return { stop: () => clearInterval(timer) };
}
```

- [ ] **Step 4.4: Run tests and verify they pass**

```bash
cd apps/server && pnpm test -- tracking/scheduler.test.ts
```

Expected: All 5 tests PASS.

- [ ] **Step 4.5: Wire scheduler into `mastra/index.ts`**

Add the import after the `trackingRoutes` import:

```ts
import { startTrackingScheduler } from '../tracking/scheduler';
```

Inside the `.then(() => { const worker = startWorker(...) ... })` block, start the scheduler right after `startWorker`:

```ts
runPgMigrations(sql)
  .then(() => {
    const worker = startWorker(mastra, sql);
    const tracker = startTrackingScheduler(mastra, sql);
    registerShutdown(worker, tracker, sql);
  })
```

Update `registerShutdown` to accept and stop the tracker:

```ts
function registerShutdown(
  worker: WorkerHandle,
  tracker: import('../tracking/scheduler').SchedulerHandle,
  sql: import('postgres').Sql,
): void {
  async function shutdown(signal: string): Promise<void> {
    console.log(`[shutdown] ${signal} received — stopping worker and tracker...`);
    worker.stop();
    tracker.stop();
    // ... rest unchanged
```

- [ ] **Step 4.6: Run all server tests to confirm nothing regressed**

```bash
cd apps/server && pnpm test
```

Expected: All tests PASS (no regressions).

- [ ] **Step 4.7: Commit**

```bash
git add apps/server/src/tracking/scheduler.ts \
        apps/server/src/tracking/scheduler.test.ts \
        apps/server/src/mastra/index.ts
git commit -m "feat(p7b): hourly tracking scheduler wired into server startup"
```

---

## Task 5: Web UI — TrackingCard, ActivityFeed, Activity Tab

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Create: `apps/web/src/components/TrackingCard.tsx`
- Create: `apps/web/src/components/ActivityFeed.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/components/ReportView.tsx` (add `<TrackingCard>` after recs)

---

- [ ] **Step 5.1: Add tracking API functions to `api.ts`**

Append to the end of `apps/web/src/lib/api.ts`:

```ts
export interface TrackedApp {
  appId: string;
  country: string;
  bundleId: string;
  appName: string;
  url: string;
  enabled: boolean;
  enabledAt: string;
  lastScannedAt: string | null;
}

export async function getTrackedApps(): Promise<TrackedApp[]> {
  const res = await authedFetch('/tracking');
  if (!res.ok) throw new Error('Failed to fetch tracked apps');
  return res.json() as Promise<TrackedApp[]>;
}

export async function startTracking(params: {
  appId: string;
  country: string;
  bundleId?: string;
  appName: string;
  url: string;
}): Promise<void> {
  const res = await authedFetch('/tracking', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error('Failed to start tracking');
}

export async function stopTracking(appId: string): Promise<void> {
  const res = await authedFetch(`/tracking/${encodeURIComponent(appId)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to stop tracking');
}

export interface ActivityEvent {
  id: string;
  appId: string;
  appName: string;
  country: string;
  eventType: 'go_live' | 'metadata_changed' | 'reviews_shifted';
  payload: Record<string, unknown>;
  createdAt: string;
}

export async function fetchActivity(limit = 20): Promise<ActivityEvent[]> {
  const res = await authedFetch(`/activity?limit=${limit}`);
  if (!res.ok) throw new Error('Failed to fetch activity');
  return res.json() as Promise<ActivityEvent[]>;
}
```

- [ ] **Step 5.2: Create `TrackingCard.tsx`**

Create `apps/web/src/components/TrackingCard.tsx`:

```tsx
import React, { useState, useEffect } from 'react';
import { getTrackedApps, startTracking, stopTracking } from '../lib/api';

interface Props {
  appId: string;
  appName: string;
  url: string;
  country: string;
}

function formatRelative(date: Date): string {
  const hours = Math.round((Date.now() - date.getTime()) / 3_600_000);
  if (hours < 1) return 'less than an hour ago';
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
}

export function TrackingCard({ appId, appName, url, country }: Props) {
  const [status, setStatus] = useState<'loading' | 'tracking' | 'not_tracking'>('loading');
  const [lastScannedAt, setLastScannedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getTrackedApps()
      .then((apps) => {
        const found = apps.find((a) => a.appId === appId && a.country === country);
        if (found) {
          setStatus('tracking');
          setLastScannedAt(found.lastScannedAt);
        } else {
          setStatus('not_tracking');
        }
      })
      .catch(() => setStatus('not_tracking'));
  }, [appId, country]);

  async function handleEnable() {
    setBusy(true);
    setError(null);
    try {
      await startTracking({ appId, appName, url, country });
      setStatus('tracking');
      setLastScannedAt(null);
    } catch {
      setError('Failed to enable tracking. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDisable() {
    setBusy(true);
    setError(null);
    try {
      await stopTracking(appId);
      setStatus('not_tracking');
    } catch {
      setError('Failed to disable tracking. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (status === 'loading') return null;

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      {status === 'not_tracking' ? (
        <>
          <p className="font-semibold text-gray-900">Watch this app</p>
          <p className="mt-1 text-sm text-gray-500">
            I'll check daily for go-lives, metadata changes, and review shifts.
          </p>
          {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
          <button
            className="mt-3 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            onClick={handleEnable}
            disabled={busy}
          >
            {busy ? 'Enabling…' : 'Enable tracking'}
          </button>
        </>
      ) : (
        <>
          <p className="font-semibold text-gray-900">Tracking active</p>
          <p className="mt-1 text-sm text-gray-500">
            {lastScannedAt
              ? `Last checked ${formatRelative(new Date(lastScannedAt))}`
              : 'First scan pending'}
          </p>
          {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
          <button
            className="mt-2 text-xs text-gray-400 hover:text-gray-600 disabled:opacity-50"
            onClick={handleDisable}
            disabled={busy}
          >
            {busy ? 'Disabling…' : 'Disable'}
          </button>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 5.3: Create `ActivityFeed.tsx`**

Create `apps/web/src/components/ActivityFeed.tsx`:

```tsx
import React, { useState, useEffect } from 'react';
import { fetchActivity, type ActivityEvent } from '../lib/api';

function ActivityCard({ event }: { event: ActivityEvent }) {
  const date = new Date(event.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

  if (event.eventType === 'go_live') {
    const p = event.payload as { versionString: string };
    return (
      <div className="rounded-lg border border-green-200 bg-green-50 p-4">
        <p className="font-medium text-green-800">
          {event.appName} v{p.versionString} went live
        </p>
        <p className="text-sm text-green-600">{date} · Full audit queued</p>
      </div>
    );
  }

  if (event.eventType === 'metadata_changed') {
    const p = event.payload as { field: string; before: string | null; after: string | null };
    const label = p.field.charAt(0).toUpperCase() + p.field.slice(1);
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <p className="font-medium text-gray-900">{label} changed · {event.appName}</p>
        <p className="text-sm text-gray-500">{date}</p>
        {p.before !== null && p.after !== null && (
          <p className="mt-1 truncate text-xs text-gray-400">
            {String(p.before).slice(0, 60)} → {String(p.after).slice(0, 60)}
          </p>
        )}
      </div>
    );
  }

  if (event.eventType === 'reviews_shifted') {
    const p = event.payload as { ratingBefore: number | null; ratingAfter: number | null; countBefore: number | null; countAfter: number | null };
    const countDelta = p.countAfter != null && p.countBefore != null ? p.countAfter - p.countBefore : null;
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <p className="font-medium text-gray-900">
          Rating {p.ratingBefore?.toFixed(1)} → {p.ratingAfter?.toFixed(1)} · {event.appName}
        </p>
        <p className="text-sm text-gray-500">
          {date}{countDelta != null ? ` · ${countDelta > 0 ? '+' : ''}${countDelta} reviews` : ''}
        </p>
      </div>
    );
  }

  return null;
}

export function ActivityFeed() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchActivity(20)
      .then(setEvents)
      .catch(() => setEvents([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="py-8 text-center text-sm text-gray-400">Loading activity…</div>;
  }

  if (events.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-gray-400">
        No activity yet. Enable tracking for an app after auditing it.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {events.map((event) => (
        <ActivityCard key={event.id} event={event} />
      ))}
    </div>
  );
}
```

- [ ] **Step 5.4: Update `App.tsx` — add Activity tab and view-state**

Open `apps/web/src/App.tsx`. Make these two changes:

**Change 1** — import `ActivityFeed` (add after the `AscSettings` import):

```ts
import { ActivityFeed } from './components/ActivityFeed';
```

**Change 2** — In the `AppContent` function, add a `view` state and wire the Activity tab into `Header`. Replace:

```tsx
function AppContent() {
  const { messages, busy, submitUrl, confirm, confirmAnyway, reject, reopenIdentity } = useAudit();
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  // "Change my answer" — hides the challenge card so the prior confirmation
  // card is active again. Status is already 'confirming' (set by onConflict),
  // so the confirmation card re-renders as pending without any hook change.
  const [dismissedChallenges, setDismissedChallenges] = useState<Set<string>>(
    () => new Set(),
  );
  const onRevise = useCallback((id: string) => {
    setDismissedChallenges((prev) => new Set([...prev, id]));
  }, []);

  return (
    <div className="flex h-full flex-col">
      <Header />
```

With:

```tsx
function AppContent() {
  const { messages, busy, submitUrl, confirm, confirmAnyway, reject, reopenIdentity } = useAudit();
  const endRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<'audit' | 'activity'>('audit');

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  const [dismissedChallenges, setDismissedChallenges] = useState<Set<string>>(
    () => new Set(),
  );
  const onRevise = useCallback((id: string) => {
    setDismissedChallenges((prev) => new Set([...prev, id]));
  }, []);

  return (
    <div className="flex h-full flex-col">
      <Header onNavigate={setView} currentView={view} />
```

**Change 3** — In the JSX returned by `AppContent`, wrap the `main` content to conditionally render `ActivityFeed` when `view === 'activity'`. Replace the `<main ...>` block opening with:

```tsx
      {view === 'activity' ? (
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-4 py-6">
            <h1 className="mb-4 text-lg font-semibold text-gray-900">Activity</h1>
            <ActivityFeed />
          </div>
        </main>
      ) : (
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-4 py-6">
```

Close the conditional after the `</main>` that ends the existing audit content (add `)}` before the Composer block):

```tsx
          </div>
        </main>
      )}
```

**Change 4** — In the `Header` function signature, add props:

```tsx
function Header({ onNavigate, currentView }: {
  onNavigate: (view: 'audit' | 'activity') => void;
  currentView: 'audit' | 'activity';
}) {
```

Add the Activity tab button inside the Header JSX, next to the gear icon:

```tsx
<button
  className={`rounded px-3 py-1.5 text-sm font-medium ${
    currentView === 'activity'
      ? 'bg-gray-100 text-gray-900'
      : 'text-gray-500 hover:text-gray-700'
  }`}
  onClick={() => onNavigate('activity')}
>
  Activity
</button>
<button
  className={`rounded px-3 py-1.5 text-sm font-medium ${
    currentView === 'audit'
      ? 'bg-gray-100 text-gray-900'
      : 'text-gray-500 hover:text-gray-700'
  }`}
  onClick={() => onNavigate('audit')}
>
  Audit
</button>
```

> **Read `App.tsx` fully before editing.** The existing `Header` renders inline — locate the gear icon button and add the nav buttons next to it. Adjust the surrounding `div` layout (e.g., `flex gap-2`) as needed for alignment.

- [ ] **Step 5.5: Add `TrackingCard` to `ReportView.tsx`**

Open `apps/web/src/components/ReportView.tsx`. Add the import at the top:

```tsx
import { TrackingCard } from './TrackingCard';
```

Inside the `ReportView` component, after the last recommendations section (strategic / quick-wins list), add the `TrackingCard`. The `report.app` provides `appId`, `name`, `url`, and `country`:

```tsx
<TrackingCard
  appId={report.app.appId}
  appName={report.app.name}
  url={report.app.url}
  country={report.app.country}
/>
```

> **Read `ReportView.tsx` fully before editing.** Add the card at the end of the recommendations area, before any footer or score display. Keep the existing layout unchanged.

- [ ] **Step 5.6: Verify the UI builds and renders correctly**

```bash
cd apps/web && pnpm build
```

Expected: Build completes with no TypeScript errors.

Then start the dev server and open the app:

```bash
cd apps/web && pnpm dev
```

Verify:
1. Header shows "Audit" and "Activity" buttons
2. Clicking "Activity" shows the `ActivityFeed` (empty state message if no events)
3. Clicking "Audit" returns to the audit chat view
4. After running an audit, the `TrackingCard` appears at the bottom of the report
5. "Enable tracking" button calls `POST /tracking` (check Network tab — should return 201)
6. Card flips to "Tracking active" after enabling
7. "Disable" calls `DELETE /tracking/:appId` (should return 204)

- [ ] **Step 5.7: Commit**

```bash
git add apps/web/src/lib/api.ts \
        apps/web/src/components/TrackingCard.tsx \
        apps/web/src/components/ActivityFeed.tsx \
        apps/web/src/App.tsx \
        apps/web/src/components/ReportView.tsx
git commit -m "feat(p7b): TrackingCard, ActivityFeed, and Activity tab"
```

---

## Self-Review

**Spec coverage:**
- Section 1 (tracked app registry + API routes) → Task 1 + Task 2 ✓
- Section 2 (daily scheduler) → Task 4 ✓
- Section 3 (lightweight scan — 3 checks) → Task 3 ✓
- Section 4 (change events table + event payloads) → Task 1 (store) + Task 3 (scan emits) ✓
- Section 5 (activity feed API) → Task 2 (GET /activity route) ✓
- Section 6 (UI — TrackingCard + Activity tab) → Task 5 ✓
- Section 7 (error handling) → scan.ts wraps each check; scheduler wraps each app ✓
- Section 8 (testing) → store.test, scan.test, scheduler.test, routes.test ✓
- `version_status` duplicate guard (spec §7: "only emit go_live if latest version_status has a different versionString") → `isNewVersion` check in `runVersionCheck` ✓
- `go_live` event still written even if `insertJob` throws → try/catch around `insertJob` ✓

**Type consistency check:**
- `ChangeEventType` used in `store.ts` `insertChangeEvent` and `getLastChangeEvent` matches definition in `types.ts` ✓
- `TrackedApp` produced by `store.ts` matches what `scan.ts` and `scheduler.ts` consume ✓
- `ActivityEvent` returned by `getChangeEvents` matches `api.ts`'s `ActivityEvent` interface ✓
- `startTrackingScheduler` signature in `scheduler.ts` matches usage in `mastra/index.ts` ✓

**No placeholders:** All code steps contain complete implementations. ✓
