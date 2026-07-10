import { registerApiRoute } from '@mastra/core/server';
import { getAuthenticatedTenantId } from '../auth/middleware';
import { getPgSql } from '../memory';
import { upsertTrackedApp, getTrackedApps, disableTrackedApp, getChangeEvents } from './store';

export const trackingRoutes = [
  registerApiRoute('/tracking', {
    method: 'POST',
    handler: async (c) => {
      const tenantId = await getAuthenticatedTenantId(c);
      if (!tenantId) return c.json({ error: 'Unauthorized' }, 401);
      const sql = getPgSql();
      if (!sql) return c.json({ error: 'Database unavailable' }, 503);

      const body = await c.req.json().catch(() => ({})) as {
        appId?: string; country?: string; bundleId?: string; appName?: string; url?: string;
      };

      if (!body.appId?.trim() || !body.appName?.trim() || !body.url?.trim()) {
        return c.json({ error: 'appId, appName, and url are required' }, 400);
      }

      await upsertTrackedApp(sql, tenantId, {
        appId: body.appId.trim(),
        country: (body.country ?? 'us').trim().toLowerCase(),
        bundleId: body.bundleId?.trim() ?? '',
        appName: body.appName.trim(),
        url: body.url.trim(),
      });
      return new Response(null, { status: 201 });
    },
  }),

  registerApiRoute('/tracking', {
    method: 'GET',
    handler: async (c) => {
      const tenantId = await getAuthenticatedTenantId(c);
      if (!tenantId) return c.json({ error: 'Unauthorized' }, 401);
      const sql = getPgSql();
      if (!sql) return c.json({ error: 'Database unavailable' }, 503);

      const apps = await getTrackedApps(sql, tenantId);
      return c.json(apps);
    },
  }),

  registerApiRoute('/tracking/:appId', {
    method: 'DELETE',
    handler: async (c) => {
      const tenantId = await getAuthenticatedTenantId(c);
      if (!tenantId) return c.json({ error: 'Unauthorized' }, 401);
      const sql = getPgSql();
      if (!sql) return c.json({ error: 'Database unavailable' }, 503);

      const appId = c.req.param('appId');
      await disableTrackedApp(sql, tenantId, appId);
      return new Response(null, { status: 204 });
    },
  }),

  registerApiRoute('/activity', {
    method: 'GET',
    handler: async (c) => {
      const tenantId = await getAuthenticatedTenantId(c);
      if (!tenantId) return c.json({ error: 'Unauthorized' }, 401);
      const sql = getPgSql();
      if (!sql) return c.json({ error: 'Database unavailable' }, 503);

      const limitRaw = c.req.query('limit') ?? '20';
      const beforeRaw = c.req.query('before');
      const limit = Math.min(Math.max(1, parseInt(limitRaw, 10) || 20), 50);
      const before = beforeRaw ? new Date(beforeRaw) : undefined;

      const events = await getChangeEvents(sql, tenantId, { limit, before });
      return c.json(events);
    },
  }),
];
