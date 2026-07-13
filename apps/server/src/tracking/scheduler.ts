import type postgres from 'postgres';
import type { Mastra } from '@mastra/core';
import { getDueApps, updateLastScanned } from './store';
import { runScan } from './scan';
import { runListingUpdateCheck } from './listing-update-checker';

export interface SchedulerHandle {
  stop: () => void;
}

export function startTrackingScheduler(
  mastra: Mastra,
  sql: postgres.Sql,
): SchedulerHandle {
  const INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  async function tick(): Promise<void> {
    let due: Awaited<ReturnType<typeof getDueApps>>;
    try {
      due = await getDueApps(sql);
    } catch (e) {
      console.error('[tracking] getDueApps failed:', e);
      return;
    }

    for (const { tenantId, app } of due) {
      try {
        await runScan(app, tenantId, sql, mastra);
      } catch (e) {
        console.error(`[tracking] scan error for ${tenantId}/${app.appId}:`, e);
      }
      try {
        await updateLastScanned(sql, tenantId, app.appId, app.country);
      } catch (e) {
        console.error(`[tracking] updateLastScanned failed for ${tenantId}/${app.appId}:`, e);
      }
    }

    // After the per-app scan loop, check all in-flight listing updates:
    try {
      await runListingUpdateCheck(sql);
    } catch (e) {
      console.error('[tracking] runListingUpdateCheck failed:', e);
    }
  }

  // Immediate first pass — recovers any apps that went unscanned during downtime
  void tick();
  const timer = setInterval(() => void tick(), INTERVAL_MS);

  return { stop: () => clearInterval(timer) };
}
