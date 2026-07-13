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
