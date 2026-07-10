# P7-C: Measurement Windows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a tracked app goes live with a new version, automatically open a 28-day correlational measurement window that captures funnel metrics before and after the change and closes with a verdict surfaced in the activity feed.

**Architecture:** A standalone `measurement/` module reads `aso_change_events` reactively — `go_live` events trigger window creation. An hourly scheduler drives a 5-step state machine (`awaiting_baseline → polling_baseline → awaiting_after → polling_after → closed`) by requesting and polling Apple Analytics Reports. When closed, a `measurement_verdict` change event is emitted and rendered in `ActivityFeed.tsx`.

**Tech Stack:** TypeScript, postgres.js, Vitest (real Postgres), Apple Analytics Reports API via `AscAnalyticsClient`, `setInterval` scheduler (same pattern as P7-B tracking scheduler).

## Global Constraints

- Node ≥ 20.12 — run `nvm use 24` before any command
- postgres.js template literal syntax for all DB queries — no string concatenation
- Tests use real Postgres with unique schema per file (`measurement_*_test_${Date.now()}`); `afterAll` drops schema
- `randomUUID()` from `node:crypto` for window IDs (format: `win_${randomUUID()}`)
- `loadCredentials(sql, tenantId)` returns `Result<AscCredentials | null, AscError>` — check `result.ok && result.value`
- Migrations append-only — only `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` added to `PG_ONLY_MIGRATIONS`
- `measurement/` may import from `tracking/store` (for `insertChangeEvent`) but not vice-versa
- Run all server tests: `nvm use 24 && cd apps/server && pnpm test`

---

## Reference: existing interfaces (already in the codebase)

These already exist — do not redefine them, just import them.

```ts
// apps/server/src/asc/types.ts
export type ReportRow = {
  date: string;
  impressions: number;
  downloads: number;
  conversionRate: number;
  territory: string;
};
export type ReportFilters = { appId: string; frequency: 'DAILY'; startDate: string; endDate: string };
export type ReportPollResult = { status: 'pending' } | { status: 'ready'; rows: ReportRow[] };
export type AscError = /* discriminated union incl. { kind: 'auth_failed'; status } etc. */;

// apps/server/src/asc/credential-store.ts
export interface AscCredentials { keyId: string; issuerId: string; privateKeyPem: string }
export function loadCredentials(sql, tenantId): Promise<Result<AscCredentials | null, AscError>>;

// apps/server/src/asc/analytics-client.ts
export interface AscAnalyticsClient {
  createReportRequest(type: 'APP_STORE_ENGAGEMENT', filters: ReportFilters): Promise<Result<string, AscError>>;
  pollReportInstance(requestId: string): Promise<Result<ReportPollResult, AscError>>;
}
export function getAscAnalyticsClient(creds: AscCredentials): AscAnalyticsClient;

// apps/server/src/domain/result.ts
export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };

// apps/server/src/tracking/store.ts
export function insertChangeEvent(
  sql, tenantId,
  event: { appId: string; country: string; eventType: ChangeEventType; payload: Record<string, unknown> },
): Promise<void>;

// aso_change_events columns: id, tenant_id, app_id, country, event_type, payload_json, created_at
// go_live payload_json shape: { versionString: string; appId: string; auditJobId: string | null }
// aso_recommendations columns (relevant): tenant_id, app_id, country, rec_key, status, applied_at (TEXT ISO-8601)
```

Test DB URL (every test file): `const TEST_URL = process.env.DATABASE_TEST_URL ?? 'postgresql://aso:aso@localhost:5432/aso_audit_test';`

---

## Task 1: Types + DB migration

**Files:**
- Create: `apps/server/src/measurement/types.ts`
- Modify: `apps/server/src/memory/pg-migrate.ts` (append to `PG_ONLY_MIGRATIONS`)

**Interfaces:**
- Produces: `WindowState`, `MeasurementWindow`, `VerdictMetrics`, `VerdictJson` (used by every later task); `aso_measurement_windows` table.

No standalone test — TypeScript compile confirms types; migration is exercised in Task 2.

- [ ] **Step 1: Create `apps/server/src/measurement/types.ts`**

```ts
import type { ReportRow } from '../asc/types';

export type WindowState =
  | 'awaiting_baseline'
  | 'polling_baseline'
  | 'awaiting_after'
  | 'polling_after'
  | 'closed'
  | 'error';

export type MeasurementWindow = {
  id: string;
  tenantId: string;
  appId: string;
  country: string;
  versionString: string;
  recKeys: string[];
  mixedAuthorship: boolean;
  openedAt: string; // ISO-8601
  regime: 'correlational';
  state: WindowState;
  baselineRequestId: string | null;
  afterRequestId: string | null;
  baselineJson: ReportRow[] | null;
  afterJson: ReportRow[] | null;
  verdictJson: VerdictJson | null;
  errorMessage: string | null;
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
};

export type VerdictMetrics = {
  before: number;
  after: number;
  deltaPercent: number;
};

export type VerdictJson = {
  regime: 'correlational';
  windowDays: 28;
  metrics: {
    impressions: VerdictMetrics;
    downloads: VerdictMetrics;
    conversionRate: VerdictMetrics;
  };
  mixedAuthorship: boolean;
  disclaimer: string;
};
```

- [ ] **Step 2: Append the migration to `PG_ONLY_MIGRATIONS`**

In `apps/server/src/memory/pg-migrate.ts`, add these two entries at the **end** of the `PG_ONLY_MIGRATIONS` array (after the `aso_change_events_tenant_created` index, before the closing `];`):

```ts
  // Phase P7-C: per-version measurement window state machine
  `CREATE TABLE IF NOT EXISTS aso_measurement_windows (
    id                  TEXT PRIMARY KEY,
    tenant_id           TEXT NOT NULL,
    app_id              TEXT NOT NULL,
    country             TEXT NOT NULL DEFAULT 'us',
    version_string      TEXT NOT NULL,
    rec_keys_json       TEXT NOT NULL DEFAULT '[]',
    mixed_authorship    BOOLEAN NOT NULL DEFAULT FALSE,
    opened_at           TIMESTAMPTZ NOT NULL,
    regime              TEXT NOT NULL DEFAULT 'correlational',
    state               TEXT NOT NULL,
    baseline_request_id TEXT,
    after_request_id    TEXT,
    baseline_json       TEXT,
    after_json          TEXT,
    verdict_json        TEXT,
    error_message       TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS aso_measurement_windows_tenant_state
    ON aso_measurement_windows (tenant_id, state, updated_at DESC)`,
```

Note: the existing array entries are individual SQL statement strings (no trailing semicolons inside the string, comma-separated array elements). Match that style exactly — do NOT put `;` at the end of the SQL.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `nvm use 24 && cd apps/server && pnpm tsc --noEmit`
Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/measurement/types.ts apps/server/src/memory/pg-migrate.ts
git commit -m "feat(p7c): measurement window types and DB migration"
```

---

## Task 2: Store

**Files:**
- Create: `apps/server/src/measurement/store.ts`
- Test: `apps/server/src/measurement/store.test.ts`

**Interfaces:**
- Consumes: `MeasurementWindow`, `WindowState`, `VerdictJson` (Task 1); `ReportRow` (asc/types).
- Produces:
  - `openWindow(sql, tenantId, { appId, country, versionString, openedAt: Date, recKeys: string[], mixedAuthorship: boolean }): Promise<MeasurementWindow | null>` — returns `null` if a window already exists for `(tenantId, appId, country, versionString)`.
  - `getWindowsInState(sql, state: WindowState): Promise<MeasurementWindow[]>` — all tenants, `ORDER BY updated_at ASC`.
  - `updateWindowState(sql, id: string, state: WindowState, updates?: { baselineRequestId?; afterRequestId?; baselineJson?: ReportRow[]; afterJson?: ReportRow[]; verdictJson?: VerdictJson; errorMessage?: string }): Promise<void>`.

- [ ] **Step 1: Write the failing test — `apps/server/src/measurement/store.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { runPgMigrations } from '../memory/pg-migrate';
import { openWindow, getWindowsInState, updateWindowState } from './store';

const TEST_URL = process.env.DATABASE_TEST_URL ?? 'postgresql://aso:aso@localhost:5432/aso_audit_test';

describe('measurement store', () => {
  const schema = `measurement_store_test_${Date.now()}`;
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

  it('openWindow creates a row in awaiting_baseline state', async () => {
    const w = await openWindow(sql, 'tenantA', {
      appId: 'APP1', country: 'us', versionString: '1.0.0',
      openedAt: new Date('2026-06-01T00:00:00Z'), recKeys: ['k1'], mixedAuthorship: false,
    });
    expect(w).not.toBeNull();
    expect(w!.state).toBe('awaiting_baseline');
    expect(w!.id.startsWith('win_')).toBe(true);
    expect(w!.recKeys).toEqual(['k1']);
    expect(w!.regime).toBe('correlational');
    expect(w!.baselineRequestId).toBeNull();
  });

  it('openWindow returns null and does not create second window for duplicate (tenantId, appId, country, versionString)', async () => {
    const first = await openWindow(sql, 'tenantB', {
      appId: 'APP2', country: 'us', versionString: '2.0.0',
      openedAt: new Date('2026-06-01T00:00:00Z'), recKeys: [], mixedAuthorship: false,
    });
    expect(first).not.toBeNull();

    const dup = await openWindow(sql, 'tenantB', {
      appId: 'APP2', country: 'us', versionString: '2.0.0',
      openedAt: new Date('2026-06-02T00:00:00Z'), recKeys: ['x'], mixedAuthorship: true,
    });
    expect(dup).toBeNull();

    const rows = await sql`
      SELECT id FROM aso_measurement_windows
      WHERE tenant_id = 'tenantB' AND app_id = 'APP2' AND country = 'us' AND version_string = '2.0.0'
    `;
    expect(rows).toHaveLength(1);
  });

  it('getWindowsInState returns only windows matching the given state', async () => {
    await openWindow(sql, 'tenantC', {
      appId: 'APP3', country: 'us', versionString: '3.0.0',
      openedAt: new Date('2026-06-01T00:00:00Z'), recKeys: [], mixedAuthorship: false,
    });
    const awaiting = await getWindowsInState(sql, 'awaiting_baseline');
    const c = awaiting.find((w) => w.tenantId === 'tenantC');
    expect(c).toBeDefined();

    const polling = await getWindowsInState(sql, 'polling_after');
    expect(polling.find((w) => w.tenantId === 'tenantC')).toBeUndefined();
  });

  it('updateWindowState advances state and persists provided updates (baselineRequestId stored, unprovided fields unchanged)', async () => {
    const w = await openWindow(sql, 'tenantD', {
      appId: 'APP4', country: 'us', versionString: '4.0.0',
      openedAt: new Date('2026-06-01T00:00:00Z'), recKeys: ['k4'], mixedAuthorship: true,
    });
    expect(w).not.toBeNull();

    await updateWindowState(sql, w!.id, 'polling_baseline', { baselineRequestId: 'req-123' });

    const polling = await getWindowsInState(sql, 'polling_baseline');
    const found = polling.find((x) => x.id === w!.id);
    expect(found).toBeDefined();
    expect(found!.state).toBe('polling_baseline');
    expect(found!.baselineRequestId).toBe('req-123');
    // unprovided fields unchanged
    expect(found!.recKeys).toEqual(['k4']);
    expect(found!.mixedAuthorship).toBe(true);
    expect(found!.afterRequestId).toBeNull();

    // A second update that provides only afterRequestId must not wipe baselineRequestId
    await updateWindowState(sql, w!.id, 'polling_after', { afterRequestId: 'req-after' });
    const after = await getWindowsInState(sql, 'polling_after');
    const found2 = after.find((x) => x.id === w!.id);
    expect(found2!.baselineRequestId).toBe('req-123');
    expect(found2!.afterRequestId).toBe('req-after');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nvm use 24 && cd apps/server && pnpm test measurement/store.test.ts`
Expected: FAIL — `Cannot find module './store'` (file does not exist yet).

- [ ] **Step 3: Write minimal implementation — `apps/server/src/measurement/store.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { ReportRow } from '../asc/types';
import type { MeasurementWindow, WindowState, VerdictJson } from './types';

interface WindowRow {
  id: string;
  tenant_id: string;
  app_id: string;
  country: string;
  version_string: string;
  rec_keys_json: string;
  mixed_authorship: boolean;
  opened_at: Date;
  regime: string;
  state: string;
  baseline_request_id: string | null;
  after_request_id: string | null;
  baseline_json: string | null;
  after_json: string | null;
  verdict_json: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

function rowToWindow(r: WindowRow): MeasurementWindow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    appId: r.app_id,
    country: r.country,
    versionString: r.version_string,
    recKeys: JSON.parse(r.rec_keys_json) as string[],
    mixedAuthorship: r.mixed_authorship,
    openedAt: r.opened_at.toISOString(),
    regime: 'correlational',
    state: r.state as WindowState,
    baselineRequestId: r.baseline_request_id,
    afterRequestId: r.after_request_id,
    baselineJson: r.baseline_json ? (JSON.parse(r.baseline_json) as ReportRow[]) : null,
    afterJson: r.after_json ? (JSON.parse(r.after_json) as ReportRow[]) : null,
    verdictJson: r.verdict_json ? (JSON.parse(r.verdict_json) as VerdictJson) : null,
    errorMessage: r.error_message,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

const SELECT_COLS = `id, tenant_id, app_id, country, version_string, rec_keys_json,
  mixed_authorship, opened_at, regime, state, baseline_request_id, after_request_id,
  baseline_json, after_json, verdict_json, error_message, created_at, updated_at`;

export async function openWindow(
  sql: postgres.Sql,
  tenantId: string,
  params: {
    appId: string;
    country: string;
    versionString: string;
    openedAt: Date;
    recKeys: string[];
    mixedAuthorship: boolean;
  },
): Promise<MeasurementWindow | null> {
  const existing = await sql<WindowRow[]>`
    SELECT ${sql.unsafe(SELECT_COLS)}
    FROM aso_measurement_windows
    WHERE tenant_id = ${tenantId}
      AND app_id = ${params.appId}
      AND country = ${params.country}
      AND version_string = ${params.versionString}
  `;
  if (existing.length > 0) return null;

  const id = `win_${randomUUID()}`;
  const rows = await sql<WindowRow[]>`
    INSERT INTO aso_measurement_windows
      (id, tenant_id, app_id, country, version_string, rec_keys_json,
       mixed_authorship, opened_at, regime, state)
    VALUES (
      ${id}, ${tenantId}, ${params.appId}, ${params.country}, ${params.versionString},
      ${JSON.stringify(params.recKeys)}, ${params.mixedAuthorship},
      ${params.openedAt.toISOString()}, 'correlational', 'awaiting_baseline'
    )
    RETURNING ${sql.unsafe(SELECT_COLS)}
  `;
  return rowToWindow(rows[0]);
}

export async function getWindowsInState(
  sql: postgres.Sql,
  state: WindowState,
): Promise<MeasurementWindow[]> {
  const rows = await sql<WindowRow[]>`
    SELECT ${sql.unsafe(SELECT_COLS)}
    FROM aso_measurement_windows
    WHERE state = ${state}
    ORDER BY updated_at ASC
  `;
  return rows.map(rowToWindow);
}

export async function updateWindowState(
  sql: postgres.Sql,
  id: string,
  state: WindowState,
  updates: {
    baselineRequestId?: string;
    afterRequestId?: string;
    baselineJson?: ReportRow[];
    afterJson?: ReportRow[];
    verdictJson?: VerdictJson;
    errorMessage?: string;
  } = {},
): Promise<void> {
  const baselineReq = updates.baselineRequestId ?? null;
  const afterReq = updates.afterRequestId ?? null;
  const baselineJson = updates.baselineJson ? JSON.stringify(updates.baselineJson) : null;
  const afterJson = updates.afterJson ? JSON.stringify(updates.afterJson) : null;
  const verdictJson = updates.verdictJson ? JSON.stringify(updates.verdictJson) : null;
  const errorMessage = updates.errorMessage ?? null;

  await sql`
    UPDATE aso_measurement_windows
    SET state               = ${state},
        baseline_request_id = COALESCE(${baselineReq}, baseline_request_id),
        after_request_id    = COALESCE(${afterReq}, after_request_id),
        baseline_json       = COALESCE(${baselineJson}, baseline_json),
        after_json          = COALESCE(${afterJson}, after_json),
        verdict_json        = COALESCE(${verdictJson}, verdict_json),
        error_message       = COALESCE(${errorMessage}, error_message),
        updated_at          = NOW()
    WHERE id = ${id}
  `;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `nvm use 24 && cd apps/server && pnpm test measurement/store.test.ts`
Expected: PASS — 4 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/measurement/store.ts apps/server/src/measurement/store.test.ts
git commit -m "feat(p7c): measurement window store"
```

---

## Task 3: Verdict

**Files:**
- Create: `apps/server/src/measurement/verdict.ts`
- Test: `apps/server/src/measurement/verdict.test.ts`

**Interfaces:**
- Consumes: `ReportRow` (asc/types); `VerdictJson`, `VerdictMetrics` (Task 1).
- Produces: `computeVerdict(baseline: ReportRow[], after: ReportRow[], mixedAuthorship?: boolean): VerdictJson`.

- [ ] **Step 1: Write the failing test — `apps/server/src/measurement/verdict.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { computeVerdict } from './verdict';
import type { ReportRow } from '../asc/types';

function row(over: Partial<ReportRow>): ReportRow {
  return { date: '2026-06-01', impressions: 0, downloads: 0, conversionRate: 0, territory: 'US', ...over };
}

describe('computeVerdict', () => {
  it('computes deltaPercent correctly for all three metrics', () => {
    const baseline = [
      row({ impressions: 100, downloads: 10, conversionRate: 5 }),
      row({ impressions: 100, downloads: 10, conversionRate: 5 }),
    ];
    const after = [
      row({ impressions: 150, downloads: 12, conversionRate: 6 }),
      row({ impressions: 150, downloads: 12, conversionRate: 6 }),
    ];
    const v = computeVerdict(baseline, after);

    // impressions: before 200, after 300 → +50%
    expect(v.metrics.impressions.before).toBe(200);
    expect(v.metrics.impressions.after).toBe(300);
    expect(v.metrics.impressions.deltaPercent).toBeCloseTo(50, 5);

    // downloads: before 20, after 24 → +20%
    expect(v.metrics.downloads.before).toBe(20);
    expect(v.metrics.downloads.after).toBe(24);
    expect(v.metrics.downloads.deltaPercent).toBeCloseTo(20, 5);

    // conversionRate: avg before 5, avg after 6 → +20%
    expect(v.metrics.conversionRate.before).toBeCloseTo(5, 5);
    expect(v.metrics.conversionRate.after).toBeCloseTo(6, 5);
    expect(v.metrics.conversionRate.deltaPercent).toBeCloseTo(20, 5);

    expect(v.windowDays).toBe(28);
    expect(v.regime).toBe('correlational');
  });

  it('returns deltaPercent: 0 for all metrics when baseline is empty (zero-baseline guard)', () => {
    const after = [row({ impressions: 150, downloads: 12, conversionRate: 6 })];
    const v = computeVerdict([], after);
    expect(v.metrics.impressions.before).toBe(0);
    expect(v.metrics.impressions.deltaPercent).toBe(0);
    expect(v.metrics.downloads.deltaPercent).toBe(0);
    expect(v.metrics.conversionRate.deltaPercent).toBe(0);
  });

  it('mixedAuthorship flag defaults to false and passes through when true', () => {
    expect(computeVerdict([], []).mixedAuthorship).toBe(false);
    expect(computeVerdict([], [], true).mixedAuthorship).toBe(true);
  });

  it('disclaimer text matches spec exactly', () => {
    const v = computeVerdict([], []);
    expect(v.disclaimer).toBe(
      'Directional only — not causal. Metadata reindex ~4 weeks; competitor and algorithm shifts are not controlled for.',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nvm use 24 && cd apps/server && pnpm test measurement/verdict.test.ts`
Expected: FAIL — `Cannot find module './verdict'`.

- [ ] **Step 3: Write minimal implementation — `apps/server/src/measurement/verdict.ts`**

```ts
import type { ReportRow } from '../asc/types';
import type { VerdictJson, VerdictMetrics } from './types';

const DISCLAIMER =
  'Directional only — not causal. Metadata reindex ~4 weeks; competitor and algorithm shifts are not controlled for.';

function sum(rows: ReportRow[], pick: (r: ReportRow) => number): number {
  return rows.reduce((acc, r) => acc + pick(r), 0);
}

function avg(rows: ReportRow[], pick: (r: ReportRow) => number): number {
  if (rows.length === 0) return 0;
  return sum(rows, pick) / rows.length;
}

function metric(before: number, after: number): VerdictMetrics {
  const deltaPercent = before === 0 ? 0 : ((after - before) / before) * 100;
  return { before, after, deltaPercent };
}

export function computeVerdict(
  baseline: ReportRow[],
  after: ReportRow[],
  mixedAuthorship = false,
): VerdictJson {
  return {
    regime: 'correlational',
    windowDays: 28,
    metrics: {
      impressions: metric(
        sum(baseline, (r) => r.impressions),
        sum(after, (r) => r.impressions),
      ),
      downloads: metric(
        sum(baseline, (r) => r.downloads),
        sum(after, (r) => r.downloads),
      ),
      conversionRate: metric(
        avg(baseline, (r) => r.conversionRate),
        avg(after, (r) => r.conversionRate),
      ),
    },
    mixedAuthorship,
    disclaimer: DISCLAIMER,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `nvm use 24 && cd apps/server && pnpm test measurement/verdict.test.ts`
Expected: PASS — 4 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/measurement/verdict.ts apps/server/src/measurement/verdict.test.ts
git commit -m "feat(p7c): computeVerdict pure function"
```

---

## Task 4: Reporter

**Files:**
- Modify: `apps/server/src/asc/analytics-client.ts` (add `startTime`/`endTime` to POST body)
- Create: `apps/server/src/measurement/reporter.ts`
- Test: `apps/server/src/measurement/reporter.test.ts`

**Interfaces:**
- Consumes: `AscCredentials` (credential-store), `ReportRow` (asc/types), `getAscAnalyticsClient` (analytics-client).
- Produces:
  - `requestReport(creds: AscCredentials, appId: string, country: string, startDate: string, endDate: string): Promise<string>` — returns requestId; throws on error.
  - `pollReport(creds: AscCredentials, requestId: string): Promise<{ status: 'pending' } | { status: 'ready'; rows: ReportRow[] }>` — throws on error.

- [ ] **Step 1: Modify `analytics-client.ts` — add date range to POST body**

In `apps/server/src/asc/analytics-client.ts`, inside `createReportRequest`, replace the `attributes` object in the request body:

Find:
```ts
            attributes: {
              accessType: 'ONE_TIME_SNAPSHOT',
            },
```

Replace with:
```ts
            attributes: {
              accessType: 'ONE_TIME_SNAPSHOT',
              ...(filters.startDate ? { startTime: `${filters.startDate}T00:00:00Z` } : {}),
              ...(filters.endDate ? { endTime: `${filters.endDate}T00:00:00Z` } : {}),
            },
```

This is backward-compatible — existing callers without date fields are unaffected.

- [ ] **Step 2: Write the failing test — `apps/server/src/measurement/reporter.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AscCredentials } from '../asc/credential-store';
import type { ReportRow } from '../asc/types';

const mockCreateReportRequest = vi.fn();
const mockPollReportInstance = vi.fn();

vi.mock('../asc/analytics-client', () => ({
  getAscAnalyticsClient: () => ({
    createReportRequest: (...args: any[]) => mockCreateReportRequest(...args),
    pollReportInstance: (...args: any[]) => mockPollReportInstance(...args),
  }),
}));

import { requestReport, pollReport } from './reporter';

const creds: AscCredentials = { keyId: 'k', issuerId: 'i', privateKeyPem: 'pem' };

describe('reporter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requestReport calls createReportRequest with correct appId, frequency, startDate, endDate', async () => {
    mockCreateReportRequest.mockResolvedValueOnce({ ok: true, value: 'req-1' });
    await requestReport(creds, 'APP1', 'us', '2026-05-04', '2026-06-01');
    expect(mockCreateReportRequest).toHaveBeenCalledWith('APP_STORE_ENGAGEMENT', {
      appId: 'APP1',
      frequency: 'DAILY',
      startDate: '2026-05-04',
      endDate: '2026-06-01',
    });
  });

  it('requestReport returns the requestId string on success', async () => {
    mockCreateReportRequest.mockResolvedValueOnce({ ok: true, value: 'req-42' });
    const id = await requestReport(creds, 'APP1', 'us', '2026-05-04', '2026-06-01');
    expect(id).toBe('req-42');
  });

  it('requestReport throws when the client returns an error', async () => {
    mockCreateReportRequest.mockResolvedValueOnce({ ok: false, error: { kind: 'auth_failed', status: 401 } });
    await expect(requestReport(creds, 'APP1', 'us', '2026-05-04', '2026-06-01')).rejects.toThrow();
  });

  it('pollReport returns { status: "pending" } when client returns pending', async () => {
    mockPollReportInstance.mockResolvedValueOnce({ ok: true, value: { status: 'pending' } });
    const res = await pollReport(creds, 'req-1');
    expect(res).toEqual({ status: 'pending' });
  });

  it('pollReport returns { status: "ready", rows } and passes rows through when client returns ready', async () => {
    const rows: ReportRow[] = [
      { date: '2026-06-01', impressions: 10, downloads: 2, conversionRate: 20, territory: 'US' },
    ];
    mockPollReportInstance.mockResolvedValueOnce({ ok: true, value: { status: 'ready', rows } });
    const res = await pollReport(creds, 'req-1');
    expect(res).toEqual({ status: 'ready', rows });
  });

  it('pollReport throws when the client returns an error', async () => {
    mockPollReportInstance.mockResolvedValueOnce({ ok: false, error: { kind: 'no_credentials', tenantId: 't' } });
    await expect(pollReport(creds, 'req-1')).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `nvm use 24 && cd apps/server && pnpm test measurement/reporter.test.ts`
Expected: FAIL — `Cannot find module './reporter'`.

- [ ] **Step 4: Write minimal implementation — `apps/server/src/measurement/reporter.ts`**

```ts
import { getAscAnalyticsClient } from '../asc/analytics-client';
import type { AscCredentials } from '../asc/credential-store';
import type { ReportRow } from '../asc/types';

export async function requestReport(
  creds: AscCredentials,
  appId: string,
  _country: string,
  startDate: string,
  endDate: string,
): Promise<string> {
  const result = await getAscAnalyticsClient(creds).createReportRequest('APP_STORE_ENGAGEMENT', {
    appId,
    frequency: 'DAILY',
    startDate,
    endDate,
  });
  if (!result.ok) {
    throw new Error(`createReportRequest failed: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

export async function pollReport(
  creds: AscCredentials,
  requestId: string,
): Promise<{ status: 'pending' } | { status: 'ready'; rows: ReportRow[] }> {
  const result = await getAscAnalyticsClient(creds).pollReportInstance(requestId);
  if (!result.ok) {
    throw new Error(`pollReportInstance failed: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}
```

Note: `country` is part of the spec'd signature (reserved for future storefront filtering) but the Analytics Reports API request is app-scoped, so it is accepted and intentionally unused (`_country`).

- [ ] **Step 5: Run test to verify it passes**

Run: `nvm use 24 && cd apps/server && pnpm test measurement/reporter.test.ts`
Expected: PASS — 6 passed.

- [ ] **Step 6: Verify the analytics-client change compiles and its existing tests still pass**

Run: `nvm use 24 && cd apps/server && pnpm tsc --noEmit && pnpm test asc/`
Expected: zero TS errors; all existing asc tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/asc/analytics-client.ts apps/server/src/measurement/reporter.ts apps/server/src/measurement/reporter.test.ts
git commit -m "feat(p7c): reporter wrapping AscAnalyticsClient; add date range to createReportRequest"
```

---

## Task 5: Scheduler + server types + wire-up

**Files:**
- Modify: `apps/server/src/tracking/types.ts` (add `measurement_verdict`)
- Create: `apps/server/src/measurement/scheduler.ts`
- Test: `apps/server/src/measurement/scheduler.test.ts`
- Modify: `apps/server/src/mastra/index.ts` (start measurer, update `registerShutdown`)

**Interfaces:**
- Consumes: `openWindow`, `getWindowsInState`, `updateWindowState` (Task 2); `computeVerdict` (Task 3); `requestReport`, `pollReport` (Task 4); `loadCredentials` (credential-store); `insertChangeEvent` (tracking/store); `MeasurementWindow` (Task 1).
- Produces: `SchedulerHandle { stop: () => void }`; `startMeasurementScheduler(mastra: Mastra, sql: postgres.Sql): SchedulerHandle`.

- [ ] **Step 1: Modify `apps/server/src/tracking/types.ts`**

Change the `ChangeEventType` line (line 1):
```ts
export type ChangeEventType = 'go_live' | 'metadata_changed' | 'reviews_shifted' | 'version_status' | 'measurement_verdict';
```

Change `ActivityEvent.eventType` (the `eventType:` field inside `ActivityEvent`):
```ts
  eventType: 'go_live' | 'metadata_changed' | 'reviews_shifted' | 'measurement_verdict';
```

- [ ] **Step 2: Write the failing test — `apps/server/src/measurement/scheduler.test.ts`**

```ts
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import { runPgMigrations } from '../memory/pg-migrate';

const mockLoadCredentials = vi.fn();
const mockRequestReport = vi.fn();
const mockPollReport = vi.fn();

vi.mock('../asc/credential-store', () => ({
  loadCredentials: (...args: any[]) => mockLoadCredentials(...args),
}));
vi.mock('./reporter', () => ({
  requestReport: (...args: any[]) => mockRequestReport(...args),
  pollReport: (...args: any[]) => mockPollReport(...args),
}));

import { startMeasurementScheduler } from './scheduler';
import { getWindowsInState } from './store';

const TEST_URL = process.env.DATABASE_TEST_URL ?? 'postgresql://aso:aso@localhost:5432/aso_audit_test';
const fakeMastra = {} as any;

const CREDS = { ok: true, value: { keyId: 'k', issuerId: 'i', privateKeyPem: 'p' } };

async function insertGoLive(
  sql: postgres.Sql,
  tenantId: string,
  appId: string,
  versionString: string,
) {
  await sql`
    INSERT INTO aso_change_events (id, tenant_id, app_id, country, event_type, payload_json, created_at)
    VALUES (${`evt-${tenantId}-${appId}-${versionString}`}, ${tenantId}, ${appId}, 'us', 'go_live',
      ${JSON.stringify({ versionString, appId, auditJobId: null })}, NOW())
  `;
}

// Runs one tick manually by starting + immediately awaiting the first pass, then stopping.
async function runOneTick(sql: postgres.Sql) {
  const handle = startMeasurementScheduler(fakeMastra, sql);
  // Flush the immediate first pass (5 sequential awaited steps + their queries).
  for (let i = 0; i < 50; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 50));
  handle.stop();
}

describe('startMeasurementScheduler', () => {
  const schema = `measurement_sched_test_${Date.now()}`;
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

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadCredentials.mockResolvedValue(CREDS);
  });

  it('step 1 opens a window for an unprocessed go_live event', async () => {
    await insertGoLive(sql, 'T1', 'APP1', '1.0.0');
    // Prevent later steps from touching the new window in the same tick by making requestReport a no-op error-free stub.
    mockRequestReport.mockResolvedValue('req-x');
    mockPollReport.mockResolvedValue({ status: 'pending' });

    await runOneTick(sql);

    const rows = await sql`
      SELECT * FROM aso_measurement_windows WHERE tenant_id = 'T1' AND app_id = 'APP1' AND version_string = '1.0.0'
    `;
    expect(rows).toHaveLength(1);
  });

  it('step 1 skips a go_live event that already has a window (duplicate guard)', async () => {
    await insertGoLive(sql, 'T2', 'APP2', '2.0.0');
    mockRequestReport.mockResolvedValue('req-x');
    mockPollReport.mockResolvedValue({ status: 'pending' });

    await runOneTick(sql); // opens
    await runOneTick(sql); // must not open a second

    const rows = await sql`
      SELECT id FROM aso_measurement_windows WHERE tenant_id = 'T2' AND app_id = 'APP2' AND version_string = '2.0.0'
    `;
    expect(rows).toHaveLength(1);
  });

  it('step 1 skips if loadCredentials returns null', async () => {
    mockLoadCredentials.mockResolvedValue({ ok: true, value: null });
    await insertGoLive(sql, 'T3', 'APP3', '3.0.0');
    mockRequestReport.mockResolvedValue('req-x');
    mockPollReport.mockResolvedValue({ status: 'pending' });

    await runOneTick(sql);

    const rows = await sql`
      SELECT id FROM aso_measurement_windows WHERE tenant_id = 'T3' AND app_id = 'APP3'
    `;
    expect(rows).toHaveLength(0);
  });

  it('a failure in step 1 does not prevent step 2 from running', async () => {
    // Pre-seed an awaiting_baseline window directly (step 2 input) for a DIFFERENT tenant.
    await sql`
      INSERT INTO aso_measurement_windows
        (id, tenant_id, app_id, country, version_string, rec_keys_json, mixed_authorship, opened_at, regime, state)
      VALUES ('win_step2', 'T4', 'APP4', 'us', '4.0.0', '[]', FALSE, ${new Date('2026-06-01T00:00:00Z').toISOString()}, 'correlational', 'awaiting_baseline')
    `;
    // Make step 1 throw by having loadCredentials reject; insert a go_live so step 1 reaches loadCredentials.
    await insertGoLive(sql, 'T4', 'APP-FAIL', '9.9.9');
    mockLoadCredentials.mockRejectedValue(new Error('boom'));
    mockRequestReport.mockResolvedValue('req-step2');
    mockPollReport.mockResolvedValue({ status: 'pending' });

    await runOneTick(sql);

    // step 2 should have advanced win_step2 to polling_baseline despite step 1 failing
    const rows = await sql`SELECT state, baseline_request_id FROM aso_measurement_windows WHERE id = 'win_step2'`;
    expect(rows[0].state).toBe('polling_baseline');
    expect(rows[0].baseline_request_id).toBe('req-step2');
  });

  it('full state machine: awaiting_baseline → polling_baseline → awaiting_after → polling_after → closed', async () => {
    const readyRows = [{ date: '2026-06-01', impressions: 100, downloads: 10, conversionRate: 5, territory: 'US' }];
    // opened_at is > 30 days ago so step 4 fires.
    const openedAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    await sql`
      INSERT INTO aso_measurement_windows
        (id, tenant_id, app_id, country, version_string, rec_keys_json, mixed_authorship, opened_at, regime, state)
      VALUES ('win_fsm', 'T5', 'APP5', 'us', '5.0.0', '[]', FALSE, ${openedAt}, 'correlational', 'awaiting_baseline')
    `;

    // Tick A: step 2 submits baseline → polling_baseline
    mockRequestReport.mockResolvedValue('req-base');
    mockPollReport.mockResolvedValue({ status: 'pending' });
    await runOneTick(sql);
    let r = await sql`SELECT state FROM aso_measurement_windows WHERE id = 'win_fsm'`;
    expect(r[0].state).toBe('polling_baseline');

    // Tick B: step 3 polls ready → awaiting_after
    mockPollReport.mockResolvedValue({ status: 'ready', rows: readyRows });
    await runOneTick(sql);
    r = await sql`SELECT state FROM aso_measurement_windows WHERE id = 'win_fsm'`;
    // After this tick the window is awaiting_after (step 3), then step 4 (same tick, opened>30d) → polling_after
    // then step 5 polls ready → closed. So one full tick can cascade. Assert final closed.
    expect(r[0].state).toBe('closed');
  });

  it('measurement_verdict change event is emitted when window closes', async () => {
    const events = await sql`
      SELECT event_type, payload_json FROM aso_change_events WHERE tenant_id = 'T5' AND event_type = 'measurement_verdict'
    `;
    expect(events.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(events[0].payload_json);
    expect(payload.versionString).toBe('5.0.0');
    expect(payload.regime).toBe('correlational');
    expect(payload.metrics).toBeDefined();
  });

  it('window moves to error state when pollReport stays pending > 7 days', async () => {
    // Insert a polling_baseline window whose updated_at is 8 days old.
    await sql`
      INSERT INTO aso_measurement_windows
        (id, tenant_id, app_id, country, version_string, rec_keys_json, mixed_authorship, opened_at, regime, state, baseline_request_id, updated_at)
      VALUES ('win_stale', 'T6', 'APP6', 'us', '6.0.0', '[]', FALSE, ${new Date('2026-06-01T00:00:00Z').toISOString()}, 'correlational', 'polling_baseline', 'req-stale',
        ${new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()})
    `;
    mockPollReport.mockResolvedValue({ status: 'pending' });
    mockRequestReport.mockResolvedValue('req-x');

    await runOneTick(sql);

    const r = await sql`SELECT state, error_message FROM aso_measurement_windows WHERE id = 'win_stale'`;
    expect(r[0].state).toBe('error');
    expect(r[0].error_message).toBe('baseline_report_timeout');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `nvm use 24 && cd apps/server && pnpm test measurement/scheduler.test.ts`
Expected: FAIL — `Cannot find module './scheduler'`.

- [ ] **Step 4: Write the implementation — `apps/server/src/measurement/scheduler.ts`**

```ts
import type postgres from 'postgres';
import type { Mastra } from '@mastra/core';
import type { AscCredentials } from '../asc/credential-store';
import { loadCredentials } from '../asc/credential-store';
import { insertChangeEvent } from '../tracking/store';
import { openWindow, getWindowsInState, updateWindowState } from './store';
import { requestReport, pollReport } from './reporter';
import { computeVerdict } from './verdict';
import type { MeasurementWindow } from './types';

export interface SchedulerHandle {
  stop: () => void;
}

const INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const DAY_MS = 24 * 60 * 60 * 1000;
const AFTER_DELAY_MS = 30 * DAY_MS; // request after-period only once opened_at is > 30 days old
const AFTER_WINDOW_MS = 28 * DAY_MS;
const BASELINE_WINDOW_MS = 28 * DAY_MS;
const POLL_TIMEOUT_MS = 7 * DAY_MS;

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

interface GoLiveRow {
  tenant_id: string;
  app_id: string;
  country: string;
  payload_json: string;
  created_at: Date;
}

interface RecKeyRow {
  rec_key: string;
}

async function loadCredsOrNull(sql: postgres.Sql, tenantId: string): Promise<AscCredentials | null> {
  const res = await loadCredentials(sql, tenantId);
  if (!res.ok || !res.value) return null;
  return res.value;
}

// ── Step 1: open windows for unprocessed go_live events ───────────────────────
async function stepOpenWindows(sql: postgres.Sql): Promise<void> {
  const events = await sql<GoLiveRow[]>`
    SELECT tenant_id, app_id, country, payload_json, created_at
    FROM aso_change_events
    WHERE event_type = 'go_live'
    ORDER BY created_at ASC
  `;

  for (const e of events) {
    try {
      const payload = JSON.parse(e.payload_json) as { versionString?: string };
      const versionString = payload.versionString;
      if (!versionString) continue;

      // duplicate guard
      const existing = await sql`
        SELECT 1 FROM aso_measurement_windows
        WHERE tenant_id = ${e.tenant_id} AND app_id = ${e.app_id}
          AND country = ${e.country} AND version_string = ${versionString}
      `;
      if (existing.length > 0) continue;

      const creds = await loadCredsOrNull(sql, e.tenant_id);
      if (!creds) continue;

      const openedAt = new Date(e.created_at);
      const windowStart = new Date(openedAt.getTime() - 7 * DAY_MS);

      const recRows = await sql<RecKeyRow[]>`
        SELECT rec_key FROM aso_recommendations
        WHERE tenant_id = ${e.tenant_id} AND app_id = ${e.app_id} AND country = ${e.country}
          AND status = 'applied'
          AND applied_at IS NOT NULL
          AND applied_at::timestamptz BETWEEN ${windowStart.toISOString()} AND ${openedAt.toISOString()}
      `;
      const recKeys = recRows.map((r) => r.rec_key);

      await openWindow(sql, e.tenant_id, {
        appId: e.app_id,
        country: e.country,
        versionString,
        openedAt,
        recKeys,
        mixedAuthorship: recKeys.length > 1,
      });
    } catch (err) {
      console.error(`[measurement] step1 openWindow failed for ${e.tenant_id}/${e.app_id}:`, err);
    }
  }
}

// ── Step 2: submit baseline report requests ───────────────────────────────────
async function stepSubmitBaseline(sql: postgres.Sql): Promise<void> {
  const windows = await getWindowsInState(sql, 'awaiting_baseline');
  for (const w of windows) {
    try {
      const creds = await loadCredsOrNull(sql, w.tenantId);
      if (!creds) continue;
      const openedAt = new Date(w.openedAt);
      const start = toDateStr(new Date(openedAt.getTime() - BASELINE_WINDOW_MS));
      const end = toDateStr(openedAt);
      const requestId = await requestReport(creds, w.appId, w.country, start, end);
      await updateWindowState(sql, w.id, 'polling_baseline', { baselineRequestId: requestId });
    } catch (err) {
      console.error(`[measurement] step2 submitBaseline failed for ${w.id}:`, err);
      await failWindow(sql, w.id, String(err));
    }
  }
}

// ── Step 3: poll baseline reports ─────────────────────────────────────────────
async function stepPollBaseline(sql: postgres.Sql): Promise<void> {
  const windows = await getWindowsInState(sql, 'polling_baseline');
  for (const w of windows) {
    try {
      const creds = await loadCredsOrNull(sql, w.tenantId);
      if (!creds) continue;
      const result = await pollReport(creds, w.baselineRequestId ?? '');
      if (result.status === 'ready') {
        await updateWindowState(sql, w.id, 'awaiting_after', { baselineJson: result.rows });
      } else if (isStale(w)) {
        await updateWindowState(sql, w.id, 'error', { errorMessage: 'baseline_report_timeout' });
      }
    } catch (err) {
      console.error(`[measurement] step3 pollBaseline failed for ${w.id}:`, err);
      await failWindow(sql, w.id, String(err));
    }
  }
}

// ── Step 4: submit after-period report requests ───────────────────────────────
async function stepSubmitAfter(sql: postgres.Sql): Promise<void> {
  const windows = await getWindowsInState(sql, 'awaiting_after');
  for (const w of windows) {
    try {
      const openedAt = new Date(w.openedAt);
      if (Date.now() < openedAt.getTime() + AFTER_DELAY_MS) continue;
      const creds = await loadCredsOrNull(sql, w.tenantId);
      if (!creds) continue;
      const start = toDateStr(openedAt);
      const end = toDateStr(new Date(openedAt.getTime() + AFTER_WINDOW_MS));
      const requestId = await requestReport(creds, w.appId, w.country, start, end);
      await updateWindowState(sql, w.id, 'polling_after', { afterRequestId: requestId });
    } catch (err) {
      console.error(`[measurement] step4 submitAfter failed for ${w.id}:`, err);
      await failWindow(sql, w.id, String(err));
    }
  }
}

// ── Step 5: poll after reports + close ────────────────────────────────────────
async function stepPollAfterAndClose(sql: postgres.Sql): Promise<void> {
  const windows = await getWindowsInState(sql, 'polling_after');
  for (const w of windows) {
    try {
      const creds = await loadCredsOrNull(sql, w.tenantId);
      if (!creds) continue;
      const result = await pollReport(creds, w.afterRequestId ?? '');
      if (result.status === 'pending') {
        if (isStale(w)) {
          await updateWindowState(sql, w.id, 'error', { errorMessage: 'after_report_timeout' });
        }
        continue;
      }
      const verdict = computeVerdict(w.baselineJson ?? [], result.rows, w.mixedAuthorship);
      await updateWindowState(sql, w.id, 'closed', { afterJson: result.rows, verdictJson: verdict });
      await insertChangeEvent(sql, w.tenantId, {
        appId: w.appId,
        country: w.country,
        eventType: 'measurement_verdict',
        payload: { versionString: w.versionString, ...verdict },
      });
    } catch (err) {
      console.error(`[measurement] step5 pollAfterAndClose failed for ${w.id}:`, err);
      await failWindow(sql, w.id, String(err));
    }
  }
}

function isStale(w: MeasurementWindow): boolean {
  return Date.now() - new Date(w.updatedAt).getTime() > POLL_TIMEOUT_MS;
}

async function failWindow(sql: postgres.Sql, id: string, message: string): Promise<void> {
  try {
    await updateWindowState(sql, id, 'error', { errorMessage: message.slice(0, 300) });
  } catch (err) {
    console.error(`[measurement] failWindow could not mark ${id} as error:`, err);
  }
}

export function startMeasurementScheduler(_mastra: Mastra, sql: postgres.Sql): SchedulerHandle {
  const steps: Array<(sql: postgres.Sql) => Promise<void>> = [
    stepOpenWindows,
    stepSubmitBaseline,
    stepPollBaseline,
    stepSubmitAfter,
    stepPollAfterAndClose,
  ];

  async function tick(): Promise<void> {
    for (const step of steps) {
      try {
        await step(sql);
      } catch (err) {
        console.error('[measurement] step failed:', err);
      }
    }
  }

  // Immediate first pass — recovers any windows stalled during downtime.
  void tick();
  const timer = setInterval(() => void tick(), INTERVAL_MS);

  return { stop: () => clearInterval(timer) };
}
```

Note: the `_mastra` parameter matches the tracking scheduler signature and the spec's `startMeasurementScheduler(mastra, sql)`; it is currently unused (measurement does not run audits) but kept for signature parity and future use.

- [ ] **Step 5: Run test to verify it passes**

Run: `nvm use 24 && cd apps/server && pnpm test measurement/scheduler.test.ts`
Expected: PASS — 7 passed.

- [ ] **Step 6: Wire up `apps/server/src/mastra/index.ts`**

Add the import after the existing tracking scheduler import (line 15):
```ts
import { startMeasurementScheduler } from '../measurement/scheduler';
```

Replace the `.then(() => { ... })` body that starts worker/tracker:

Find:
```ts
            .then(() => {
              const worker = startWorker(mastra, sql);
              const tracker = startTrackingScheduler(mastra, sql);
              registerShutdown(worker, tracker, sql);
            })
```

Replace with:
```ts
            .then(() => {
              const worker = startWorker(mastra, sql);
              const tracker = startTrackingScheduler(mastra, sql);
              const measurer = startMeasurementScheduler(mastra, sql);
              registerShutdown(worker, tracker, measurer, sql);
            })
```

Update the `registerShutdown` signature and body:

Find:
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
```

Replace with:
```ts
function registerShutdown(
  worker: WorkerHandle,
  tracker: import('../tracking/scheduler').SchedulerHandle,
  measurer: import('../measurement/scheduler').SchedulerHandle,
  sql: import('postgres').Sql,
): void {
  async function shutdown(signal: string): Promise<void> {
    console.log(`[shutdown] ${signal} received — stopping worker, tracker, and measurer...`);
    worker.stop();
    tracker.stop();
    measurer.stop();
```

- [ ] **Step 7: Verify full server compile + test suite**

Run: `nvm use 24 && cd apps/server && pnpm tsc --noEmit && pnpm test`
Expected: zero TS errors; all tests pass (including the four new measurement test files).

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/tracking/types.ts apps/server/src/measurement/scheduler.ts apps/server/src/measurement/scheduler.test.ts apps/server/src/mastra/index.ts
git commit -m "feat(p7c): measurement scheduler, measurement_verdict event type, server wire-up"
```

---

## Task 6: Web activity feed integration

**Files:**
- Modify: `apps/web/src/lib/api.ts` (add `measurement_verdict` to `ActivityEvent.eventType`)
- Modify: `apps/web/src/components/ActivityFeed.tsx` (add card variant)

**Interfaces:**
- Consumes: the `measurement_verdict` change event payload emitted in Task 5 — `{ versionString, regime, windowDays, metrics: { impressions/downloads/conversionRate: { before, after, deltaPercent } }, mixedAuthorship, disclaimer }`.

- [ ] **Step 1: Update `ActivityEvent.eventType` in `apps/web/src/lib/api.ts`**

Find:
```ts
export interface ActivityEvent {
  id: string;
  appId: string;
  appName: string;
  country: string;
  eventType: 'go_live' | 'metadata_changed' | 'reviews_shifted';
  payload: Record<string, unknown>;
  createdAt: string;
}
```

Replace with:
```ts
export interface ActivityEvent {
  id: string;
  appId: string;
  appName: string;
  country: string;
  eventType: 'go_live' | 'metadata_changed' | 'reviews_shifted' | 'measurement_verdict';
  payload: Record<string, unknown>;
  createdAt: string;
}
```

- [ ] **Step 2: Add the card variant in `apps/web/src/components/ActivityFeed.tsx`**

Inside `ActivityCard`, add this branch immediately **before** the `if (event.eventType === 'reviews_shifted') {` block (order does not matter functionally, but keep it grouped with the other event branches):

```tsx
  if (event.eventType === 'measurement_verdict') {
    const p = event.payload as {
      versionString: string;
      metrics: {
        impressions: { deltaPercent: number };
        downloads: { deltaPercent: number };
        conversionRate: { deltaPercent: number };
      };
      mixedAuthorship: boolean;
      disclaimer: string;
    };
    const fmt = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
    return (
      <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
        <p className="font-medium text-blue-800">
          📊 v{p.versionString} results · {event.appName} · {date}
        </p>
        <p className="mt-1 text-sm text-blue-700">
          Impressions {fmt(p.metrics.impressions.deltaPercent)} · Downloads {fmt(p.metrics.downloads.deltaPercent)} · Conversion {fmt(p.metrics.conversionRate.deltaPercent)}
        </p>
        <p className="mt-1 text-xs text-blue-500">Directional only — 28-day window, correlational.</p>
        {p.mixedAuthorship && (
          <p className="mt-0.5 text-xs text-blue-500">Multiple changes applied — bundle-level attribution.</p>
        )}
      </div>
    );
  }

```

- [ ] **Step 3: Build verification**

Run: `nvm use 24 && cd apps/web && pnpm build`
Expected: zero TypeScript errors; build succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/api.ts apps/web/src/components/ActivityFeed.tsx
git commit -m "feat(p7c): measurement_verdict card in ActivityFeed"
```

---

## Self-Review

**1. Spec coverage**

| Spec section | Task |
|---|---|
| §1 DB table `aso_measurement_windows` + index | Task 1 |
| §1 Duplicate guard (tenant/app/country/version) | Task 2 (`openWindow` returns null); Task 5 (step 1 re-checks) |
| §2 Module structure + types | Tasks 1–5 |
| §3 Report periods (before/after 28d; +30d delay) | Task 5 (steps 2, 4) |
| §4 Scheduler interface + 5-step tick | Task 5 |
| §4 Error handling (per-step + per-window try/catch) | Task 5 (`failWindow`, step-level try/catch) |
| §5 `reporter.ts` requestReport/pollReport | Task 4 |
| §6 `verdict.ts` computeVerdict, zero-baseline guard, disclaimer | Task 3 |
| §7 Activity feed `measurement_verdict` visible + card | Tasks 5 (event type) + 6 (card); `getChangeEvents` already excludes only `version_status`, so `measurement_verdict` surfaces automatically |
| §8 Edge cases: no creds → skip | Task 5 (step 1 `continue`) |
| §8 auth_failed → error | Task 5 (`requestReport` throws → `failWindow`) |
| §8 pending > 7 days → error | Task 5 (`isStale` guard in steps 3 & 5) |
| §8 zero baseline → deltaPercent 0 | Task 3 |
| §8 multiple recs → mixedAuthorship | Task 5 (step 1: `recKeys.length > 1`) |
| §8 duplicate go_live → idempotent | Task 2 / Task 5 |
| §8 creds deleted mid-window → error | Task 5 (`pollReport` throws `no_credentials` → `failWindow`) |
| §9 Tests (store/verdict/reporter/scheduler) | Tasks 2, 3, 4, 5 |

**2. Placeholder scan:** No `TBD`/`TODO`/"implement later". All code blocks are complete. Every SQL statement uses postgres.js template literals (with `sql.unsafe` only for the static column-list string, which contains no user input).

**3. Type consistency:**
- `openWindow`/`getWindowsInState`/`updateWindowState` signatures identical between Task 2 definition, Task 2 tests, and Task 5 consumption.
- `requestReport(creds, appId, country, startDate, endDate)` and `pollReport(creds, requestId)` identical between Task 4 definition/tests and Task 5 consumption.
- `computeVerdict(baseline, after, mixedAuthorship?)` identical between Task 3 and Task 5.
- `MeasurementWindow` includes `updatedAt` (used by `isStale` in Task 5) and `createdAt` — both added in Task 1.
- `ChangeEventType` (Task 5) includes `measurement_verdict`, matching the `insertChangeEvent` call in the scheduler.
- Web `ActivityEvent.eventType` (Task 6) matches server `ActivityEvent.eventType` (Task 5).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-11-p7c-measurement-windows.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration. REQUIRED SUB-SKILL: superpowers:subagent-driven-development.
2. **Inline Execution** — execute tasks in this session using superpowers:executing-plans, batch execution with checkpoints.
