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
