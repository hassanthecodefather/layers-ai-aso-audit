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
  try {
    const res = await loadCredentials(sql, tenantId);
    if (!res.ok || !res.value) return null;
    return res.value;
  } catch {
    return null;
  }
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
      const openedAt = new Date(w.openedAt);
      const start = toDateStr(new Date(openedAt.getTime() - BASELINE_WINDOW_MS));
      const end = toDateStr(openedAt);
      const requestId = await requestReport(creds as AscCredentials, w.appId, w.country, start, end);
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
      const result = await pollReport(creds as AscCredentials, w.baselineRequestId ?? '');
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
      const start = toDateStr(openedAt);
      const end = toDateStr(new Date(openedAt.getTime() + AFTER_WINDOW_MS));
      const requestId = await requestReport(creds as AscCredentials, w.appId, w.country, start, end);
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
      const result = await pollReport(creds as AscCredentials, w.afterRequestId ?? '');
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
