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
