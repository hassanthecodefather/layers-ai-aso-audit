# P7-C: Measurement Windows — Design Spec

> **Sub-spec C of P7 · Connected & Always-On**
> Sub-specs: A (ASC auth + read client ✅) → B (continuous tracking ✅) → **C (this)** → D (cost economics)

---

## Goal

When a tracked app goes live with a new version, automatically open a 28-day measurement window that captures funnel metrics before and after the change — and closes with an honest correlational verdict. No causal claims. Metadata is permanently correlational; visual A/B (PPO) is deferred to P8.

---

## Architecture overview

```
P7-B go_live event
  └─ aso_change_events (event_type = 'go_live')

Measurement scheduler (setInterval, hourly)
  └─ Step 1: find unprocessed go_live events → open windows
  └─ Step 2: poll Apple for pending baseline reports → store baseline
  └─ Step 3: submit after-period report for windows ≥ 30 days old
  └─ Step 4: poll Apple for pending after reports → compute verdict → emit event

aso_measurement_windows (state machine)
  awaiting_baseline → polling_baseline → awaiting_after → polling_after → closed
                                                                        ↘ error

measurement_verdict event
  └─ insertChangeEvent → GET /activity → ActivityFeed.tsx card
```

The `measurement/` module is completely independent of `tracking/`. It reads `aso_change_events` reactively — `tracking/scan.ts` has no knowledge of measurement.

---

## Section 1: DB table

Added to `PG_ONLY_MIGRATIONS` in `apps/server/src/memory/pg-migrate.ts`:

```sql
CREATE TABLE IF NOT EXISTS aso_measurement_windows (
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
);

CREATE INDEX IF NOT EXISTS aso_measurement_windows_tenant_state
  ON aso_measurement_windows (tenant_id, state, updated_at DESC);
```

### Field notes

| Field | Purpose |
|-------|---------|
| `rec_keys_json` | JSON array of `rec_key` values from `aso_recommendations` where `status = 'applied'` and `applied_at` is within 7 days before `opened_at` |
| `mixed_authorship` | `TRUE` when more than one rec is linked — verdict card adds a note |
| `opened_at` | Timestamp of the `go_live` event — baseline pins here, not at submit |
| `regime` | Always `'correlational'` for metadata; reserved for future visual regime |
| `state` | One of `awaiting_baseline`, `polling_baseline`, `awaiting_after`, `polling_after`, `closed`, `error` |
| `baseline_request_id` | ASC `reportRequestId` for the before-period report |
| `after_request_id` | ASC `reportRequestId` for the after-period report |
| `baseline_json` / `after_json` | Aggregated `ReportRow[]` from Apple, stored as JSON |
| `verdict_json` | Output of `computeVerdict()` — see Section 4 |
| `error_message` | Set when `state = 'error'`; window is not retried automatically |

### Duplicate guard

Window opening queries `aso_measurement_windows` for an existing row with the same `(tenant_id, app_id, country, version_string)` before inserting. A `go_live` event processed twice does not create two windows.

---

## Section 2: Module structure

```
apps/server/src/measurement/
  types.ts       — MeasurementWindow, WindowState, VerdictJson, VerdictMetrics
  store.ts       — openWindow, getWindowsInState, updateWindowState
  reporter.ts    — requestReport, pollReport (wraps AscAnalyticsClient)
  verdict.ts     — computeVerdict(baseline, after): VerdictJson  [pure function]
  scheduler.ts   — startMeasurementScheduler(mastra, sql): SchedulerHandle
```

### Types

```ts
type WindowState =
  | 'awaiting_baseline'
  | 'polling_baseline'
  | 'awaiting_after'
  | 'polling_after'
  | 'closed'
  | 'error';

type MeasurementWindow = {
  id: string;
  tenantId: string;
  appId: string;
  country: string;
  versionString: string;
  recKeys: string[];
  mixedAuthorship: boolean;
  openedAt: string;          // ISO-8601
  regime: 'correlational';
  state: WindowState;
  baselineRequestId: string | null;
  afterRequestId: string | null;
  baselineJson: ReportRow[] | null;
  afterJson: ReportRow[] | null;
  verdictJson: VerdictJson | null;
  errorMessage: string | null;
};

type VerdictMetrics = {
  before: number;
  after: number;
  deltaPercent: number;
};

type VerdictJson = {
  regime: 'correlational';
  windowDays: 28;
  metrics: {
    impressions:    VerdictMetrics;
    downloads:      VerdictMetrics;
    conversionRate: VerdictMetrics;
  };
  mixedAuthorship: boolean;
  disclaimer: string;
};
```

---

## Section 3: Report periods

| Period | Date range |
|--------|-----------|
| Before | `opened_at − 28 days` → `opened_at` |
| After  | `opened_at` → `opened_at + 28 days` |

The after-period report is not requested until `NOW() > opened_at + 30 days` — the extra 2 days allow Apple's data pipeline to finish indexing the full period before the report is generated.

---

## Section 4: Scheduler

### Interface

```ts
interface SchedulerHandle {
  stop: () => void;
}

function startMeasurementScheduler(mastra: Mastra, sql: postgres.Sql): SchedulerHandle
```

Started in `apps/server/src/mastra/index.ts` after migration, alongside the tracking scheduler:

```ts
const tracker  = startTrackingScheduler(mastra, sql);
const measurer = startMeasurementScheduler(mastra, sql);
registerShutdown(worker, tracker, measurer, sql);
```

### Tick (hourly, immediate first pass)

Each step is wrapped independently — one failure does not block the others:

**Step 1 — open pending windows**
```
Query aso_change_events WHERE event_type = 'go_live'
  AND NOT EXISTS (SELECT 1 FROM aso_measurement_windows
                  WHERE tenant_id = e.tenant_id AND app_id = e.app_id
                    AND country = e.country AND version_string = payload->>'versionString')
For each:
  - loadCredentials(sql, tenantId) → skip if no credentials
  - Query aso_recommendations for applied recs (status='applied', applied_at > opened_at - 7 days)
  - INSERT INTO aso_measurement_windows (state='awaiting_baseline', ...)
```

**Step 2 — submit baseline report requests**
```
Query windows WHERE state = 'awaiting_baseline'
For each:
  - requestReport(creds, appId, country, openedAt-28d, openedAt) → requestId
  - UPDATE state='polling_baseline', baseline_request_id=requestId
```

**Step 3 — poll baseline reports**
```
Query windows WHERE state = 'polling_baseline'
For each:
  - pollReport(creds, baseline_request_id) → pending | ready
  - If ready: UPDATE state='awaiting_after', baseline_json=rows
```

**Step 4 — submit after-period report requests**
```
Query windows WHERE state = 'awaiting_after'
  AND opened_at < NOW() - INTERVAL '30 days'
For each:
  - requestReport(creds, appId, country, openedAt, openedAt+28d) → requestId
  - UPDATE state='polling_after', after_request_id=requestId
```

**Step 5 — poll after reports + close windows**
```
Query windows WHERE state = 'polling_after'
For each:
  - pollReport(creds, after_request_id) → pending | ready
  - If ready:
      verdict = computeVerdict(baseline_json, after_rows)
      UPDATE state='closed', after_json=rows, verdict_json=verdict
      insertChangeEvent(sql, tenantId, { appId, country,
        eventType: 'measurement_verdict', payload: { versionString, ...verdict } })
```

### Error handling

Any step that throws updates the window to `state = 'error'` with the error message. Errors in individual windows are logged; the tick continues to the next window. Error windows are not retried automatically — an operator can reset them manually.

---

## Section 5: `reporter.ts`

Thin wrapper over `AscAnalyticsClient` from `../asc/analytics-client`:

```ts
async function requestReport(
  creds: AscCredentials,
  appId: string,
  country: string,
  startDate: string,   // YYYY-MM-DD
  endDate: string,     // YYYY-MM-DD
): Promise<string>     // returns requestId
// Calls: getAscAnalyticsClient(creds).createReportRequest('APP_STORE_ENGAGEMENT', { appId, frequency: 'DAILY', startDate, endDate })

async function pollReport(
  creds: AscCredentials,
  requestId: string,
): Promise<{ status: 'pending' } | { status: 'ready'; rows: ReportRow[] }>
// Calls: getAscAnalyticsClient(creds).pollReportInstance(requestId)
```

---

## Section 6: `verdict.ts`

Pure function — no DB, no network:

```ts
function computeVerdict(baseline: ReportRow[], after: ReportRow[]): VerdictJson

// Aggregates each ReportRow[] by summing impressions, downloads; averaging conversionRate
// deltaPercent = (after - before) / before * 100  (returns 0 if before === 0)
// disclaimer: "Directional only — not causal. Metadata reindex ~4 weeks;
//              competitor and algorithm shifts are not controlled for."
```

---

## Section 7: Activity feed integration

`measurement_verdict` is added to the set of event types returned by `GET /activity`. The existing `version_status` exclusion is unchanged; `measurement_verdict` is visible.

### New `ActivityCard` variant in `ActivityFeed.tsx`

```
📊  v2.1.0 results · My App · [date]
Impressions +20.8%  ·  Downloads +20.0%  ·  Conversion −1.4%
Directional only — 28-day window, correlational.
[note if mixedAuthorship: "2 changes applied in this version — bundle-level attribution."]
```

No new API routes. The card renders from the existing `GET /activity` response.

---

## Section 8: Error handling and edge cases

| Scenario | Behaviour |
|----------|-----------|
| No ASC credentials at window-open | Skip — no window created; `go_live` activity event still fires |
| `createReportRequest` returns `auth_failed` | `state = 'error'`, message logged |
| `pollReportInstance` stays `pending` for > 7 days | `state = 'error'` after 7 days without progress (guard in scheduler tick) |
| Zero baseline impressions | `deltaPercent = 0` (not divide-by-zero); verdict notes "insufficient baseline data" |
| Multiple recs applied in same version | `mixed_authorship = TRUE`; verdict card adds bundle-attribution note |
| Duplicate `go_live` event | Duplicate guard prevents second window; idempotent |
| Tenant deletes ASC credentials mid-window | `pollReport` returns `no_credentials`; window moves to `error` |

---

## Section 9: Testing

| Test | What |
|------|------|
| `measurement/store.test.ts` | `openWindow` creates row; duplicate go_live does not create second window; `getWindowsInState` filters correctly; `updateWindowState` advances state |
| `measurement/verdict.test.ts` | `computeVerdict` calculates `deltaPercent` correctly; zero-baseline returns `deltaPercent: 0`; mixed-authorship flag passes through |
| `measurement/reporter.test.ts` | `requestReport` calls `createReportRequest` with correct date range; `pollReport` returns `pending` or `ready` |
| `measurement/scheduler.test.ts` | Each step runs independently (one window failure does not block others); full state machine advances from `awaiting_baseline` to `closed` with mocked reporter; `measurement_verdict` event emitted on close |

All tests use real Postgres with unique schema, same pattern as the rest of the codebase.

---

## New table

| Table | Purpose |
|-------|---------|
| `aso_measurement_windows` | Per-version measurement window state machine |

---

## What this sub-spec deliberately excludes

- PPO (Product Page Optimization) A/B tests — visual regime (P8)
- Rank-tracking before/after (no rank data source until P8+)
- Per-recommendation attribution (bundle-level only; per-change causation is impossible for metadata)
- Push notifications or email digests for verdicts (post-P7)
- Retry logic for `error` windows (manual operator reset only)
