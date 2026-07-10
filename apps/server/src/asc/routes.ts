import { registerApiRoute } from '@mastra/core/server';
import { getAuthenticatedTenantId } from '../auth/middleware';
import { getPgSql } from '../memory';
import { saveCredentials, loadCredentials, deleteCredentials } from './credential-store';

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
        skipValidation?: boolean;
      };

      if (!body.keyId?.trim() || !body.issuerId?.trim() || !body.privateKey?.trim()) {
        return c.json({ error: 'keyId, issuerId, and privateKey are required' }, 400);
      }

      // Validate credentials by making a real ASC call
      const { getAppStoreVersionsClient } = await import('./versions-client');
      const client = getAppStoreVersionsClient({
        keyId: body.keyId.trim(),
        issuerId: body.issuerId.trim(),
        privateKeyPem: body.privateKey.trim(),
      });
      const probe = await client.getAppVersions('497799835'); // Apple's own Pages app — always exists
      if (!probe.ok) {
        return c.json({
          error: `Credential validation failed: ${probe.error.kind}`,
        }, 422);
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
