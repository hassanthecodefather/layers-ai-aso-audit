import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import postgres from 'postgres';
import { runPgMigrations } from '../memory/pg-migrate';
import { ascRoutes } from './routes';

const TEST_URL =
  process.env.DATABASE_TEST_URL ?? 'postgresql://aso:aso@localhost:5432/aso_audit_test';

// Minimal Hono-like context for unit testing route handlers
function makeCtx(opts: {
  body?: unknown;
  tenantId?: string;
}) {
  return {
    req: {
      json: async () => opts.body ?? {},
      header: (name: string) =>
        name === 'Authorization' && opts.tenantId
          ? `Bearer FAKE_${opts.tenantId}`
          : undefined,
    },
    json: (body: unknown, status?: number) => ({ body, status: status ?? 200 }),
  };
}

// We mock getAuthenticatedTenantId to avoid needing real JWT
vi.mock('../auth/middleware', () => ({
  getAuthenticatedTenantId: (c: any) => {
    const h = c.req.header('Authorization') as string | undefined;
    if (!h?.startsWith('Bearer FAKE_')) return null;
    return h.slice('Bearer FAKE_'.length);
  },
}));

// We mock getPgSql to return a test sql instance
let testSql: postgres.Sql;
vi.mock('../memory', () => ({
  getPgSql: () => testSql,
}));

// We mock the versions-client to avoid making real ASC calls in tests
vi.mock('./versions-client', () => ({
  getAppStoreVersionsClient: () => ({
    getAppVersions: async () => ({ ok: true, value: [] }),
  }),
}));

describe('ASC settings routes', () => {
  const schema = `asc_routes_test_${Date.now()}`;

  beforeAll(async () => {
    process.env.ASC_ENCRYPTION_KEY = Buffer.alloc(32, 'k').toString('base64');
    testSql = postgres(TEST_URL, { connection: { search_path: schema } });
    await testSql`CREATE SCHEMA IF NOT EXISTS ${testSql(schema)}`;
    await runPgMigrations(testSql);
  });

  afterAll(async () => {
    await testSql`DROP SCHEMA IF EXISTS ${testSql(schema)} CASCADE`;
    await testSql.end();
  });

  it('GET /api/settings/asc returns connected:false when no credentials', async () => {
    const route = ascRoutes.find((r: any) => r.path === '/settings/asc' && r.method === 'GET');
    const ctx = makeCtx({ tenantId: 'get-test' });
    const res = await (route as any).handler(ctx);
    expect(res.body).toEqual({ connected: false, keyId: null });
  });

  it('PUT /api/settings/asc stores credentials', async () => {
    const putRoute = ascRoutes.find((r: any) => r.path === '/settings/asc' && r.method === 'PUT');
    const ctx = makeCtx({
      tenantId: 'put-test',
      body: {
        keyId: 'K1',
        issuerId: 'I1',
        privateKey: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----',
      },
    });
    const res = await (putRoute as any).handler(ctx);
    expect(res.status).toBe(204);

    // Verify GET now returns connected
    const getRoute = ascRoutes.find((r: any) => r.path === '/settings/asc' && r.method === 'GET');
    const getCtx = makeCtx({ tenantId: 'put-test' });
    const getRes = await (getRoute as any).handler(getCtx);
    expect(getRes.body).toEqual({ connected: true, keyId: 'K1' });
  });

  it('DELETE /api/settings/asc removes credentials', async () => {
    // Seed
    const putRoute = ascRoutes.find((r: any) => r.path === '/settings/asc' && r.method === 'PUT');
    await (putRoute as any).handler(makeCtx({
      tenantId: 'del-test',
      body: { keyId: 'K', issuerId: 'I', privateKey: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----' },
    }));

    const delRoute = ascRoutes.find((r: any) => r.path === '/settings/asc' && r.method === 'DELETE');
    const res = await (delRoute as any).handler(makeCtx({ tenantId: 'del-test' }));
    expect(res.status).toBe(204);

    // Gone
    const getRoute = ascRoutes.find((r: any) => r.path === '/settings/asc' && r.method === 'GET');
    const getRes = await (getRoute as any).handler(makeCtx({ tenantId: 'del-test' }));
    expect(getRes.body).toEqual({ connected: false, keyId: null });
  });

  it('returns 401 when unauthenticated', async () => {
    const getRoute = ascRoutes.find((r: any) => r.path === '/settings/asc' && r.method === 'GET');
    const ctx = makeCtx({ tenantId: undefined });
    const res = await (getRoute as any).handler(ctx);
    expect(res.status).toBe(401);
  });
});
