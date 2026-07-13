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
