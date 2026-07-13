# P8-C: Stop-Loss — Post-Approval Metric Monitoring

## Goal

After a listing update is approved by Apple, automatically monitor conversion rate, impressions, and downloads over the following 7 days. If conversion rate drops ≥ 15% AND at least one of impressions or downloads drops ≥ 15% compared to the 7-day pre-approval baseline, fire an alert in the Activity Feed. The user can then revert the listing to its previous values or dismiss the alert.

## Scope

This is the second of two P8 sub-projects:
- **P8-B (previous):** generate → review → submit → track → reject/resubmit
- **P8-C (this spec):** monitor post-approval metrics → alert on drop → revert or dismiss

## User Flow

1. A listing update is approved by Apple (detected by P8-B's `check-listing-updates` scheduler step).
2. An `aso_listing_monitors` row is inserted automatically — no user action required.
3. The hourly scheduler fetches ASC analytics for the 7 days before approval as the baseline (once the 48-hour ASC reporting lag clears).
4. Starting at approval + 9 days (48h lag + 7 days of data), the scheduler evaluates the post-approval window against the baseline.
5. If the threshold is breached: an `listing_update_alert` change event is written and the Activity Feed shows an alert card:
   > *"Conversion rate −18%, downloads −21% in the 7 days after your listing update."*
   > **[Revert Listing]** **[Dismiss]**
6. **Revert:** the previous field values (stored at generation time) are PATCHed back to ASC. A `listing_update_reverted` change event is written. Activity Feed shows a confirmation card.
7. **Dismiss:** the monitor is closed without touching ASC. Alert collapses.
8. If no threshold breach after 9 days: monitor closes silently.

## Constraints

- One monitor per approved listing update — 1:1 with `aso_listing_updates`.
- Revert requires the original field values to have been stored at generation time (`previous_fields` on `aso_listing_updates` — a P8-B data model addition).
- ASC Analytics API has a ~48-hour reporting lag — baseline fetch is deferred until `approved_at + 48h`.
- ASC credentials must be present for both baseline fetch and revert write.
- If ASC credentials are missing or analytics fetch fails repeatedly, the monitor closes without alerting (fail-safe — no false positives).

## Threshold

**Alert fires when ALL of the following are true:**
- Conversion rate delta ≤ −15%
- AND (impressions delta ≤ −15% OR downloads delta ≤ −15%)

Delta is computed as `(post − pre) / pre`. Values are 7-day aggregates (sum for impressions and downloads; average for conversion rate).

## Architecture

### P8-B data model change: `previous_fields` column

Add one column to `aso_listing_updates`:

```sql
ALTER TABLE aso_listing_updates ADD COLUMN previous_fields JSONB;
```

The P8-B generate route already fetches `currentFields` from ASC (`fetchAscListingData`). It now stores those values in `previous_fields` at insert time. This is the only modification to P8-B.

`previous_fields` shape mirrors `ProposedFields`:
```ts
{ title?, subtitle?, keywords?, description?, promotionalText?, releaseNotes? }
```

### New table: `aso_listing_monitors`

```sql
CREATE TABLE aso_listing_monitors (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  app_id              TEXT NOT NULL,
  listing_update_id   TEXT NOT NULL REFERENCES aso_listing_updates(id),
  status              TEXT NOT NULL DEFAULT 'pending_baseline',
  baseline_metrics    JSONB,
  latest_metrics      JSONB,
  alert_fired_at      TIMESTAMPTZ,
  closed_at           TIMESTAMPTZ,
  approved_at         TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS aso_listing_monitors_tenant_app
  ON aso_listing_monitors (tenant_id, app_id);
```

**`status` values:** `pending_baseline` | `monitoring` | `alerted` | `closed`

**`baseline_metrics` / `latest_metrics` shape:**
```ts
{ impressions: number; downloads: number; conversionRate: number }
```

Both tables use JSONB — both go in `PG_ONLY_MIGRATIONS`.

### Modified: P8-B `check-listing-updates` scheduler step

When `check-listing-updates` transitions an `aso_listing_updates` row to `approved`, it also inserts an `aso_listing_monitors` row:

```ts
await insertListingMonitor(sql, {
  tenantId,
  appId,
  listingUpdateId: update.id,
  approvedAt: new Date(),
});
```

### New file: `apps/server/src/tracking/listing-monitor-checker.ts`

Single exported function:

```ts
export async function runListingMonitorCheck(sql: postgres.Sql): Promise<void>
```

Called from the hourly scheduler `tick()` after `runListingUpdateCheck`.

#### State machine transitions

**`pending_baseline` → `monitoring`**

For each row where `NOW() >= approved_at + 48 hours`:

1. Load ASC credentials via `loadCredentials(sql, tenantId)`.
2. Call `fetchAscAnalytics(creds, appId, { from: approved_at − 7 days, to: approved_at })`.
   - `fetchAscAnalytics` is the existing function in `apps/server/src/asc/analytics-client.ts` (used by P7-C).
3. Aggregate result: sum impressions, sum downloads, average conversionRate over the 7 days.
4. On success: write `baseline_metrics`, set `status = 'monitoring'`.
5. If no data returned (ASC still lagging): leave as `pending_baseline`, retry next hour.

**`monitoring` → `alerted` / `closed`**

For each row where `NOW() >= approved_at + 9 days`:

1. Call `fetchAscAnalytics(creds, appId, { from: approved_at, to: approved_at + 7 days })`.
2. Aggregate post-approval metrics the same way.
3. Store as `latest_metrics`.
4. Compute deltas:
   ```ts
   const convRateDelta = (post.conversionRate - pre.conversionRate) / pre.conversionRate;
   const impressionsDelta = (post.impressions - pre.impressions) / pre.impressions;
   const downloadsDelta = (post.downloads - pre.downloads) / pre.downloads;
   ```
5. **Threshold check:** `convRateDelta <= -0.15 && (impressionsDelta <= -0.15 || downloadsDelta <= -0.15)`
6. If breached:
   - Set `status = 'alerted'`, `alert_fired_at = NOW()`.
   - Call `insertChangeEvent` with `eventType: 'listing_update_alert'`.
7. If not breached:
   - Set `status = 'closed'`, `closed_at = NOW()`.

**Change event payload for `listing_update_alert`:**
```ts
{
  monitorId: string;
  listingUpdateId: string;
  baseline: { impressions: number; downloads: number; conversionRate: number };
  current:  { impressions: number; downloads: number; conversionRate: number };
  deltas:   { impressionsDelta: number; downloadsDelta: number; conversionRateDelta: number };
}
```

#### Fail-safe behaviour

If analytics fetch fails (missing credentials, ASC error, network timeout):
- Log the error, skip this monitor, retry next hour.
- If `approved_at + 5 days` has passed and status is still `pending_baseline` (analytics never returned data): set `status = 'closed'` and log a warning.
- If `approved_at + 14 days` has passed and status is still `monitoring` (evaluation never completed): set `status = 'closed'` and log a warning.
- This prevents zombie rows accumulating indefinitely.

### New file: `apps/server/src/queue/listing-monitor-store.ts`

CRUD for `aso_listing_monitors`:

```ts
export async function insertListingMonitor(sql, params: { tenantId, appId, listingUpdateId, approvedAt }): Promise<ListingMonitor>
export async function getPendingBaselineMonitors(sql): Promise<ListingMonitor[]>
export async function getMonitoringMonitors(sql): Promise<ListingMonitor[]>
export async function setMonitorBaseline(sql, id, baselineMetrics): Promise<void>
export async function setMonitorAlerted(sql, id, latestMetrics, alertFiredAt): Promise<void>
export async function setMonitorClosed(sql, id): Promise<void>
export async function getMonitorById(sql, tenantId, id): Promise<ListingMonitor | null>
```

### Modified: `apps/server/src/tracking/types.ts`

Add two new values to the `ChangeEventType` union:

```ts
| 'listing_update_alert'    // metric drop threshold breached
| 'listing_update_reverted' // user reverted the listing
```

### New routes: `apps/server/src/mastra/listing-monitor-routes.ts`

**`POST /listing-update/revert`**

Body: `{ monitorId: string }`

1. Load monitor row, verify `status = 'alerted'`, verify tenant ownership.
2. Load the associated `aso_listing_updates` row — get `previous_fields` and `asc_localization_id`.
3. If `previous_fields` is null: return error *"No previous field values stored — cannot revert automatically."*
4. Load ASC credentials, call `pushListingUpdate(creds, asc_localization_id, previous_fields)`.
5. On success: `setMonitorClosed(sql, monitorId)`.
6. Insert `listing_update_reverted` change event.
7. Return `{ ok: true }`.

**`POST /listing-update/dismiss-alert`**

Body: `{ monitorId: string }`

1. Load monitor row, verify `status = 'alerted'`, verify tenant ownership.
2. `setMonitorClosed(sql, monitorId)`.
3. Return `{ ok: true }`.

Both routes registered in `apps/server/src/mastra/index.ts` alongside the P8-B listing update routes.

### Frontend

**`apps/web/src/lib/api.ts`** — add:
```ts
export async function revertListingUpdate(monitorId: string): Promise<{ ok: boolean }>
export async function dismissListingAlert(monitorId: string): Promise<{ ok: boolean }>
```

**`apps/web/src/components/ActivityFeed.tsx`** — two new event type cards:

**`listing_update_alert` card:**
```
⚠️  Your listing update may be hurting performance
Conversion rate −18% · Downloads −21% · 7 days post-approval
[Revert Listing]  [Dismiss]
```
Inline state: idle → reverting (spinner) → reverted / dismissed.

**`listing_update_reverted` card:**
```
↩  Listing reverted to previous values
Consider running a new audit before resubmitting.
```

## Data Flow

```
P8-B check-listing-updates detects approval
  → INSERT aso_listing_monitors (pending_baseline, approved_at = NOW())

Hourly tick: runListingMonitorCheck
  pending_baseline (if NOW() >= approved_at + 48h):
    → fetchAscAnalytics (7 days before approval)
    → store baseline_metrics, status = monitoring

  monitoring (if NOW() >= approved_at + 9d):
    → fetchAscAnalytics (approved_at to approved_at + 7d)
    → compute deltas
    → threshold breached → status = alerted, insertChangeEvent(listing_update_alert)
    → threshold ok      → status = closed

Activity Feed shows listing_update_alert card
  → "Revert Listing" → POST /listing-update/revert
      → pushListingUpdate(previous_fields)
      → status = closed
      → insertChangeEvent(listing_update_reverted)
  → "Dismiss"        → POST /listing-update/dismiss-alert
      → status = closed
```

## Error Handling

| Failure | Behaviour |
|---|---|
| ASC credentials missing at baseline fetch | Skip, retry next hour |
| Analytics fetch returns no data (lag) | Leave as `pending_baseline`, retry next hour |
| Analytics fetch fails repeatedly (> 5 days in `pending_baseline`) | Close monitor, log warning |
| `previous_fields` null at revert time | Return error — no automatic revert possible |
| `pushListingUpdate` fails on revert | Return error, monitor stays `alerted`, user can retry |
| Monitor stuck > 14 days post-approval | Force-close, log warning |

## Out of Scope

- Configurable thresholds per app or per user — fixed at −15% for this version
- Multi-metric dashboards or sparklines showing the full 7-day trend
- Stop-loss for metadata changes not made through P8-B (manual ASC edits)
- Partial revert — either all applied fields revert or none (atomic)
- Multiple monitoring windows (e.g., re-check at 14 days)
- Notification channels beyond the Activity Feed (email, Slack)
