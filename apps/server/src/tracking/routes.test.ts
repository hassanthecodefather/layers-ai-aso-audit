import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import postgres from 'postgres';
import { runPgMigrations } from '../memory/pg-migrate';
import { trackingRoutes } from './routes';
import { insertChangeEvent } from './store';

const TEST_URL = process.env.DATABASE_TEST_URL ?? 'postgresql://aso:aso@localhost:5432/aso_audit_test';

function makeCtx(opts: { body?: unknown; tenantId?: string; params?: Record<string, string>; query?: Record<string, string> }) {
  return {
    req: {
      json: async () => opts.body ?? {},
      header: (name: string) =>
        name === 'Authorization' && opts.tenantId ? `Bearer FAKE_${opts.tenantId}` : undefined,
      param: (key: string) => opts.params?.[key] ?? '',
      query: (key: string) => opts.query?.[key],
    },
    json: (body: unknown, status?: number) => ({ body, status: status ?? 200 }),
  };
}

vi.mock('../auth/middleware', () => ({
  getAuthenticatedTenantId: (c: any) => {
    const h = c.req.header('Authorization') as string | undefined;
    if (!h?.startsWith('Bearer FAKE_')) return null;
    return h.slice('Bearer FAKE_'.length);
  },
}));

let testSql: postgres.Sql;
vi.mock('../memory', () => ({ getPgSql: () => testSql }));

describe('tracking routes', () => {
  const schema = `tracking_routes_test_${Date.now()}`;

  beforeAll(async () => {
    testSql = postgres(TEST_URL, { connection: { search_path: schema } });
    await testSql`CREATE SCHEMA IF NOT EXISTS ${testSql(schema)}`;
    await runPgMigrations(testSql);
  });

  afterAll(async () => {
    await testSql`DROP SCHEMA IF EXISTS ${testSql(schema)} CASCADE`;
    await testSql.end();
  });

  it('POST /tracking creates a tracked app (201)', async () => {
    const route = trackingRoutes.find((r: any) => r.path === '/tracking' && r.method === 'POST');
    const ctx = makeCtx({
      tenantId: 'r-tenant1',
      body: { appId: '111', country: 'us', bundleId: 'com.test', appName: 'Test App', url: 'https://x' },
    });
    const res = await (route as any).handler(ctx);
    expect(res.status).toBe(201);
  });

  it('POST /tracking is idempotent', async () => {
    const route = trackingRoutes.find((r: any) => r.path === '/tracking' && r.method === 'POST');
    const body = { appId: '222', country: 'us', bundleId: '', appName: 'Idm', url: 'https://y' };
    await (route as any).handler(makeCtx({ tenantId: 'r-tenant2', body }));
    const res = await (route as any).handler(makeCtx({ tenantId: 'r-tenant2', body }));
    expect(res.status).toBe(201);
  });

  it('POST /tracking returns 400 when required fields missing', async () => {
    const route = trackingRoutes.find((r: any) => r.path === '/tracking' && r.method === 'POST');
    const res = await (route as any).handler(makeCtx({ tenantId: 'r-t', body: { appId: '333' } }));
    expect(res.status).toBe(400);
  });

  it('GET /tracking returns list of enabled apps', async () => {
    const postRoute = trackingRoutes.find((r: any) => r.path === '/tracking' && r.method === 'POST');
    await (postRoute as any).handler(makeCtx({
      tenantId: 'r-tenant3',
      body: { appId: '444', country: 'gb', bundleId: '', appName: 'GB App', url: 'https://gb' },
    }));
    const getRoute = trackingRoutes.find((r: any) => r.path === '/tracking' && r.method === 'GET');
    const res = await (getRoute as any).handler(makeCtx({ tenantId: 'r-tenant3' }));
    expect(res.body).toHaveLength(1);
    expect((res.body as any[])[0].appId).toBe('444');
  });

  it('DELETE /tracking/:appId disables the app', async () => {
    const postRoute = trackingRoutes.find((r: any) => r.path === '/tracking' && r.method === 'POST');
    await (postRoute as any).handler(makeCtx({
      tenantId: 'r-tenant4',
      body: { appId: '555', country: 'us', bundleId: '', appName: 'Del App', url: 'https://del' },
    }));
    const delRoute = trackingRoutes.find((r: any) => r.path === '/tracking/:appId' && r.method === 'DELETE');
    const res = await (delRoute as any).handler(makeCtx({ tenantId: 'r-tenant4', params: { appId: '555' } }));
    expect(res.status).toBe(204);

    const getRoute = trackingRoutes.find((r: any) => r.path === '/tracking' && r.method === 'GET');
    const getRes = await (getRoute as any).handler(makeCtx({ tenantId: 'r-tenant4' }));
    expect((getRes.body as any[])).toHaveLength(0);
  });

  it('GET /activity returns events without version_status', async () => {
    await insertChangeEvent(testSql, 'r-tenant5', {
      appId: 'ACT', country: 'us', eventType: 'version_status',
      payload: { versionString: '1.0', state: 'READY_FOR_SALE' },
    });
    await insertChangeEvent(testSql, 'r-tenant5', {
      appId: 'ACT', country: 'us', eventType: 'go_live',
      payload: { versionString: '1.0', appId: 'ACT', auditJobId: null },
    });

    const actRoute = trackingRoutes.find((r: any) => r.path === '/activity' && r.method === 'GET');
    const res = await (actRoute as any).handler(makeCtx({ tenantId: 'r-tenant5' }));
    expect((res.body as any[]).every((e: any) => e.eventType !== 'version_status')).toBe(true);
    expect(res.body).toHaveLength(1);
  });

  it('returns 401 when unauthenticated', async () => {
    const route = trackingRoutes.find((r: any) => r.path === '/tracking' && r.method === 'GET');
    const res = await (route as any).handler(makeCtx({}));
    expect(res.status).toBe(401);
  });
});
