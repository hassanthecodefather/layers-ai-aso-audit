import { registerApiRoute } from '@mastra/core/server';
import { getAuthenticatedTenantId } from '../auth/middleware';
import { getPgSql } from '../memory';
import { saveCredentials, loadCredentials, deleteCredentials } from './credential-store';
import { signAscToken } from './auth';
import { getGateway } from '../cost/gateway';

export const ascRoutes = [
  registerApiRoute('/settings/asc', {
    method: 'GET',
    handler: async (c) => {
      const tenantId = await getAuthenticatedTenantId(c);
      if (!tenantId) return c.json({ error: 'Unauthorized' }, 401);

      const sql = getPgSql();
      if (!sql) return c.json({ error: 'Database unavailable' }, 503);

      const result = await loadCredentials(sql, tenantId);
      if (!result.ok) return c.json({ error: 'Failed to load credentials' }, 500);

      if (!result.value) return c.json({ connected: false, keyId: null });
      return c.json({ connected: true, keyId: result.value.keyId });
    },
  }),

  registerApiRoute('/settings/asc', {
    method: 'PUT',
    handler: async (c) => {
      const tenantId = await getAuthenticatedTenantId(c);
      if (!tenantId) return c.json({ error: 'Unauthorized' }, 401);

      const sql = getPgSql();
      if (!sql) return c.json({ error: 'Database unavailable' }, 503);

      const body = await c.req.json().catch(() => ({})) as {
        keyId?: string;
        issuerId?: string;
        privateKey?: string;
      };

      if (!body.keyId?.trim() || !body.issuerId?.trim() || !body.privateKey?.trim()) {
        return c.json({ error: 'keyId, issuerId, and privateKey are required' }, 400);
      }

      // Validate credentials: GET /v1/apps?limit=1 works for any valid key regardless of which apps the tenant owns
      try {
        const token = signAscToken(body.keyId.trim(), body.issuerId.trim(), body.privateKey.trim());
        const probeRes = await getGateway().fetch(
          'https://api.appstoreconnect.apple.com/v1/apps?limit=1',
          { kind: 'app', upstream: 'asc' },
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (probeRes.status === 401 || probeRes.status === 403) {
          return c.json({ error: 'Credential validation failed: invalid key or permissions' }, 422);
        }
        if (!probeRes.ok) {
          return c.json({ error: `Credential validation failed: ASC returned ${probeRes.status}` }, 422);
        }
      } catch {
        return c.json({ error: 'Credential validation failed: could not reach App Store Connect' }, 422);
      }

      const saved = await saveCredentials(sql, tenantId, {
        keyId: body.keyId.trim(),
        issuerId: body.issuerId.trim(),
        privateKeyPem: body.privateKey.trim(),
      });
      if (!saved.ok) return c.json({ error: 'Failed to save credentials' }, 500);

      return new Response(null, { status: 204 });
    },
  }),

  registerApiRoute('/settings/asc', {
    method: 'DELETE',
    handler: async (c) => {
      const tenantId = await getAuthenticatedTenantId(c);
      if (!tenantId) return c.json({ error: 'Unauthorized' }, 401);

      const sql = getPgSql();
      if (!sql) return c.json({ error: 'Database unavailable' }, 503);

      const result = await deleteCredentials(sql, tenantId);
      if (!result.ok) return c.json({ error: 'Failed to delete credentials' }, 500);

      return new Response(null, { status: 204 });
    },
  }),
];
