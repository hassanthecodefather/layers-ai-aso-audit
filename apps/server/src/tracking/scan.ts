import type postgres from 'postgres';
import type { Mastra } from '@mastra/core';
import type { TrackedApp } from './types';
import { loadCredentials, type AscCredentials } from '../asc/credential-store';
import { getAppStoreVersionsClient } from '../asc/versions-client';
import { getGateway } from '../cost/gateway';
import { insertJob } from '../queue/job-store';
import { newId } from '../memory/ids';
import { insertChangeEvent, getLastChangeEvent } from './store';

export async function runScan(
  app: TrackedApp,
  tenantId: string,
  sql: postgres.Sql,
  _mastra: Mastra,
): Promise<void> {
  const credsResult = await loadCredentials(sql, tenantId);
  if (credsResult.ok && credsResult.value) {
    try {
      await runVersionCheck(app, tenantId, sql, credsResult.value);
    } catch (e) {
      console.error(`[tracking] version check failed for ${tenantId}/${app.appId}:`, e);
    }
  }

  try {
    await runItunesChecks(app, tenantId, sql);
  } catch (e) {
    console.error(`[tracking] iTunes checks failed for ${tenantId}/${app.appId}:`, e);
  }
}

async function runVersionCheck(
  app: TrackedApp,
  tenantId: string,
  sql: postgres.Sql,
  creds: AscCredentials,
): Promise<void> {
  const client = getAppStoreVersionsClient(creds);
  const result = await client.getAppVersions(app.appId);
  if (!result.ok) {
    console.warn(`[tracking] getAppVersions failed:`, result.error);
    return;
  }
  const versions = [...result.value].sort(
    (a, b) => new Date(b.createdDate).getTime() - new Date(a.createdDate).getTime(),
  );
  const top = versions[0];
  if (!top) return;

  const lastEvent = await getLastChangeEvent(sql, tenantId, app.appId, app.country, 'version_status');
  const lastPayload = lastEvent?.payload as { versionString: string; state: string } | undefined;

  const versionChanged = !lastPayload || lastPayload.versionString !== top.versionString;
  const stateChanged = !lastPayload || lastPayload.state !== top.state;

  if (versionChanged || stateChanged) {
    await insertChangeEvent(sql, tenantId, {
      appId: app.appId, country: app.country,
      eventType: 'version_status',
      payload: { versionString: top.versionString, state: top.state },
    });

    const isNewVersion = !lastPayload || lastPayload.versionString !== top.versionString;
    if (top.state === 'READY_FOR_SALE' && isNewVersion) {
      let auditJobId: string | null = null;
      try {
        const job = await insertJob(sql, { runId: newId('run'), tenantId, url: app.url });
        auditJobId = job.id;
      } catch (e) {
        console.error(`[tracking] insertJob failed for go_live ${tenantId}/${app.appId}:`, e);
      }
      await insertChangeEvent(sql, tenantId, {
        appId: app.appId, country: app.country,
        eventType: 'go_live',
        payload: { versionString: top.versionString, appId: app.appId, auditJobId },
      });
    }
  }
}

async function runItunesChecks(
  app: TrackedApp,
  tenantId: string,
  sql: postgres.Sql,
): Promise<void> {
  const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(app.appId)}&country=${encodeURIComponent(app.country)}&entity=software`;
  const res = await getGateway().fetch(url, { kind: 'app', upstream: 'itunes' });
  if (!res.ok) {
    console.warn(`[tracking] iTunes lookup returned ${res.status} for ${app.appId}`);
    return;
  }
  const data = await res.json() as { results?: Record<string, unknown>[] };
  const result = data.results?.[0];
  if (!result) {
    console.warn(`[tracking] iTunes lookup returned no result for ${app.appId}`);
    return;
  }

  // Baseline: last snapshot from aso_listing_snapshots
  // listing_json stores a serialised AppListing: { name, subtitle, description, iconUrl, rating, ratingCount }
  const [snapshotRow] = await sql<{ listing_json: string }[]>`
    SELECT listing_json FROM aso_listing_snapshots
    WHERE tenant_id = ${tenantId} AND app_id = ${app.appId} AND country = ${app.country}
    ORDER BY fetched_at DESC
    LIMIT 1
  `;

  if (!snapshotRow) return;

  const baseline = JSON.parse(snapshotRow.listing_json) as {
    name?: string;
    subtitle?: string | null;
    description?: string;
    iconUrl?: string | null;
    rating?: number | null;
    ratingCount?: number | null;
  };

  // Check 2: metadata diff
  try {
    const fields = [
      { key: 'name',        before: baseline.name        ?? null, after: (result.trackName  as string | undefined) ?? null },
      { key: 'description', before: baseline.description ?? null, after: (result.description as string | undefined) ?? null },
      { key: 'iconUrl',     before: baseline.iconUrl     ?? null, after: (result.artworkUrl512 as string | null | undefined) ?? null },
    ] as const;

    for (const { key, before, after } of fields) {
      if (before !== after) {
        await insertChangeEvent(sql, tenantId, {
          appId: app.appId, country: app.country,
          eventType: 'metadata_changed',
          payload: { field: key, before, after },
        });
      }
    }
  } catch (e) {
    console.error(`[tracking] metadata diff failed for ${tenantId}/${app.appId}:`, e);
  }

  // Check 3: review delta
  try {
    const lastReviews = await getLastChangeEvent(sql, tenantId, app.appId, app.country, 'reviews_shifted');
    const baseRating  = lastReviews ? (lastReviews.payload as any).ratingAfter  : (baseline.rating     ?? null);
    const baseCount   = lastReviews ? (lastReviews.payload as any).countAfter   : (baseline.ratingCount ?? null);

    const currentRating = (result.averageUserRating as number | undefined) ?? null;
    const currentCount  = (result.userRatingCount  as number | undefined) ?? null;

    const ratingDelta = baseRating !== null && currentRating !== null ? Math.abs(currentRating - baseRating) : null;
    const countDelta  = baseCount  !== null && currentCount  !== null ? Math.abs(currentCount  - baseCount)  : null;

    if ((ratingDelta !== null && ratingDelta >= 0.1) || (countDelta !== null && countDelta >= 5)) {
      await insertChangeEvent(sql, tenantId, {
        appId: app.appId, country: app.country,
        eventType: 'reviews_shifted',
        payload: { ratingBefore: baseRating, ratingAfter: currentRating, countBefore: baseCount, countAfter: currentCount },
      });
    }
  } catch (e) {
    console.error(`[tracking] review delta failed for ${tenantId}/${app.appId}:`, e);
  }
}
