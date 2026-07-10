# P7-B: Continuous Tracking — Design Spec

> **Sub-spec B of P7 · Connected & Always-On**
> Sub-specs: A (ASC auth + read client ✅) → **B (this)** → C (measurement windows) → D (cost economics)

---

## Goal

After an audit runs, give the tenant the option to keep watching that app automatically. Once opted in, a lightweight daily scan checks version status, metadata, and reviews — emitting change events and triggering a full re-audit on go-live. No LLM, no vision, no crawler in the daily scan itself.

---

## Architecture overview

```
Audit results UI
  └─ "Watch this app" card
       └─ POST /api/tracking → aso_tracked_apps

Scheduler (setInterval, hourly)
  └─ for each due tracked app (last_scanned_at > 23h or null):
       1. loadCredentials → skip if not connected
       2. getAppVersions (ASC) → version diff
       3. iTunes Lookup → metadata diff
       4. iTunes reviews → review delta
       └─ INSERT aso_change_events
       └─ on go_live → insertJob (full re-audit)

Activity Feed (GET /api/activity)
  └─ reads aso_change_events → card list
```

All daily scan calls are read-only cheap API calls. Vision, LLM, and crawler fire only inside the full re-audit triggered by a go-live.

---

## Section 1: Tracked App Registry

### DB table

```sql
CREATE TABLE IF NOT EXISTS aso_tracked_apps (
  tenant_id    TEXT NOT NULL,
  app_id       TEXT NOT NULL,
  country      TEXT NOT NULL DEFAULT 'us',
  bundle_id    TEXT NOT NULL,
  app_name     TEXT NOT NULL,
  url          TEXT NOT NULL,  -- App Store URL, passed directly to insertJob on go-live
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  enabled_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_scanned_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, app_id, country)
);
```

### API routes (`apps/server/src/tracking/routes.ts`)

| Method | Path | Body / Response |
|---|---|---|
| `POST` | `/api/tracking` | `{ appId, country, bundleId, appName, url }` → `201` |
| `GET` | `/api/tracking` | `TrackedApp[]` — includes `lastScannedAt`, `enabled` |
| `DELETE` | `/api/tracking/:appId` | `204` |

All routes behind `getAuthenticatedTenantId`. `POST` is idempotent — upserts on `(tenant_id, app_id, country)`.

### `TrackedApp` type

```ts
type TrackedApp = {
  appId: string;
  country: string;
  bundleId: string;
  appName: string;
  url: string;
  enabled: boolean;
  enabledAt: string;
  lastScannedAt: string | null;
};
```

---

## Section 2: Daily Scheduler

### Location

`apps/server/src/tracking/scheduler.ts` — started in `apps/server/src/mastra/index.ts` alongside the existing audit worker.

### Interface

```ts
interface SchedulerHandle {
  stop: () => void;
}

function startTrackingScheduler(mastra: Mastra, sql: postgres.Sql): SchedulerHandle
```

### Behaviour

- Wakes every **60 minutes** via `setInterval`
- Queries `aso_tracked_apps` for rows where `enabled = true` AND (`last_scanned_at IS NULL` OR `last_scanned_at < NOW() - INTERVAL '23 hours'`)
- Scans apps **sequentially** (not in parallel) to stay within Apple API rate limits
- Updates `last_scanned_at` after each scan regardless of outcome
- Errors in individual scans are logged and do not crash the scheduler loop

### Startup

On server start the scheduler fires an immediate first pass (catches apps that went unscanned during downtime), then settles into the hourly interval.

---

## Section 3: Lightweight Daily Scan

### Location

`apps/server/src/tracking/scan.ts`

### Interface

```ts
async function runScan(
  app: TrackedApp,
  tenantId: string,
  sql: postgres.Sql,
  mastra: Mastra,
): Promise<void>
```

### Three checks (in order)

#### Check 1 — Version status (ASC)

- Loads ASC credentials via `loadCredentials(sql, tenantId)`
- If no credentials: skips checks 1 only; continues to checks 2 and 3
- Calls `getAppStoreVersionsClient(creds).getAppVersions(app.appId)`
- Compares top version's `versionString` + `state` against last recorded values in `aso_change_events` (latest `version_status` event for this app)
- On state transition to `READY_FOR_SALE`:
  - Emits `go_live` event
  - Calls `insertJob(sql, { tenantId, url: appStoreUrl(app), reopenIdentity: 0 })` to queue a full re-audit

#### Check 2 — Metadata diff (iTunes Lookup)

- Fetches title, subtitle, description, icon URL via the existing iTunes Lookup endpoint
- Compares against the most recent `aso_listing_snapshots` row for this `(app_id, country)`
- If any field changed: emits `metadata_changed` event with `{ field, before, after }` in payload

#### Check 3 — Review delta

- Fetches current rating and review count from iTunes Lookup response
- Compares against last recorded values (latest `reviews_shifted` event or `aso_listing_snapshots`)
- Emits `reviews_shifted` event if rating changed by ≥ 0.1 OR review count changed by ≥ 5

### Error handling

Each check is wrapped independently. A failure in check 1 (e.g. auth_failed) does not skip checks 2 and 3. All errors are logged; no throws propagate to the scheduler.

---

## Section 4: Change Events

### DB table

```sql
CREATE TABLE IF NOT EXISTS aso_change_events (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  app_id      TEXT NOT NULL,
  country     TEXT NOT NULL DEFAULT 'us',
  event_type  TEXT NOT NULL,  -- 'go_live' | 'metadata_changed' | 'reviews_shifted' | 'version_status'
  payload_json TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS aso_change_events_tenant_created
  ON aso_change_events (tenant_id, created_at DESC);
```

### Event payloads

**`go_live`**
```json
{ "versionString": "2.1.0", "appId": "...", "auditJobId": "..." }
```

**`metadata_changed`**
```json
{ "field": "subtitle", "before": "Old subtitle", "after": "New subtitle" }
```

**`reviews_shifted`**
```json
{ "ratingBefore": 4.2, "ratingAfter": 4.4, "countBefore": 120, "countAfter": 132 }
```

**`version_status`** (baseline record — not shown in activity feed, used for diffing)
```json
{ "versionString": "2.1.0", "state": "READY_FOR_SALE" }
```

### Event ID

`crypto.randomUUID()` — no dependency on a sequence.

---

## Section 5: Activity Feed API

### Route

`GET /api/activity?limit=20&before=<iso-timestamp>`

Returns newest-first, paginated by `before`. Default limit 20, max 50.

Response:
```ts
type ActivityEvent = {
  id: string;
  appId: string;
  appName: string;
  country: string;
  eventType: 'go_live' | 'metadata_changed' | 'reviews_shifted';
  payload: Record<string, unknown>;
  createdAt: string;
};
```

Only `go_live`, `metadata_changed`, `reviews_shifted` are returned — `version_status` baseline records are filtered out.

---

## Section 6: UI

### "Watch this app" card (audit results)

Added to the existing audit results view after the recommendations list. Two states:

**Not yet tracking:**
Card with title "Watch this app" and subtitle "I'll check daily for go-lives, metadata changes, and review shifts." + "Enable tracking" button.

On click: calls `POST /api/tracking` with the audit's app details → card flips to tracking state.

**Already tracking:**
Shows "Tracking active — last checked X hours ago" with a small "Disable" link.

### Activity tab (header)

New tab "Activity" in the `Header` component. The existing app is single-page (no router), so "Activity" is a top-level view state managed in `App.tsx` — clicking the tab replaces the main content area, same pattern as switching between the audit list and audit results.

**Activity page** — chronological feed of change events:

- **Go-live card:** "v2.1.0 went live · [date] · Full audit queued"
- **Metadata changed card:** "Subtitle changed · [date] · Old subtitle → New subtitle"
- **Reviews shifted card:** "Rating 4.2 → 4.4 · [date] · +12 reviews"

Each card links to the relevant audit result if one exists. Page loads via `GET /api/activity`. No real-time push — refreshes on navigation.

---

## Section 7: Error handling & edge cases

| Scenario | Behaviour |
|---|---|
| No ASC credentials | Check 1 skipped; checks 2 & 3 still run |
| ASC `auth_failed` | Log error; skip check 1 for this scan; do not disable tracking |
| iTunes Lookup returns 404 | Log warning; skip checks 2 & 3; do not disable tracking |
| Full re-audit job insert fails | Log error; `go_live` event still written |
| Scheduler crashes | Server restart recovers it via `startTrackingScheduler` in `mastra/index.ts` |
| Duplicate go_live events | Guard: only emit `go_live` if the latest `version_status` event for this app has a *different* `versionString` |

---

## Section 8: Testing

| Test | What |
|---|---|
| `tracking/routes.test.ts` | POST creates row; GET returns list; DELETE disables; 401 without auth |
| `tracking/scan.test.ts` | go_live emitted on state transition; metadata_changed on field diff; reviews_shifted on delta; no event when nothing changed; check 2+3 run when no credentials |
| `tracking/scheduler.test.ts` | due apps selected correctly; `last_scanned_at` updated; scan errors don't stop scheduler |
| `tracking/activity-route.test.ts` | returns events newest-first; filters out `version_status`; pagination works |

All tests use real Postgres (same pattern as credential-store tests — unique schema, `afterAll` drop).

---

## New tables

| Table | Purpose |
|---|---|
| `aso_tracked_apps` | Per-tenant opt-in registry |
| `aso_change_events` | Append-only event log |

---

## What this sub-spec deliberately excludes

- Analytics report requests/polling (sub-spec C)
- Measurement windows — before/after comparisons (sub-spec C)
- Push notifications / email digests (post-P7)
- Competitor change tracking (post-P7)
- Rank tracking (post-P7 — requires a rank-tracking data source)
