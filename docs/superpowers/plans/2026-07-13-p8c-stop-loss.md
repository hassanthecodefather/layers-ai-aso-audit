# P8-C: Stop-Loss Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a listing update is approved by Apple, monitor conversion rate + impressions/downloads for 7 days and alert the user if metrics drop ≥ 15%; the user can then revert the listing to its previous values or dismiss the alert.

**Architecture:** A new `aso_listing_monitors` table owns a 6-state machine (`pending_baseline → polling_baseline → monitoring → polling_after → alerted/closed`). The hourly tracking scheduler gains a `runListingMonitorCheck` step that drives the state machine using the same ASC async report-request/poll pattern as P7-C measurement windows. On threshold breach a `listing_update_alert` change event is written; two new routes handle revert and dismiss.

**Tech Stack:** TypeScript, Postgres (JSONB), ASC Analytics API (`getAscAnalyticsClient`), Mastra/Hono routes, React, Vitest.

## Global Constraints

- Node ≥ 20.12 — use `nvm use 24` in dev shell
- Both new tables use JSONB → go in `PG_ONLY_MIGRATIONS`
- Threshold: conversion rate delta ≤ −0.15 AND (impressions delta ≤ −0.15 OR downloads delta ≤ −0.15) — delta is a fraction (−0.15 = −15%), not a percentage
- ASC Analytics report type: `'APP_STORE_ENGAGEMENT'`, frequency: `'DAILY'`
- Dates passed as `YYYY-MM-DD` strings (use `toDateStr(date)` helper defined in Task 3)
- Route handlers: `getAuthenticatedTenantId(c)` → body parse `.catch(() => ({}))` → `getPgSql()` → op → `c.json(data, status)`
- IDs: `lm_${randomUUID()}` for monitor rows
- Test runner: `cd apps/server && npx vitest run <path>` or `cd apps/web && npx vitest run <path>`
- Spec: `docs/superpowers/specs/2026-07-13-p8c-stop-loss-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `apps/server/src/memory/pg-migrate.ts` | Modify | Append `previous_fields` ALTER + `aso_listing_monitors` CREATE to `PG_ONLY_MIGRATIONS` |
| `apps/server/src/tracking/types.ts` | Modify | Add `listing_update_alert` and `listing_update_reverted` to `ChangeEventType` |
| `apps/server/src/queue/listing-monitor-store.ts` | **Create** | CRUD for `aso_listing_monitors` |
| `apps/server/src/queue/listing-monitor-store.test.ts` | **Create** | Unit tests for store functions |
| `apps/server/src/queue/listing-update-store.ts` | Modify | Add `previousFields` to `insertListingUpdate` params + `ListingUpdate` type |
| `apps/server/src/mastra/listing-update-routes.ts` | Modify | Store `currentFields` as `previous_fields` in generate route |
| `apps/server/src/tracking/listing-update-checker.ts` | Modify | Insert `aso_listing_monitors` row when approval is detected |
| `apps/server/src/tracking/listing-monitor-checker.ts` | **Create** | 4-step scheduler: submit/poll baseline, submit/poll after, evaluate threshold |
| `apps/server/src/tracking/listing-monitor-checker.test.ts` | **Create** | Unit tests for checker steps |
| `apps/server/src/tracking/scheduler.ts` | Modify | Call `runListingMonitorCheck` in `tick()` |
| `apps/server/src/mastra/listing-monitor-routes.ts` | **Create** | `POST /listing-update/revert` and `POST /listing-update/dismiss-alert` |
| `apps/server/src/mastra/index.ts` | Modify | Add `listingMonitorRoutes` to `apiRoutes` |
| `apps/web/src/lib/api.ts` | Modify | Add `revertListingUpdate`, `dismissListingAlert`; extend `ActivityEvent` type |
| `apps/web/src/components/ActivityFeed.tsx` | Modify | Handle `listing_update_alert` and `listing_update_reverted` event cards |

---

## Task 1: DB migrations + `listing-monitor-store.ts` + ChangeEventType

**Files:**
- Modify: `apps/server/src/memory/pg-migrate.ts`
- Modify: `apps/server/src/tracking/types.ts`
- Create: `apps/server/src/queue/listing-monitor-store.ts`
- Create: `apps/server/src/queue/listing-monitor-store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type MonitorStatus =
    | 'pending_baseline' | 'polling_baseline' | 'monitoring'
    | 'polling_after' | 'alerted' | 'closed';

  export interface MonitorMetrics {
    impressions: number; downloads: number; conversionRate: number;
  }

  export interface ListingMonitor {
    id: string; tenantId: string; appId: string; listingUpdateId: string;
    status: MonitorStatus;
    baselineRequestId: string | null; afterRequestId: string | null;
    baselineMetrics: MonitorMetrics | null; latestMetrics: MonitorMetrics | null;
    alertFiredAt: Date | null; closedAt: Date | null;
    approvedAt: Date; createdAt: Date;
  }

  export async function insertListingMonitor(sql, params: { tenantId, appId, listingUpdateId, approvedAt }): Promise<ListingMonitor>
  export async function getMonitorsInStatus(sql, status: MonitorStatus): Promise<ListingMonitor[]>
  export async function getMonitorById(sql, tenantId, id): Promise<ListingMonitor | null>
  export async function setMonitorBaselineRequest(sql, id, requestId): Promise<void>
  export async function setMonitorBaseline(sql, id, metrics): Promise<void>
  export async function setMonitorAfterRequest(sql, id, requestId): Promise<void>
  export async function setMonitorAlerted(sql, id, latestMetrics): Promise<void>
  export async function setMonitorClosed(sql, id): Promise<void>
  export async function forceCloseStaleMonitors(sql): Promise<void>
  ```

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/queue/listing-monitor-store.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

const makeRow = (overrides = {}) => ({
  id: 'lm_abc',
  tenant_id: 'tenant1',
  app_id: '123456',
  listing_update_id: 'lu_1',
  status: 'pending_baseline',
  baseline_request_id: null,
  after_request_id: null,
  baseline_metrics: null,
  latest_metrics: null,
  alert_fired_at: null,
  closed_at: null,
  approved_at: new Date('2026-07-01'),
  created_at: new Date('2026-07-01'),
  ...overrides,
});

describe('listing-monitor-store', () => {
  let mockSql: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    mockSql = vi.fn().mockResolvedValue([]);
  });

  it('insertListingMonitor returns a mapped ListingMonitor', async () => {
    mockSql.mockResolvedValueOnce([makeRow()]);
    const { insertListingMonitor } = await import('./listing-monitor-store');
    const result = await insertListingMonitor(mockSql as unknown as postgres.Sql, {
      tenantId: 'tenant1',
      appId: '123456',
      listingUpdateId: 'lu_1',
      approvedAt: new Date('2026-07-01'),
    });
    expect(result.id).toBe('lm_abc');
    expect(result.status).toBe('pending_baseline');
    expect(result.baselineMetrics).toBeNull();
    expect(result.approvedAt).toBeInstanceOf(Date);
  });

  it('getMonitorsInStatus returns mapped rows', async () => {
    mockSql.mockResolvedValueOnce([makeRow(), makeRow({ id: 'lm_2' })]);
    const { getMonitorsInStatus } = await import('./listing-monitor-store');
    const results = await getMonitorsInStatus(mockSql as unknown as postgres.Sql, 'pending_baseline');
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('lm_abc');
  });

  it('getMonitorById returns null when no row', async () => {
    mockSql.mockResolvedValueOnce([]);
    const { getMonitorById } = await import('./listing-monitor-store');
    const result = await getMonitorById(mockSql as unknown as postgres.Sql, 'tenant1', 'lm_missing');
    expect(result).toBeNull();
  });

  it('setMonitorAlerted parses JSON baseline_metrics from row with JSONB', async () => {
    const rowWithMetrics = makeRow({
      status: 'alerted',
      baseline_metrics: JSON.stringify({ impressions: 1000, downloads: 200, conversionRate: 0.2 }),
      latest_metrics: JSON.stringify({ impressions: 800, downloads: 160, conversionRate: 0.16 }),
    });
    mockSql.mockResolvedValueOnce([rowWithMetrics]);
    const { getMonitorById } = await import('./listing-monitor-store');
    const result = await getMonitorById(mockSql as unknown as postgres.Sql, 'tenant1', 'lm_abc');
    expect(result?.baselineMetrics).toEqual({ impressions: 1000, downloads: 200, conversionRate: 0.2 });
    expect(result?.latestMetrics).toEqual({ impressions: 800, downloads: 160, conversionRate: 0.16 });
  });

  it('setMonitorClosed calls sql with closed_at', async () => {
    const { setMonitorClosed } = await import('./listing-monitor-store');
    await setMonitorClosed(mockSql as unknown as postgres.Sql, 'lm_abc');
    expect(mockSql).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd apps/server && npx vitest run src/queue/listing-monitor-store.test.ts
```

Expected: FAIL — `Cannot find module './listing-monitor-store'`

- [ ] **Step 3: Append migrations to `pg-migrate.ts`**

Find `PG_ONLY_MIGRATIONS` in `apps/server/src/memory/pg-migrate.ts`. Append at the end of the array:

```typescript
  // P8-C: add previous_fields to listing updates for revert capability
  `ALTER TABLE aso_listing_updates ADD COLUMN previous_fields JSONB`,

  // P8-C: stop-loss monitoring table
  `CREATE TABLE IF NOT EXISTS aso_listing_monitors (
    id                   TEXT PRIMARY KEY,
    tenant_id            TEXT NOT NULL,
    app_id               TEXT NOT NULL,
    listing_update_id    TEXT NOT NULL REFERENCES aso_listing_updates(id),
    status               TEXT NOT NULL DEFAULT 'pending_baseline',
    baseline_request_id  TEXT,
    after_request_id     TEXT,
    baseline_metrics     JSONB,
    latest_metrics       JSONB,
    alert_fired_at       TIMESTAMPTZ,
    closed_at            TIMESTAMPTZ,
    approved_at          TIMESTAMPTZ NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS aso_listing_monitors_tenant_app
    ON aso_listing_monitors (tenant_id, app_id)`,
```

- [ ] **Step 4: Add new event types to `tracking/types.ts`**

Open `apps/server/src/tracking/types.ts` and extend `ChangeEventType`:

```typescript
// Before:
export type ChangeEventType = 'go_live' | 'metadata_changed' | 'reviews_shifted' | 'version_status' | 'measurement_verdict';

// After:
export type ChangeEventType =
  | 'go_live'
  | 'metadata_changed'
  | 'reviews_shifted'
  | 'version_status'
  | 'measurement_verdict'
  | 'listing_update_alert'
  | 'listing_update_reverted';
```

- [ ] **Step 5: Create `apps/server/src/queue/listing-monitor-store.ts`**

```typescript
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';

export type MonitorStatus =
  | 'pending_baseline'
  | 'polling_baseline'
  | 'monitoring'
  | 'polling_after'
  | 'alerted'
  | 'closed';

export interface MonitorMetrics {
  impressions: number;
  downloads: number;
  conversionRate: number;
}

export interface ListingMonitor {
  id: string;
  tenantId: string;
  appId: string;
  listingUpdateId: string;
  status: MonitorStatus;
  baselineRequestId: string | null;
  afterRequestId: string | null;
  baselineMetrics: MonitorMetrics | null;
  latestMetrics: MonitorMetrics | null;
  alertFiredAt: Date | null;
  closedAt: Date | null;
  approvedAt: Date;
  createdAt: Date;
}

interface MonitorRow {
  id: string;
  tenant_id: string;
  app_id: string;
  listing_update_id: string;
  status: string;
  baseline_request_id: string | null;
  after_request_id: string | null;
  baseline_metrics: string | null;
  latest_metrics: string | null;
  alert_fired_at: Date | null;
  closed_at: Date | null;
  approved_at: Date;
  created_at: Date;
}

function parseMetrics(raw: string | null): MonitorMetrics | null {
  if (!raw) return null;
  return typeof raw === 'string' ? (JSON.parse(raw) as MonitorMetrics) : (raw as unknown as MonitorMetrics);
}

function rowToMonitor(r: MonitorRow): ListingMonitor {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    appId: r.app_id,
    listingUpdateId: r.listing_update_id,
    status: r.status as MonitorStatus,
    baselineRequestId: r.baseline_request_id,
    afterRequestId: r.after_request_id,
    baselineMetrics: parseMetrics(r.baseline_metrics),
    latestMetrics: parseMetrics(r.latest_metrics),
    alertFiredAt: r.alert_fired_at,
    closedAt: r.closed_at,
    approvedAt: r.approved_at,
    createdAt: r.created_at,
  };
}

export async function insertListingMonitor(
  sql: postgres.Sql,
  params: {
    tenantId: string;
    appId: string;
    listingUpdateId: string;
    approvedAt: Date;
  },
): Promise<ListingMonitor> {
  const id = `lm_${randomUUID()}`;
  const rows = await sql<MonitorRow[]>`
    INSERT INTO aso_listing_monitors
      (id, tenant_id, app_id, listing_update_id, approved_at)
    VALUES (${id}, ${params.tenantId}, ${params.appId}, ${params.listingUpdateId}, ${params.approvedAt})
    RETURNING *
  `;
  return rowToMonitor(rows[0]);
}

export async function getMonitorsInStatus(
  sql: postgres.Sql,
  status: MonitorStatus,
): Promise<ListingMonitor[]> {
  const rows = await sql<MonitorRow[]>`
    SELECT * FROM aso_listing_monitors
    WHERE status = ${status}
    ORDER BY created_at ASC
  `;
  return rows.map(rowToMonitor);
}

export async function getMonitorById(
  sql: postgres.Sql,
  tenantId: string,
  id: string,
): Promise<ListingMonitor | null> {
  const rows = await sql<MonitorRow[]>`
    SELECT * FROM aso_listing_monitors
    WHERE id = ${id} AND tenant_id = ${tenantId}
    LIMIT 1
  `;
  return rows[0] ? rowToMonitor(rows[0]) : null;
}

export async function setMonitorBaselineRequest(
  sql: postgres.Sql,
  id: string,
  requestId: string,
): Promise<void> {
  await sql`
    UPDATE aso_listing_monitors
    SET status = 'polling_baseline', baseline_request_id = ${requestId}
    WHERE id = ${id}
  `;
}

export async function setMonitorBaseline(
  sql: postgres.Sql,
  id: string,
  metrics: MonitorMetrics,
): Promise<void> {
  await sql`
    UPDATE aso_listing_monitors
    SET status = 'monitoring', baseline_metrics = ${JSON.stringify(metrics)}
    WHERE id = ${id}
  `;
}

export async function setMonitorAfterRequest(
  sql: postgres.Sql,
  id: string,
  requestId: string,
): Promise<void> {
  await sql`
    UPDATE aso_listing_monitors
    SET status = 'polling_after', after_request_id = ${requestId}
    WHERE id = ${id}
  `;
}

export async function setMonitorAlerted(
  sql: postgres.Sql,
  id: string,
  latestMetrics: MonitorMetrics,
): Promise<void> {
  await sql`
    UPDATE aso_listing_monitors
    SET status      = 'alerted',
        latest_metrics = ${JSON.stringify(latestMetrics)},
        alert_fired_at = NOW()
    WHERE id = ${id}
  `;
}

export async function setMonitorClosed(
  sql: postgres.Sql,
  id: string,
): Promise<void> {
  await sql`
    UPDATE aso_listing_monitors
    SET status = 'closed', closed_at = NOW()
    WHERE id = ${id}
  `;
}

// Close monitors that have been stuck too long (fail-safe against zombie rows)
export async function forceCloseStaleMonitors(sql: postgres.Sql): Promise<void> {
  // pending_baseline stuck > 5 days after approval
  await sql`
    UPDATE aso_listing_monitors
    SET status = 'closed', closed_at = NOW()
    WHERE status IN ('pending_baseline', 'polling_baseline')
      AND approved_at < NOW() - INTERVAL '5 days'
  `;
  // monitoring or polling_after stuck > 14 days after approval
  await sql`
    UPDATE aso_listing_monitors
    SET status = 'closed', closed_at = NOW()
    WHERE status IN ('monitoring', 'polling_after')
      AND approved_at < NOW() - INTERVAL '14 days'
  `;
}
```

- [ ] **Step 6: Run tests — verify they pass**

```bash
cd apps/server && npx vitest run src/queue/listing-monitor-store.test.ts
```

Expected: 5 tests PASS

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/memory/pg-migrate.ts \
        apps/server/src/tracking/types.ts \
        apps/server/src/queue/listing-monitor-store.ts \
        apps/server/src/queue/listing-monitor-store.test.ts
git commit -m "feat(p8c): add aso_listing_monitors table, store CRUD, ChangeEventType extension"
```

---

## Task 2: Wire `previous_fields` into the P8-B generate flow

**Files:**
- Modify: `apps/server/src/queue/listing-update-store.ts`
- Modify: `apps/server/src/mastra/listing-update-routes.ts`

**Context:** The P8-C revert needs the field values that were in ASC *before* the listing update was applied. The generate route already fetches `currentFields` from ASC — this task stores them as `previous_fields` on the `aso_listing_updates` row.

**Note to implementer:** Read `apps/server/src/queue/listing-update-store.ts` and `apps/server/src/mastra/listing-update-routes.ts` in full before editing. These files were created in P8-B and must already exist. If they don't exist, implement P8-B first.

**Interfaces:**
- Consumes: `insertListingUpdate`, `ListingUpdate`, `ProposedFields` from `listing-update-store`
- Produces (extended):
  ```ts
  // insertListingUpdate params gains:
  previousFields?: ProposedFields | null;
  // ListingUpdate type gains:
  previousFields: ProposedFields | null;
  ```

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/queue/listing-update-store.test.ts`:

```typescript
it('insertListingUpdate stores and returns previousFields', async () => {
  // import listing-update-store fresh
  const { insertListingUpdate } = await import('./listing-update-store');
  const row = makeRow({ previous_fields: JSON.stringify({ title: 'Old Title' }) });
  mockSql.mockResolvedValueOnce([row]);
  const result = await insertListingUpdate(mockSql as unknown as postgres.Sql, {
    tenantId: 'tenant1',
    appId: '123456',
    proposedFields: { title: 'New Title' },
    previousFields: { title: 'Old Title' },
  });
  expect(result.previousFields).toEqual({ title: 'Old Title' });
});
```

`makeRow` in that test file needs the `previous_fields` column — add it to the base `makeRow` helper:

```typescript
// In the existing makeRow function, add:
previous_fields: null,
```

- [ ] **Step 2: Run test — verify it fails**

```bash
cd apps/server && npx vitest run src/queue/listing-update-store.test.ts
```

Expected: FAIL — `previousFields` not in result

- [ ] **Step 3: Update `listing-update-store.ts`**

Open `apps/server/src/queue/listing-update-store.ts`. Make three changes:

**1. Add `previous_fields` to `ListingUpdateRow`:**
```typescript
interface ListingUpdateRow {
  // ... existing fields ...
  previous_fields: string | null;  // ADD
}
```

**2. Add `previousFields` to `ListingUpdate`:**
```typescript
export interface ListingUpdate {
  // ... existing fields ...
  previousFields: ProposedFields | null;  // ADD
}
```

**3. Update `rowToListingUpdate` to parse it:**
```typescript
function rowToListingUpdate(r: ListingUpdateRow): ListingUpdate {
  return {
    // ... existing fields ...
    previousFields: r.previous_fields
      ? (typeof r.previous_fields === 'string'
          ? (JSON.parse(r.previous_fields) as ProposedFields)
          : (r.previous_fields as unknown as ProposedFields))
      : null,
  };
}
```

**4. Add `previousFields` to `insertListingUpdate` params and INSERT:**
```typescript
export async function insertListingUpdate(
  sql: postgres.Sql,
  params: {
    tenantId: string;
    appId: string;
    auditJobId?: string | null;
    proposedFields: ProposedFields;
    ascLocalizationId?: string | null;
    previousFields?: ProposedFields | null;  // ADD
  },
): Promise<ListingUpdate> {
  const id = `lu_${randomUUID()}`;
  const rows = await sql<ListingUpdateRow[]>`
    INSERT INTO aso_listing_updates
      (id, tenant_id, app_id, audit_job_id, proposed_fields, asc_localization_id, previous_fields)
    VALUES (
      ${id},
      ${params.tenantId},
      ${params.appId},
      ${params.auditJobId ?? null},
      ${JSON.stringify(params.proposedFields)},
      ${params.ascLocalizationId ?? null},
      ${params.previousFields ? JSON.stringify(params.previousFields) : null}
    )
    RETURNING *
  `;
  return rowToListingUpdate(rows[0]);
}
```

- [ ] **Step 4: Update `listing-update-routes.ts` generate handler**

Open `apps/server/src/mastra/listing-update-routes.ts`. Find where `insertListingUpdate` is called in the generate handler. The handler already builds `currentFields` from `ascData`. Pass them as `previousFields`:

```typescript
// Find this call:
const updateRow = await insertListingUpdate(sql, {
  tenantId,
  appId,
  auditJobId,
  proposedFields,
  ascLocalizationId: ascData.localizationId,
});

// Change to:
const updateRow = await insertListingUpdate(sql, {
  tenantId,
  appId,
  auditJobId,
  proposedFields,
  ascLocalizationId: ascData.localizationId,
  previousFields: {                          // ADD
    ...(currentFields.keywords != null ? { keywords: currentFields.keywords } : {}),
    ...(currentFields.promotionalText != null ? { promotionalText: currentFields.promotionalText } : {}),
  },
});
```

- [ ] **Step 5: Run tests — verify they pass**

```bash
cd apps/server && npx vitest run src/queue/listing-update-store.test.ts
```

Expected: all tests PASS (including the new `previousFields` test)

- [ ] **Step 6: Run full server test suite**

```bash
cd apps/server && npx vitest run
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/queue/listing-update-store.ts \
        apps/server/src/queue/listing-update-store.test.ts \
        apps/server/src/mastra/listing-update-routes.ts
git commit -m "feat(p8c): store previous_fields on listing update for revert"
```

---

## Task 3: `listing-monitor-checker.ts` + scheduler wiring

**Files:**
- Modify: `apps/server/src/tracking/listing-update-checker.ts`
- Create: `apps/server/src/tracking/listing-monitor-checker.ts`
- Create: `apps/server/src/tracking/listing-monitor-checker.test.ts`
- Modify: `apps/server/src/tracking/scheduler.ts`

**Interfaces:**
- Consumes:
  - `insertListingMonitor`, `getMonitorsInStatus`, `setMonitorBaselineRequest`, `setMonitorBaseline`, `setMonitorAfterRequest`, `setMonitorAlerted`, `setMonitorClosed`, `forceCloseStaleMonitors` from `../queue/listing-monitor-store`
  - `loadCredentials` from `../asc/credential-store`
  - `getAscAnalyticsClient` from `../asc/analytics-client`
  - `insertChangeEvent` from `./store`
- Produces:
  ```ts
  export async function runListingMonitorCheck(sql: postgres.Sql): Promise<void>
  ```

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/tracking/listing-monitor-checker.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

const mockSql = vi.fn().mockResolvedValue([]) as unknown as postgres.Sql;

vi.mock('../queue/listing-monitor-store', () => ({
  getMonitorsInStatus: vi.fn().mockResolvedValue([]),
  setMonitorBaselineRequest: vi.fn(),
  setMonitorBaseline: vi.fn(),
  setMonitorAfterRequest: vi.fn(),
  setMonitorAlerted: vi.fn(),
  setMonitorClosed: vi.fn(),
  forceCloseStaleMonitors: vi.fn(),
}));

vi.mock('../asc/credential-store', () => ({
  loadCredentials: vi.fn(),
}));

const mockCreateRequest = vi.fn();
const mockPollInstance = vi.fn();
vi.mock('../asc/analytics-client', () => ({
  getAscAnalyticsClient: vi.fn(() => ({
    createReportRequest: mockCreateRequest,
    pollReportInstance: mockPollInstance,
  })),
}));

vi.mock('./store', () => ({
  insertChangeEvent: vi.fn(),
}));

const baseMonitor = {
  id: 'lm_1', tenantId: 'tenant1', appId: '123', listingUpdateId: 'lu_1',
  baselineRequestId: null, afterRequestId: null,
  baselineMetrics: null, latestMetrics: null,
  alertFiredAt: null, closedAt: null,
  approvedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), // 3 days ago
  createdAt: new Date(),
};

describe('runListingMonitorCheck', () => {
  beforeEach(() => {
    vi.resetModules();
    mockCreateRequest.mockReset();
    mockPollInstance.mockReset();
  });

  it('does nothing when no monitors in any status', async () => {
    const { getMonitorsInStatus } = await import('../queue/listing-monitor-store');
    vi.mocked(getMonitorsInStatus).mockResolvedValue([]);
    const { runListingMonitorCheck } = await import('./listing-monitor-checker');
    await expect(runListingMonitorCheck(mockSql)).resolves.toBeUndefined();
    expect(mockCreateRequest).not.toHaveBeenCalled();
  });

  it('submits baseline request for pending_baseline monitor past 48h', async () => {
    const { getMonitorsInStatus, setMonitorBaselineRequest } = await import('../queue/listing-monitor-store');
    const { loadCredentials } = await import('../asc/credential-store');
    vi.mocked(getMonitorsInStatus).mockImplementation(async (_, status) =>
      status === 'pending_baseline' ? [{ ...baseMonitor, status: 'pending_baseline' }] : []
    );
    vi.mocked(loadCredentials).mockResolvedValue({ ok: true, value: { keyId: 'K1', issuerId: 'I1', privateKeyPem: '---' } });
    mockCreateRequest.mockResolvedValue({ ok: true, value: 'req_123' });

    const { runListingMonitorCheck } = await import('./listing-monitor-checker');
    await runListingMonitorCheck(mockSql);

    expect(mockCreateRequest).toHaveBeenCalledWith('APP_STORE_ENGAGEMENT', expect.objectContaining({ appId: '123', frequency: 'DAILY' }));
    expect(setMonitorBaselineRequest).toHaveBeenCalledWith(mockSql, 'lm_1', 'req_123');
  });

  it('does not submit baseline for monitor within 48h of approval', async () => {
    const { getMonitorsInStatus } = await import('../queue/listing-monitor-store');
    const recentMonitor = { ...baseMonitor, approvedAt: new Date(Date.now() - 1 * 60 * 60 * 1000) }; // 1 hour ago
    vi.mocked(getMonitorsInStatus).mockImplementation(async (_, status) =>
      status === 'pending_baseline' ? [{ ...recentMonitor, status: 'pending_baseline' }] : []
    );

    const { runListingMonitorCheck } = await import('./listing-monitor-checker');
    await runListingMonitorCheck(mockSql);

    expect(mockCreateRequest).not.toHaveBeenCalled();
  });

  it('stores baseline metrics when poll returns ready', async () => {
    const { getMonitorsInStatus, setMonitorBaseline } = await import('../queue/listing-monitor-store');
    const { loadCredentials } = await import('../asc/credential-store');
    const pollingMonitor = { ...baseMonitor, status: 'polling_baseline', baselineRequestId: 'req_abc' };
    vi.mocked(getMonitorsInStatus).mockImplementation(async (_, status) =>
      status === 'polling_baseline' ? [pollingMonitor] : []
    );
    vi.mocked(loadCredentials).mockResolvedValue({ ok: true, value: { keyId: 'K1', issuerId: 'I1', privateKeyPem: '---' } });
    mockPollInstance.mockResolvedValue({
      ok: true,
      value: {
        status: 'ready',
        rows: [
          { date: '2026-07-01', impressions: 1000, downloads: 200, conversionRate: 0.2, territory: 'US' },
          { date: '2026-07-02', impressions: 1100, downloads: 210, conversionRate: 0.19, territory: 'US' },
        ],
      },
    });

    const { runListingMonitorCheck } = await import('./listing-monitor-checker');
    await runListingMonitorCheck(mockSql);

    expect(setMonitorBaseline).toHaveBeenCalledWith(mockSql, 'lm_1', {
      impressions: 2100,
      downloads: 410,
      conversionRate: expect.closeTo(0.195, 3),
    });
  });

  it('fires alert when threshold is breached', async () => {
    const { getMonitorsInStatus, setMonitorAlerted } = await import('../queue/listing-monitor-store');
    const { loadCredentials } = await import('../asc/credential-store');
    const { insertChangeEvent } = await import('./store');
    const ninedays = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000);
    const monitoringMonitor = {
      ...baseMonitor, status: 'polling_after', afterRequestId: 'req_after',
      approvedAt: ninedays,
      baselineMetrics: { impressions: 1000, downloads: 200, conversionRate: 0.2 },
    };
    vi.mocked(getMonitorsInStatus).mockImplementation(async (_, status) =>
      status === 'polling_after' ? [monitoringMonitor] : []
    );
    vi.mocked(loadCredentials).mockResolvedValue({ ok: true, value: { keyId: 'K1', issuerId: 'I1', privateKeyPem: '---' } });
    mockPollInstance.mockResolvedValue({
      ok: true,
      value: {
        status: 'ready',
        rows: [
          // −20% conversion, −20% impressions, −20% downloads → all thresholds breached
          { date: '2026-07-10', impressions: 800, downloads: 160, conversionRate: 0.16, territory: 'US' },
        ],
      },
    });

    const { runListingMonitorCheck } = await import('./listing-monitor-checker');
    await runListingMonitorCheck(mockSql);

    expect(setMonitorAlerted).toHaveBeenCalled();
    expect(insertChangeEvent).toHaveBeenCalledWith(
      mockSql, 'tenant1',
      expect.objectContaining({ eventType: 'listing_update_alert' }),
    );
  });

  it('closes monitor when threshold is NOT breached', async () => {
    const { getMonitorsInStatus, setMonitorClosed } = await import('../queue/listing-monitor-store');
    const { loadCredentials } = await import('../asc/credential-store');
    const ninedays = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000);
    const pollingAfterMonitor = {
      ...baseMonitor, status: 'polling_after', afterRequestId: 'req_after',
      approvedAt: ninedays,
      baselineMetrics: { impressions: 1000, downloads: 200, conversionRate: 0.2 },
    };
    vi.mocked(getMonitorsInStatus).mockImplementation(async (_, status) =>
      status === 'polling_after' ? [pollingAfterMonitor] : []
    );
    vi.mocked(loadCredentials).mockResolvedValue({ ok: true, value: { keyId: 'K1', issuerId: 'I1', privateKeyPem: '---' } });
    mockPollInstance.mockResolvedValue({
      ok: true,
      value: {
        status: 'ready',
        // Metrics only dropped 5% — below threshold
        rows: [{ date: '2026-07-10', impressions: 950, downloads: 190, conversionRate: 0.19, territory: 'US' }],
      },
    });

    const { runListingMonitorCheck } = await import('./listing-monitor-checker');
    await runListingMonitorCheck(mockSql);

    expect(setMonitorClosed).toHaveBeenCalledWith(mockSql, 'lm_1');
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd apps/server && npx vitest run src/tracking/listing-monitor-checker.test.ts
```

Expected: FAIL — `Cannot find module './listing-monitor-checker'`

- [ ] **Step 3: Modify `listing-update-checker.ts` to insert monitor on approval**

Open `apps/server/src/tracking/listing-update-checker.ts`. Find the section in `checkOneUpdate` where `setListingUpdateStatus` is called with `'approved'`. Add `insertListingMonitor` after the status update:

```typescript
// Add import at the top:
import { insertListingMonitor } from '../queue/listing-monitor-store';

// In checkOneUpdate, after:
await setListingUpdateStatus(sql, update.id, ourStatus, rejectionReason, resolvedAt);

// Add (inside the isTerminal && ourStatus === 'approved' branch):
if (ourStatus === 'approved') {
  try {
    await insertListingMonitor(sql, {
      tenantId: update.tenantId,
      appId: update.appId,
      listingUpdateId: update.id,
      approvedAt: new Date(),
    });
  } catch (e) {
    console.error(`[listing-update-check] failed to insert monitor for ${update.id}:`, e);
  }
}
```

The full relevant block should look like:

```typescript
if (isTerminal) {
  await insertChangeEvent(sql, update.tenantId, {
    appId: update.appId,
    country: 'us',
    eventType: 'listing_update_resolved',
    payload: {
      updateId: update.id,
      status: ourStatus,
      ...(rejectionReason ? { rejectionReason } : {}),
    },
  });

  if (ourStatus === 'approved') {
    try {
      await insertListingMonitor(sql, {
        tenantId: update.tenantId,
        appId: update.appId,
        listingUpdateId: update.id,
        approvedAt: new Date(),
      });
    } catch (e) {
      console.error(`[listing-update-check] failed to insert monitor for ${update.id}:`, e);
    }
  }
}
```

- [ ] **Step 4: Create `apps/server/src/tracking/listing-monitor-checker.ts`**

```typescript
import type postgres from 'postgres';
import {
  getMonitorsInStatus,
  setMonitorBaselineRequest,
  setMonitorBaseline,
  setMonitorAfterRequest,
  setMonitorAlerted,
  setMonitorClosed,
  forceCloseStaleMonitors,
  type ListingMonitor,
  type MonitorMetrics,
} from '../queue/listing-monitor-store';
import { loadCredentials } from '../asc/credential-store';
import { getAscAnalyticsClient } from '../asc/analytics-client';
import type { ReportRow } from '../asc/types';
import { insertChangeEvent } from './store';

const DAY_MS = 24 * 60 * 60 * 1000;
const BASELINE_LAG_MS = 2 * DAY_MS;   // 48h ASC reporting lag
const AFTER_WINDOW_MS = 7 * DAY_MS;   // 7-day post-approval monitoring window
const AFTER_READY_MS = BASELINE_LAG_MS + AFTER_WINDOW_MS; // 9 days total before evaluation

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function aggregateMetrics(rows: ReportRow[]): MonitorMetrics {
  if (rows.length === 0) return { impressions: 0, downloads: 0, conversionRate: 0 };
  return {
    impressions: rows.reduce((sum, r) => sum + r.impressions, 0),
    downloads: rows.reduce((sum, r) => sum + r.downloads, 0),
    conversionRate: rows.reduce((sum, r) => sum + r.conversionRate, 0) / rows.length,
  };
}

function isThresholdBreached(baseline: MonitorMetrics, current: MonitorMetrics): boolean {
  const delta = (pre: number, post: number) => (pre === 0 ? 0 : (post - pre) / pre);
  const convDelta = delta(baseline.conversionRate, current.conversionRate);
  const impDelta = delta(baseline.impressions, current.impressions);
  const dlDelta = delta(baseline.downloads, current.downloads);
  // conversion rate must drop ≥15% AND at least one of impressions/downloads ≥15%
  return convDelta <= -0.15 && (impDelta <= -0.15 || dlDelta <= -0.15);
}

async function loadCredsOrNull(sql: postgres.Sql, tenantId: string) {
  try {
    const res = await loadCredentials(sql, tenantId);
    if (!res.ok || !res.value) return null;
    return res.value;
  } catch {
    return null;
  }
}

// Step 1: pending_baseline → polling_baseline
// Submit baseline report request once 48h lag has cleared
async function stepSubmitBaseline(sql: postgres.Sql): Promise<void> {
  const monitors = await getMonitorsInStatus(sql, 'pending_baseline');
  for (const m of monitors) {
    if (Date.now() - m.approvedAt.getTime() < BASELINE_LAG_MS) continue;
    try {
      const creds = await loadCredsOrNull(sql, m.tenantId);
      if (!creds) continue;
      const client = getAscAnalyticsClient(creds);
      const endDate = toDateStr(m.approvedAt);
      const startDate = toDateStr(new Date(m.approvedAt.getTime() - 7 * DAY_MS));
      const result = await client.createReportRequest('APP_STORE_ENGAGEMENT', {
        appId: m.appId,
        frequency: 'DAILY',
        startDate,
        endDate,
      });
      if (!result.ok) {
        console.error(`[monitor] baseline request failed for ${m.id}:`, result.error);
        continue;
      }
      await setMonitorBaselineRequest(sql, m.id, result.value);
    } catch (e) {
      console.error(`[monitor] stepSubmitBaseline error for ${m.id}:`, e);
    }
  }
}

// Step 2: polling_baseline → monitoring
// Poll until baseline report is ready, then store aggregated metrics
async function stepPollBaseline(sql: postgres.Sql): Promise<void> {
  const monitors = await getMonitorsInStatus(sql, 'polling_baseline');
  for (const m of monitors) {
    if (!m.baselineRequestId) continue;
    try {
      const creds = await loadCredsOrNull(sql, m.tenantId);
      if (!creds) continue;
      const client = getAscAnalyticsClient(creds);
      const result = await client.pollReportInstance(m.baselineRequestId);
      if (!result.ok) {
        console.error(`[monitor] baseline poll failed for ${m.id}:`, result.error);
        continue;
      }
      if (result.value.status === 'ready') {
        const metrics = aggregateMetrics(result.value.rows ?? []);
        await setMonitorBaseline(sql, m.id, metrics);
      }
      // if pending, leave in polling_baseline — retry next hour
    } catch (e) {
      console.error(`[monitor] stepPollBaseline error for ${m.id}:`, e);
    }
  }
}

// Step 3: monitoring → polling_after
// Submit after-period report request once 9 days have elapsed post-approval
async function stepSubmitAfter(sql: postgres.Sql): Promise<void> {
  const monitors = await getMonitorsInStatus(sql, 'monitoring');
  for (const m of monitors) {
    if (Date.now() - m.approvedAt.getTime() < AFTER_READY_MS) continue;
    try {
      const creds = await loadCredsOrNull(sql, m.tenantId);
      if (!creds) continue;
      const client = getAscAnalyticsClient(creds);
      const startDate = toDateStr(m.approvedAt);
      const endDate = toDateStr(new Date(m.approvedAt.getTime() + AFTER_WINDOW_MS));
      const result = await client.createReportRequest('APP_STORE_ENGAGEMENT', {
        appId: m.appId,
        frequency: 'DAILY',
        startDate,
        endDate,
      });
      if (!result.ok) {
        console.error(`[monitor] after request failed for ${m.id}:`, result.error);
        continue;
      }
      await setMonitorAfterRequest(sql, m.id, result.value);
    } catch (e) {
      console.error(`[monitor] stepSubmitAfter error for ${m.id}:`, e);
    }
  }
}

// Step 4: polling_after → alerted / closed
// Poll until after-period report ready, then evaluate threshold
async function stepPollAfterAndEvaluate(sql: postgres.Sql): Promise<void> {
  const monitors = await getMonitorsInStatus(sql, 'polling_after');
  for (const m of monitors) {
    if (!m.afterRequestId || !m.baselineMetrics) continue;
    try {
      const creds = await loadCredsOrNull(sql, m.tenantId);
      if (!creds) continue;
      const client = getAscAnalyticsClient(creds);
      const result = await client.pollReportInstance(m.afterRequestId);
      if (!result.ok) {
        console.error(`[monitor] after poll failed for ${m.id}:`, result.error);
        continue;
      }
      if (result.value.status !== 'ready') continue; // still pending

      const currentMetrics = aggregateMetrics(result.value.rows ?? []);
      const breached = isThresholdBreached(m.baselineMetrics, currentMetrics);

      if (breached) {
        await setMonitorAlerted(sql, m.id, currentMetrics);
        const pre = m.baselineMetrics;
        const post = currentMetrics;
        const delta = (a: number, b: number) => (a === 0 ? 0 : (b - a) / a);
        await insertChangeEvent(sql, m.tenantId, {
          appId: m.appId,
          country: 'us',
          eventType: 'listing_update_alert',
          payload: {
            monitorId: m.id,
            listingUpdateId: m.listingUpdateId,
            baseline: pre,
            current: post,
            deltas: {
              conversionRateDelta: delta(pre.conversionRate, post.conversionRate),
              impressionsDelta: delta(pre.impressions, post.impressions),
              downloadsDelta: delta(pre.downloads, post.downloads),
            },
          },
        });
      } else {
        await setMonitorClosed(sql, m.id);
      }
    } catch (e) {
      console.error(`[monitor] stepPollAfterAndEvaluate error for ${m.id}:`, e);
    }
  }
}

export async function runListingMonitorCheck(sql: postgres.Sql): Promise<void> {
  await forceCloseStaleMonitors(sql);
  await stepSubmitBaseline(sql);
  await stepPollBaseline(sql);
  await stepSubmitAfter(sql);
  await stepPollAfterAndEvaluate(sql);
}
```

- [ ] **Step 5: Run tests — verify they pass**

```bash
cd apps/server && npx vitest run src/tracking/listing-monitor-checker.test.ts
```

Expected: 6 tests PASS

- [ ] **Step 6: Wire into the tracking scheduler**

Open `apps/server/src/tracking/scheduler.ts`. Add the import and call `runListingMonitorCheck` in `tick()` after the existing `runListingUpdateCheck` call:

```typescript
// Add import:
import { runListingMonitorCheck } from './listing-monitor-checker';

// In tick(), after the runListingUpdateCheck block:
try {
  await runListingMonitorCheck(sql);
} catch (e) {
  console.error('[tracking] runListingMonitorCheck failed:', e);
}
```

- [ ] **Step 7: Run full server test suite**

```bash
cd apps/server && npx vitest run
```

Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/tracking/listing-update-checker.ts \
        apps/server/src/tracking/listing-monitor-checker.ts \
        apps/server/src/tracking/listing-monitor-checker.test.ts \
        apps/server/src/tracking/scheduler.ts
git commit -m "feat(p8c): listing-monitor-checker — 4-step ASC analytics polling + threshold evaluation"
```

---

## Task 4: Revert + dismiss routes

**Files:**
- Create: `apps/server/src/mastra/listing-monitor-routes.ts`
- Modify: `apps/server/src/mastra/index.ts`

**Note to implementer:** Read `apps/server/src/mastra/routes.ts` to confirm the exact import path for `registerApiRoute`, `getAuthenticatedTenantId`, and `getPgSql`. Read `apps/server/src/asc/listing-writer.ts` (created in P8-B) to confirm `pushListingUpdate` exists.

**Interfaces:**
- Consumes: `getMonitorById`, `setMonitorClosed` from `../queue/listing-monitor-store`; `getListingUpdateById` from `../queue/listing-update-store`; `loadCredentials` from `../asc/credential-store`; `pushListingUpdate` from `../asc/listing-writer`; `insertChangeEvent` from `../tracking/store`
- Produces: `listingMonitorRoutes` array registered in `index.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/mastra/listing-monitor-routes.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

// Routes are hard to unit-test without the full Hono context.
// Verify the module exports the expected route array.
describe('listing-monitor-routes', () => {
  it('exports listingMonitorRoutes as an array', async () => {
    const { listingMonitorRoutes } = await import('./listing-monitor-routes');
    expect(Array.isArray(listingMonitorRoutes)).toBe(true);
    expect(listingMonitorRoutes.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
cd apps/server && npx vitest run src/mastra/listing-monitor-routes.test.ts
```

Expected: FAIL — `Cannot find module './listing-monitor-routes'`

- [ ] **Step 3: Create `apps/server/src/mastra/listing-monitor-routes.ts`**

```typescript
import { registerApiRoute } from '@mastra/core/server';
import { getAuthenticatedTenantId } from '../auth/middleware';
import { getPgSql } from '../memory';
import { getMonitorById, setMonitorClosed } from '../queue/listing-monitor-store';
import { getListingUpdateById } from '../queue/listing-update-store';
import { loadCredentials } from '../asc/credential-store';
import { pushListingUpdate } from '../asc/listing-writer';
import { insertChangeEvent } from '../tracking/store';

export const listingMonitorRoutes = [
  registerApiRoute('/listing-update/revert', {
    method: 'POST',
    handler: async (c) => {
      const tenantId = await getAuthenticatedTenantId(c);
      if (!tenantId) return c.json({ error: 'Unauthorized' }, 401);
      const sql = getPgSql();
      if (!sql) return c.json({ error: 'Database not configured.' }, 503);

      const body = await c.req.json().catch(() => ({}));
      const monitorId = typeof body?.monitorId === 'string' ? body.monitorId.trim() : '';
      if (!monitorId) return c.json({ error: 'Missing monitorId.' }, 400);

      try {
        const monitor = await getMonitorById(sql, tenantId, monitorId);
        if (!monitor) return c.json({ error: 'Monitor not found.' }, 404);
        if (monitor.status !== 'alerted') return c.json({ error: 'Monitor is not in alerted status.' }, 400);

        const update = await getListingUpdateById(sql, tenantId, monitor.listingUpdateId);
        if (!update) return c.json({ error: 'Listing update not found.' }, 404);
        if (!update.previousFields) return c.json({ error: 'No previous field values stored — cannot revert automatically.' }, 400);
        if (!update.ascLocalizationId) return c.json({ error: 'No ASC localization ID on this update.' }, 400);

        const credsResult = await loadCredentials(sql, tenantId);
        if (!credsResult.ok || !credsResult.value) return c.json({ error: 'ASC credentials not configured.' }, 400);

        const pushResult = await pushListingUpdate(credsResult.value, update.ascLocalizationId, update.previousFields);
        if (!pushResult.ok) return c.json({ error: `ASC revert failed: ${pushResult.error}` }, 502);

        await setMonitorClosed(sql, monitorId);
        await insertChangeEvent(sql, tenantId, {
          appId: monitor.appId,
          country: 'us',
          eventType: 'listing_update_reverted',
          payload: { monitorId, listingUpdateId: monitor.listingUpdateId },
        });

        return c.json({ ok: true });
      } catch (e) {
        console.error('[listing-update/revert] failed:', e);
        return c.json({ error: 'Revert failed.' }, 500);
      }
    },
  }),

  registerApiRoute('/listing-update/dismiss-alert', {
    method: 'POST',
    handler: async (c) => {
      const tenantId = await getAuthenticatedTenantId(c);
      if (!tenantId) return c.json({ error: 'Unauthorized' }, 401);
      const sql = getPgSql();
      if (!sql) return c.json({ error: 'Database not configured.' }, 503);

      const body = await c.req.json().catch(() => ({}));
      const monitorId = typeof body?.monitorId === 'string' ? body.monitorId.trim() : '';
      if (!monitorId) return c.json({ error: 'Missing monitorId.' }, 400);

      try {
        const monitor = await getMonitorById(sql, tenantId, monitorId);
        if (!monitor) return c.json({ error: 'Monitor not found.' }, 404);
        if (monitor.status !== 'alerted') return c.json({ error: 'Monitor is not in alerted status.' }, 400);

        await setMonitorClosed(sql, monitorId);
        return c.json({ ok: true });
      } catch (e) {
        console.error('[listing-update/dismiss-alert] failed:', e);
        return c.json({ error: 'Dismiss failed.' }, 500);
      }
    },
  }),
];
```

- [ ] **Step 4: Register routes in `apps/server/src/mastra/index.ts`**

```typescript
// Add import alongside other route imports:
import { listingMonitorRoutes } from './listing-monitor-routes';

// In the Mastra constructor apiRoutes array, add ...listingMonitorRoutes:
apiRoutes: [...auditRoutes, ...authRoutes, ...healthRoutes, ...ascRoutes, ...trackingRoutes, ...costRoutes, ...listingUpdateRoutes, ...listingMonitorRoutes, ...getWebStaticRoutes()],
```

**Note:** `listingUpdateRoutes` refers to the P8-B routes. If P8-B hasn't registered them yet, add both here.

- [ ] **Step 5: Run tests — verify they pass**

```bash
cd apps/server && npx vitest run src/mastra/listing-monitor-routes.test.ts
```

Expected: 1 test PASS

- [ ] **Step 6: Run full server test suite**

```bash
cd apps/server && npx vitest run
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/mastra/listing-monitor-routes.ts \
        apps/server/src/mastra/listing-monitor-routes.test.ts \
        apps/server/src/mastra/index.ts
git commit -m "feat(p8c): add revert and dismiss-alert routes"
```

---

## Task 5: Frontend — Activity Feed cards + api.ts

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/components/ActivityFeed.tsx`

**Note to implementer:** Read `apps/web/src/lib/api.ts` fully before editing — find the exact fetch wrapper function name (could be `apiFetch`, a plain `fetch` with a base URL constant, etc.) and replicate that pattern. Read `apps/web/src/components/ActivityFeed.tsx` fully to find the `ActivityCard` component and where to add the two new event type branches.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/ActivityFeedStopLoss.test.tsx`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// We'll test the new event cards in isolation by rendering ActivityFeed
// with mocked data. Read ActivityFeed.tsx first to understand how it
// imports fetchActivity — mock that function.

vi.mock('../lib/api', () => ({
  fetchActivity: vi.fn().mockResolvedValue([
    {
      id: 'evt_1',
      createdAt: '2026-07-10T12:00:00Z',
      appName: 'My App',
      eventType: 'listing_update_alert',
      payload: {
        monitorId: 'lm_1',
        listingUpdateId: 'lu_1',
        baseline: { impressions: 1000, downloads: 200, conversionRate: 0.2 },
        current: { impressions: 800, downloads: 160, conversionRate: 0.16 },
        deltas: { conversionRateDelta: -0.2, impressionsDelta: -0.2, downloadsDelta: -0.2 },
      },
    },
  ]),
  revertListingUpdate: vi.fn().mockResolvedValue({ ok: true }),
  dismissListingAlert: vi.fn().mockResolvedValue({ ok: true }),
}));

// Import ActivityFeed after mocking
describe('ActivityFeed — stop-loss cards', () => {
  it('renders listing_update_alert card with metric drops', async () => {
    const { ActivityFeed } = await import('./ActivityFeed');
    render(<ActivityFeed />);
    await waitFor(() => {
      expect(screen.getByText(/conversion rate/i)).toBeTruthy();
    });
  });

  it('shows Revert Listing and Dismiss buttons on alert card', async () => {
    const { ActivityFeed } = await import('./ActivityFeed');
    render(<ActivityFeed />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /revert listing/i })).toBeTruthy();
      expect(screen.getByRole('button', { name: /dismiss/i })).toBeTruthy();
    });
  });

  it('calls revertListingUpdate when Revert button is clicked', async () => {
    const { revertListingUpdate } = await import('../lib/api');
    const { ActivityFeed } = await import('./ActivityFeed');
    render(<ActivityFeed />);
    await waitFor(() => screen.getByRole('button', { name: /revert listing/i }));
    fireEvent.click(screen.getByRole('button', { name: /revert listing/i }));
    await waitFor(() => {
      expect(revertListingUpdate).toHaveBeenCalledWith('lm_1');
    });
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd apps/web && npx vitest run src/components/ActivityFeedStopLoss.test.tsx
```

Expected: FAIL — `revertListingUpdate` not exported from `api.ts`

- [ ] **Step 3: Extend `apps/web/src/lib/api.ts`**

Read the file first. Find the fetch wrapper pattern (likely `apiFetch` or similar). Then add at the end of the file:

```typescript
export async function revertListingUpdate(monitorId: string): Promise<{ ok: boolean }> {
  const res = await apiFetch('/listing-update/revert', {
    method: 'POST',
    body: JSON.stringify({ monitorId }),
  });
  if (!res.ok) throw new Error(`Revert failed: ${res.status}`);
  return res.json() as Promise<{ ok: boolean }>;
}

export async function dismissListingAlert(monitorId: string): Promise<{ ok: boolean }> {
  const res = await apiFetch('/listing-update/dismiss-alert', {
    method: 'POST',
    body: JSON.stringify({ monitorId }),
  });
  if (!res.ok) throw new Error(`Dismiss failed: ${res.status}`);
  return res.json() as Promise<{ ok: boolean }>;
}
```

Also extend `ActivityEvent` type in `api.ts` to include the two new event types. Find the existing `ActivityEvent` type and add:

```typescript
// In the ActivityEvent type union (or the eventType string union), add:
| { eventType: 'listing_update_alert'; payload: {
    monitorId: string;
    listingUpdateId: string;
    baseline: { impressions: number; downloads: number; conversionRate: number };
    current:  { impressions: number; downloads: number; conversionRate: number };
    deltas: { conversionRateDelta: number; impressionsDelta: number; downloadsDelta: number };
  }}
| { eventType: 'listing_update_reverted'; payload: { monitorId: string; listingUpdateId: string } }
```

- [ ] **Step 4: Add event cards to `apps/web/src/components/ActivityFeed.tsx`**

Open `ActivityFeed.tsx`. Find the `ActivityCard` component where `eventType` is branched. Add two new branches — place them before the final fallback/return:

```typescript
// Add these imports at the top of ActivityFeed.tsx:
import { revertListingUpdate, dismissListingAlert } from '../lib/api';

// ── listing_update_alert card ─────────────────────────────────────────────────
if (event.eventType === 'listing_update_alert') {
  const p = event.payload as {
    monitorId: string;
    deltas: { conversionRateDelta: number; impressionsDelta: number; downloadsDelta: number };
  };
  const fmt = (n: number) => `${n >= 0 ? '+' : ''}${Math.round(n * 100)}%`;

  return (
    <AlertCard
      event={event}
      monitorId={p.monitorId}
      summary={`Conversion rate ${fmt(p.deltas.conversionRateDelta)}, downloads ${fmt(p.deltas.downloadsDelta)} in the 7 days after your listing update.`}
    />
  );
}

// ── listing_update_reverted card ──────────────────────────────────────────────
if (event.eventType === 'listing_update_reverted') {
  return (
    <div style={{ padding: '12px 16px', borderLeft: '3px solid #888', marginBottom: 8, background: '#1a1a1a' }}>
      <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>
        {new Date(event.createdAt).toLocaleDateString()} · {event.appName}
      </div>
      <div style={{ fontWeight: 500 }}>↩ Listing reverted to previous values</div>
      <div style={{ fontSize: 13, color: '#aaa', marginTop: 4 }}>
        Consider running a new audit before resubmitting.
      </div>
    </div>
  );
}
```

Add the `AlertCard` sub-component either at the bottom of `ActivityFeed.tsx` or in a new file `AlertCard.tsx` (if the file is large, extract it — otherwise keep it inline):

```typescript
function AlertCard({
  event,
  monitorId,
  summary,
}: {
  event: { createdAt: string; appName: string };
  monitorId: string;
  summary: string;
}) {
  const [phase, setPhase] = React.useState<'idle' | 'working' | 'done'>('idle');
  const [action, setAction] = React.useState<'reverted' | 'dismissed' | null>(null);

  const handleRevert = async () => {
    setPhase('working');
    try {
      await revertListingUpdate(monitorId);
      setAction('reverted');
      setPhase('done');
    } catch {
      setPhase('idle');
    }
  };

  const handleDismiss = async () => {
    setPhase('working');
    try {
      await dismissListingAlert(monitorId);
      setAction('dismissed');
      setPhase('done');
    } catch {
      setPhase('idle');
    }
  };

  if (phase === 'done') {
    return (
      <div style={{ padding: '12px 16px', borderLeft: '3px solid #888', marginBottom: 8, background: '#1a1a1a' }}>
        <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>
          {new Date(event.createdAt).toLocaleDateString()} · {event.appName}
        </div>
        <div style={{ fontSize: 13, color: '#aaa' }}>
          {action === 'reverted' ? '↩ Listing reverted.' : 'Alert dismissed.'}
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '12px 16px', borderLeft: '3px solid #f90', marginBottom: 8, background: '#1a1a1a' }}>
      <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>
        {new Date(event.createdAt).toLocaleDateString()} · {event.appName}
      </div>
      <div style={{ fontWeight: 500, marginBottom: 6 }}>⚠ Your listing update may be hurting performance</div>
      <div style={{ fontSize: 13, color: '#aaa', marginBottom: 10 }}>{summary}</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={handleRevert}
          disabled={phase === 'working'}
          style={{ padding: '6px 14px', cursor: 'pointer' }}
        >
          {phase === 'working' ? '…' : 'Revert Listing'}
        </button>
        <button
          onClick={handleDismiss}
          disabled={phase === 'working'}
          style={{ padding: '6px 14px', cursor: 'pointer', opacity: 0.7 }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run tests — verify they pass**

```bash
cd apps/web && npx vitest run src/components/ActivityFeedStopLoss.test.tsx
```

Expected: 3 tests PASS

- [ ] **Step 6: Run full web test suite**

```bash
cd apps/web && npx vitest run
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/api.ts \
        apps/web/src/components/ActivityFeed.tsx \
        apps/web/src/components/ActivityFeedStopLoss.test.tsx
git commit -m "feat(p8c): Activity Feed stop-loss cards — alert with revert/dismiss, reverted confirmation"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| `aso_listing_monitors` table with 6-state machine | Task 1 |
| `previous_fields` column on `aso_listing_updates` | Task 1 (migration) + Task 2 (wiring) |
| `listing_update_alert` + `listing_update_reverted` ChangeEventType | Task 1 |
| Monitor inserted on approval | Task 3 (listing-update-checker.ts modification) |
| Step 1: submit baseline report request after 48h | Task 3 — `stepSubmitBaseline` |
| Step 2: poll baseline → store metrics → monitoring | Task 3 — `stepPollBaseline` |
| Step 3: submit after-period report at T+9d | Task 3 — `stepSubmitAfter` |
| Step 4: poll after-period → evaluate threshold → alert/close | Task 3 — `stepPollAfterAndEvaluate` |
| Threshold: convRate ≤ −15% AND (impressions OR downloads ≤ −15%) | Task 3 — `isThresholdBreached` |
| Stale monitor force-close (5d pending_baseline, 14d monitoring) | Task 1 `forceCloseStaleMonitors` + Task 3 caller |
| `POST /listing-update/revert` route | Task 4 |
| `POST /listing-update/dismiss-alert` route | Task 4 |
| `listing_update_reverted` change event on revert | Task 4 route handler |
| No previous_fields → clear error on revert | Task 4 route handler |
| Activity Feed `listing_update_alert` card with metric deltas | Task 5 — `AlertCard` |
| Activity Feed Revert Listing + Dismiss buttons | Task 5 — `AlertCard` |
| Activity Feed `listing_update_reverted` confirmation card | Task 5 |
| api.ts `revertListingUpdate` + `dismissListingAlert` | Task 5 |

**Known limitation:** `previous_fields` on `aso_listing_updates` only stores `keywords` and `promotionalText` today (the fields `fetchAscListingData` currently returns). Title, subtitle, and description revert requires extending `fetchAscListingData` — tracked as a follow-on to P8-B.
