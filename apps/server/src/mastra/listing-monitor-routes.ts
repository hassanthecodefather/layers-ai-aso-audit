import { registerApiRoute } from '@mastra/core/server';
import { getAuthenticatedTenantId } from '../auth/middleware';
import { getPgSql } from '../memory';
import { getMonitorById, setMonitorClosed } from '../queue/listing-monitor-store';
import { getListingUpdateById } from '../queue/listing-update-store';
import { loadCredentials } from '../asc/credential-store';
import { pushListingUpdate } from '../asc/listing-writer';
import { insertChangeEvent } from '../tracking/store';

export const listingMonitorRoutes = [
  registerApiRoute('/listing-update/revert', {
    method: 'POST',
    handler: async (c) => {
      const tenantId = await getAuthenticatedTenantId(c);
      if (!tenantId) return c.json({ error: 'Unauthorized' }, 401);
      const sql = getPgSql();
      if (!sql) return c.json({ error: 'Database not configured.' }, 503);

      const body = await c.req.json().catch(() => ({}));
      const monitorId = typeof body?.monitorId === 'string' ? body.monitorId.trim() : '';
      if (!monitorId) return c.json({ error: 'Missing monitorId.' }, 400);

      try {
        const monitor = await getMonitorById(sql, tenantId, monitorId);
        if (!monitor) return c.json({ error: 'Monitor not found.' }, 404);
        if (monitor.status !== 'alerted') return c.json({ error: 'Monitor is not in alerted status.' }, 400);

        const update = await getListingUpdateById(sql, tenantId, monitor.listingUpdateId);
        if (!update) return c.json({ error: 'Listing update not found.' }, 404);
        if (!update.previousFields) return c.json({ error: 'No previous field values stored — cannot revert automatically.' }, 400);
        if (!update.ascLocalizationId) return c.json({ error: 'No ASC localization ID on this update.' }, 400);

        const credsResult = await loadCredentials(sql, tenantId);
        if (!credsResult.ok || !credsResult.value) return c.json({ error: 'ASC credentials not configured.' }, 400);

        const pushResult = await pushListingUpdate(credsResult.value, update.ascLocalizationId, update.previousFields);
        if (!pushResult.ok) return c.json({ error: `ASC revert failed: ${pushResult.error}` }, 502);

        await setMonitorClosed(sql, monitorId);
        await insertChangeEvent(sql, tenantId, {
          appId: monitor.appId,
          country: 'us',
          eventType: 'listing_update_reverted',
          payload: { monitorId, listingUpdateId: monitor.listingUpdateId },
        });

        return c.json({ ok: true });
      } catch (e) {
        console.error('[listing-update/revert] failed:', e);
        return c.json({ error: 'Revert failed.' }, 500);
      }
    },
  }),

  registerApiRoute('/listing-update/dismiss-alert', {
    method: 'POST',
    handler: async (c) => {
      const tenantId = await getAuthenticatedTenantId(c);
      if (!tenantId) return c.json({ error: 'Unauthorized' }, 401);
      const sql = getPgSql();
      if (!sql) return c.json({ error: 'Database not configured.' }, 503);

      const body = await c.req.json().catch(() => ({}));
      const monitorId = typeof body?.monitorId === 'string' ? body.monitorId.trim() : '';
      if (!monitorId) return c.json({ error: 'Missing monitorId.' }, 400);

      try {
        const monitor = await getMonitorById(sql, tenantId, monitorId);
        if (!monitor) return c.json({ error: 'Monitor not found.' }, 404);
        if (monitor.status !== 'alerted') return c.json({ error: 'Monitor is not in alerted status.' }, 400);

        await setMonitorClosed(sql, monitorId);
        return c.json({ ok: true });
      } catch (e) {
        console.error('[listing-update/dismiss-alert] failed:', e);
        return c.json({ error: 'Dismiss failed.' }, 500);
      }
    },
  }),
];
