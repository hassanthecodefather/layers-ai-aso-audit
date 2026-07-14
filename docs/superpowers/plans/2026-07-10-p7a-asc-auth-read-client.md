# P7-A: ASC Auth + Read Client — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build App Store Connect read access end-to-end — per-tenant encrypted credential storage, a settings modal to connect/disconnect, JWT signing, version-status reads, and a two-phase async analytics reports client.

**Architecture:** A new `apps/server/src/asc/` module holds five files: shared types, pure JWT signing, credential store (AES-256-GCM + Postgres), settings API routes, versions client, and analytics client. The web app gains an `AscSettings` modal in the header. All server HTTP calls route through the existing `getGateway()`. All functions return `Result<T, AscError>` — no throws.

**Tech Stack:** Node ≥ 20 (built-in `crypto` for AES + JWT), TypeScript, Vitest, `postgres` (tagged-template SQL), Mastra `registerApiRoute`, React (inline styles — no CSS framework).

## Global Constraints

- Node ≥ 20.9.0 — run `nvm use 24` before any `npm` command
- Run tests from the monorepo root with `cd apps/server && nvm use 24 && npm test`
- All tables namespaced `aso_` — never create a table without the prefix
- All server functions return `Result<T, E>` from `../domain/result` — no throws across module boundaries
- `ok`, `err` helpers from `../domain/result` — never construct `{ ok: true, value: ... }` by hand
- HTTP calls use `getGateway().fetch(url, { kind, upstream }, init)` — never raw `fetch`
- Auth in routes: `const tenantId = await getAuthenticatedTenantId(c); if (!tenantId) return c.json({ error: 'Unauthorized' }, 401);`
- Postgres tests: use `DATABASE_TEST_URL` (defaults to `postgresql://aso:aso@localhost:5432/aso_audit_test`); create a unique schema per test; drop it in `afterAll`
- No mocking of the `postgres` SQL client — use a real test DB
- Web components: inline styles only (no Tailwind/CSS classes beyond what already exists in App.tsx)
- No new npm packages without explicit approval

---

### Task 1: Types + JWT signing + env var

**Files:**
- Create: `apps/server/src/asc/types.ts`
- Create: `apps/server/src/asc/auth.ts`
- Create: `apps/server/src/asc/auth.test.ts`
- Modify: `apps/server/src/env.ts`

**Interfaces:**
- Produces: `AscError`, `AppVersion`, `ReportType`, `ReportFilters`, `ReportRow`, `ReportPollResult` (all from `./types`); `signAscToken(keyId, issuerId, privateKeyPem): string` (from `./auth`)

---

- [ ] **Step 1: Write the failing test**

`apps/server/src/asc/auth.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { signAscToken } from './auth';

function testPem(): { pem: string; b64: string } {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  return { pem, b64: Buffer.from(pem).toString('base64') };
}

describe('signAscToken', () => {
  it('produces a 3-part JWT', () => {
    const { pem } = testPem();
    const token = signAscToken('KID1', 'ISS1', pem);
    expect(token.split('.')).toHaveLength(3);
  });

  it('encodes correct header claims', () => {
    const { pem } = testPem();
    const [h] = signAscToken('MY_KEY', 'MY_ISSUER', pem).split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    expect(header).toEqual({ alg: 'ES256', kid: 'MY_KEY', typ: 'JWT' });
  });

  it('encodes correct payload claims', () => {
    const { pem } = testPem();
    const [, p] = signAscToken('k', 'iss42', pem).split('.');
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(payload.iss).toBe('iss42');
    expect(payload.aud).toBe('appstoreconnect-v1');
    expect(payload.exp - payload.iat).toBe(1200);
  });

  it('accepts base64-encoded key and produces a valid JWT', () => {
    const { pem } = testPem();
    const b64 = Buffer.from(pem).toString('base64');
    const token = signAscToken('k', 'i', b64);
    expect(token.split('.')).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/server && nvm use 24 && npm test -- asc/auth
```
Expected: `Error: Cannot find module './auth'`

- [ ] **Step 3: Create `apps/server/src/asc/types.ts`**

```ts
export type AscError =
  | { kind: 'auth_failed';    status: number }
  | { kind: 'not_found';      appId: string }
  | { kind: 'rate_limited';   retryAfterMs: number }
  | { kind: 'api_error';      status: number; detail: string }
  | { kind: 'parse_error';    raw: string }
  | { kind: 'no_credentials'; tenantId: string };

export type AppVersion = {
  versionString: string;
  state: string;
  createdDate: string;
  earliestReleaseDate: string | null;
};

export type ReportType = 'APP_STORE_ENGAGEMENT';

export type ReportFilters = {
  appId: string;
  frequency: 'DAILY';
  startDate: string;
  endDate: string;
};

export type ReportRow = {
  date: string;
  impressions: number;
  downloads: number;
  conversionRate: number;
  territory: string;
};

export type ReportPollResult =
  | { status: 'pending' }
  | { status: 'ready'; rows: ReportRow[] };
```

- [ ] **Step 4: Create `apps/server/src/asc/auth.ts`**

```ts
import { createSign } from 'node:crypto';

function resolveKey(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('-----BEGIN')) return trimmed;
  return Buffer.from(trimmed, 'base64').toString('utf8').trim();
}

export function signAscToken(
  keyId: string,
  issuerId: string,
  privateKeyPem: string,
): string {
  const key = resolveKey(privateKeyPem);
  const iat = Math.floor(Date.now() / 1000);

  const header = Buffer.from(
    JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }),
  ).toString('base64url');

  const payload = Buffer.from(
    JSON.stringify({ iss: issuerId, iat, exp: iat + 1200, aud: 'appstoreconnect-v1' }),
  ).toString('base64url');

  const unsigned = `${header}.${payload}`;
  const sign = createSign('SHA256');
  sign.update(unsigned);
  // ES256 requires IEEE P1363 (raw r||s), not DER
  const sig = sign.sign({ key, dsaEncoding: 'ieee-p1363' });
  return `${unsigned}.${sig.toString('base64url')}`;
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd apps/server && nvm use 24 && npm test -- asc/auth
```
Expected: `4 tests passed`

- [ ] **Step 6: Add `ASC_ENCRYPTION_KEY` to `apps/server/src/env.ts`**

In the `REQUIRED` object, add:
```ts
ASC_ENCRYPTION_KEY: '32-byte base64 key for AES-256-GCM encryption of ASC private keys (generate: openssl rand -base64 32)',
```

The full updated `REQUIRED` block:
```ts
const REQUIRED: Record<string, string> = {
  DATABASE_URL: 'Postgres connection string (e.g. postgres://user:pass@host:5432/db)',
  ASO_JWT_SECRET: 'Secret key for signing JWT access tokens (min 32 chars)',
  APP_KITTI_API_KEY: 'AppKittie API key — required for identity-grounded competitor discovery (D3)',
  FIRECRAWL_API_KEY: 'Firecrawl API key — required for App Store page crawling (subtitle, screenshots)',
  ASC_ENCRYPTION_KEY: '32-byte base64 key for AES-256-GCM encryption of ASC private keys (generate: openssl rand -base64 32)',
};
```

- [ ] **Step 7: Add `ASC_ENCRYPTION_KEY` to your `.env` file**

Generate a key and add it:
```bash
openssl rand -base64 32
# Copy the output and add to .env:
# ASC_ENCRYPTION_KEY=<paste here>
```

- [ ] **Step 8: Run full test suite to confirm nothing broke**

```bash
cd apps/server && nvm use 24 && npm test
```
Expected: all pre-existing tests still pass (env validation tests skip in `NODE_ENV=test`)

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/asc/types.ts apps/server/src/asc/auth.ts apps/server/src/asc/auth.test.ts apps/server/src/env.ts
git commit -m "feat(p7a): ASC types, JWT signing, ASC_ENCRYPTION_KEY env var"
```

---

### Task 2: Credential store + DB migration

**Files:**
- Create: `apps/server/src/asc/credential-store.ts`
- Create: `apps/server/src/asc/credential-store.test.ts`
- Modify: `apps/server/src/memory/pg-migrate.ts`

**Interfaces:**
- Consumes: `AscError` from `./types`; `Result`, `ok`, `err` from `../domain/result`
- Produces:
  ```ts
  interface AscCredentials { keyId: string; issuerId: string; privateKeyPem: string; }
  saveCredentials(sql, tenantId, creds): Promise<Result<void, AscError>>
  loadCredentials(sql, tenantId): Promise<Result<AscCredentials | null, AscError>>
  deleteCredentials(sql, tenantId): Promise<Result<void, AscError>>
  ```

---

- [ ] **Step 1: Write failing tests**

`apps/server/src/asc/credential-store.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import { runPgMigrations } from '../memory/pg-migrate';
import { saveCredentials, loadCredentials, deleteCredentials } from './credential-store';

const TEST_URL =
  process.env.DATABASE_TEST_URL ?? 'postgresql://aso:aso@localhost:5432/aso_audit_test';

describe('credential-store', () => {
  let sql: postgres.Sql;
  const schema = `asc_cred_test_${Date.now()}`;

  beforeAll(async () => {
    sql = postgres(TEST_URL, { connection: { search_path: schema } });
    await sql`CREATE SCHEMA IF NOT EXISTS ${sql(schema)}`;
    await runPgMigrations(sql);
    process.env.ASC_ENCRYPTION_KEY = Buffer.alloc(32, 'k').toString('base64');
  });

  afterAll(async () => {
    await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`;
    await sql.end();
  });

  it('saves and loads credentials with round-trip encryption', async () => {
    const creds = { keyId: 'K1', issuerId: 'I1', privateKeyPem: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----' };
    const saved = await saveCredentials(sql, 'tenant-1', creds);
    expect(saved.ok).toBe(true);

    const loaded = await loadCredentials(sql, 'tenant-1');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value).toEqual(creds);
  });

  it('returns null for a tenant with no credentials', async () => {
    const result = await loadCredentials(sql, 'tenant-unknown');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it('upserts on second save (same tenant)', async () => {
    await saveCredentials(sql, 'tenant-upsert', { keyId: 'K1', issuerId: 'I1', privateKeyPem: '-----BEGIN PRIVATE KEY-----\nv1\n-----END PRIVATE KEY-----' });
    await saveCredentials(sql, 'tenant-upsert', { keyId: 'K2', issuerId: 'I2', privateKeyPem: '-----BEGIN PRIVATE KEY-----\nv2\n-----END PRIVATE KEY-----' });

    const loaded = await loadCredentials(sql, 'tenant-upsert');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value?.keyId).toBe('K2');
  });

  it('normalizes base64-encoded PEM key on save', async () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nbase64test\n-----END PRIVATE KEY-----';
    const b64 = Buffer.from(pem).toString('base64');
    await saveCredentials(sql, 'tenant-b64', { keyId: 'K', issuerId: 'I', privateKeyPem: b64 });

    const loaded = await loadCredentials(sql, 'tenant-b64');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value?.privateKeyPem).toBe(pem);
  });

  it('deletes credentials', async () => {
    await saveCredentials(sql, 'tenant-del', { keyId: 'K', issuerId: 'I', privateKeyPem: '-----BEGIN PRIVATE KEY-----\n\n-----END PRIVATE KEY-----' });
    await deleteCredentials(sql, 'tenant-del');
    const loaded = await loadCredentials(sql, 'tenant-del');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/server && nvm use 24 && npm test -- asc/credential-store
```
Expected: `Error: Cannot find module './credential-store'`

- [ ] **Step 3: Add migration to `apps/server/src/memory/pg-migrate.ts`**

In `PG_ONLY_MIGRATIONS`, append after the last migration entry (before the closing `]`):
```ts
  // Phase P7-A: per-tenant App Store Connect credentials (encrypted)
  `CREATE TABLE IF NOT EXISTS aso_asc_credentials (
    tenant_id        TEXT PRIMARY KEY,
    key_id           TEXT NOT NULL,
    issuer_id        TEXT NOT NULL,
    private_key_enc  TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
```

- [ ] **Step 4: Create `apps/server/src/asc/credential-store.ts`**

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type postgres from 'postgres';
import { ok, err } from '../domain/result';
import type { Result } from '../domain/result';
import type { AscError } from './types';

export interface AscCredentials {
  keyId: string;
  issuerId: string;
  privateKeyPem: string;
}

function encryptionKey(): Buffer {
  const raw = process.env.ASC_ENCRYPTION_KEY?.trim() ?? '';
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('ASC_ENCRYPTION_KEY must be a 32-byte base64 string');
  return buf;
}

function encrypt(plaintext: string): string {
  const key = encryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

function decrypt(stored: string): string {
  const parts = stored.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted credential format');
  const [ivB64, tagB64, ctB64] = parts;
  const key = encryptionKey();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return decipher.update(Buffer.from(ctB64, 'base64')) + decipher.final('utf8');
}

function normalizePem(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('-----BEGIN')) return trimmed;
  return Buffer.from(trimmed, 'base64').toString('utf8').trim();
}

export async function saveCredentials(
  sql: postgres.Sql,
  tenantId: string,
  creds: AscCredentials,
): Promise<Result<void, AscError>> {
  try {
    const pem = normalizePem(creds.privateKeyPem);
    const enc = encrypt(pem);
    const now = new Date().toISOString();
    await sql`
      INSERT INTO aso_asc_credentials (tenant_id, key_id, issuer_id, private_key_enc, created_at, updated_at)
      VALUES (${tenantId}, ${creds.keyId}, ${creds.issuerId}, ${enc}, ${now}, ${now})
      ON CONFLICT (tenant_id) DO UPDATE
        SET key_id         = EXCLUDED.key_id,
            issuer_id      = EXCLUDED.issuer_id,
            private_key_enc = EXCLUDED.private_key_enc,
            updated_at     = EXCLUDED.updated_at
    `;
    return ok(undefined);
  } catch (e) {
    return err({ kind: 'api_error', status: 500, detail: String(e) });
  }
}

export async function loadCredentials(
  sql: postgres.Sql,
  tenantId: string,
): Promise<Result<AscCredentials | null, AscError>> {
  try {
    const rows = await sql<{ key_id: string; issuer_id: string; private_key_enc: string }[]>`
      SELECT key_id, issuer_id, private_key_enc
      FROM aso_asc_credentials
      WHERE tenant_id = ${tenantId}
    `;
    if (rows.length === 0) return ok(null);
    const row = rows[0];
    return ok({
      keyId: row.key_id,
      issuerId: row.issuer_id,
      privateKeyPem: decrypt(row.private_key_enc),
    });
  } catch (e) {
    return err({ kind: 'api_error', status: 500, detail: String(e) });
  }
}

export async function deleteCredentials(
  sql: postgres.Sql,
  tenantId: string,
): Promise<Result<void, AscError>> {
  try {
    await sql`DELETE FROM aso_asc_credentials WHERE tenant_id = ${tenantId}`;
    return ok(undefined);
  } catch (e) {
    return err({ kind: 'api_error', status: 500, detail: String(e) });
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd apps/server && nvm use 24 && npm test -- asc/credential-store
```
Expected: `5 tests passed`

- [ ] **Step 6: Verify migration test still passes**

```bash
cd apps/server && nvm use 24 && npm test -- pg-migrate
```
Expected: tests pass (including the new `aso_asc_credentials` table check — add that assertion if it's missing):

In `pg-migrate.test.ts`, add:
```ts
it('creates aso_asc_credentials', async () => {
  const rows = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = ${schema} AND table_name = 'aso_asc_credentials'
  `;
  expect(rows).toHaveLength(1);
});
```

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/asc/credential-store.ts apps/server/src/asc/credential-store.test.ts apps/server/src/memory/pg-migrate.ts apps/server/src/memory/pg-migrate.test.ts
git commit -m "feat(p7a): credential store — AES-256-GCM encrypted per-tenant ASC keys"
```

---

### Task 3: Settings API routes

**Files:**
- Create: `apps/server/src/asc/routes.ts`
- Create: `apps/server/src/asc/routes.test.ts`
- Modify: `apps/server/src/mastra/index.ts`
- Modify: `apps/server/src/cost/gateway.ts`

**Interfaces:**
- Consumes: `saveCredentials`, `loadCredentials`, `deleteCredentials`, `AscCredentials` from `./credential-store`; `getAuthenticatedTenantId` from `../auth/middleware`; `getPgSql` from `../memory`; `AppleAppStoreVersionsClient` from `./versions-client` (for validation — Task 4 must be done first OR this step deferred to after Task 4)
- Produces: `ascRoutes` (array of Mastra route registrations) exported for `mastra/index.ts`

> **Note:** Task 3 Step 3 (connect-validation call) requires the versions client from Task 4. Complete Tasks 3 Steps 1–2 and 4–7 now, then add the validation call after Task 4 is done.

---

- [ ] **Step 1: Add `'asc'` to `UpstreamKind` in `apps/server/src/cost/gateway.ts`**

Find the line:
```ts
export type UpstreamKind = 'itunes' | 'competitors' | 'crawler' | 'reviews' | 'vision' | 'appkittie' | 'embedding' | 'websearch';
```
Change it to:
```ts
export type UpstreamKind = 'itunes' | 'competitors' | 'crawler' | 'reviews' | 'vision' | 'appkittie' | 'embedding' | 'websearch' | 'asc';
```

- [ ] **Step 2: Write failing tests**

`apps/server/src/asc/routes.test.ts`:
```ts
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
        skipValidation: true,   // test-only flag to skip the live ASC call
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
      body: { keyId: 'K', issuerId: 'I', privateKey: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----', skipValidation: true },
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
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd apps/server && nvm use 24 && npm test -- asc/routes
```
Expected: `Error: Cannot find module './routes'`

- [ ] **Step 4: Create `apps/server/src/asc/routes.ts`**

```ts
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

      if (!body.skipValidation) {
        // Validate credentials by making a real ASC call (see Task 4 for the client)
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
```

- [ ] **Step 5: Register `ascRoutes` in `apps/server/src/mastra/index.ts`**

Add the import at the top:
```ts
import { ascRoutes } from '../asc/routes';
```

Update the `apiRoutes` line from:
```ts
    apiRoutes: [...auditRoutes, ...authRoutes, ...healthRoutes, ...getWebStaticRoutes()],
```
to:
```ts
    apiRoutes: [...auditRoutes, ...authRoutes, ...healthRoutes, ...ascRoutes, ...getWebStaticRoutes()],
```

- [ ] **Step 6: Run tests**

```bash
cd apps/server && nvm use 24 && npm test -- asc/routes
```
Expected: `4 tests passed`

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/asc/routes.ts apps/server/src/asc/routes.test.ts apps/server/src/mastra/index.ts apps/server/src/cost/gateway.ts
git commit -m "feat(p7a): ASC settings API — PUT/GET/DELETE /api/settings/asc"
```

---

### Task 4: Versions client

**Files:**
- Create: `apps/server/src/asc/versions-client.ts`
- Create: `apps/server/src/asc/versions-client.test.ts`

**Interfaces:**
- Consumes: `signAscToken` from `./auth`; `AppVersion`, `AscError` from `./types`; `AscCredentials` from `./credential-store`; `Result`, `ok`, `err` from `../domain/result`; `getGateway` from `../cost/gateway`
- Produces:
  ```ts
  interface AppStoreVersionsClient {
    getAppVersions(appId: string): Promise<Result<AppVersion[], AscError>>;
  }
  class AppleAppStoreVersionsClient implements AppStoreVersionsClient
  class StubAppStoreVersionsClient implements AppStoreVersionsClient
  class NoOpAppStoreVersionsClient implements AppStoreVersionsClient
  function getAppStoreVersionsClient(creds: AscCredentials): AppStoreVersionsClient
  ```

---

- [ ] **Step 1: Write failing tests**

`apps/server/src/asc/versions-client.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { StubAppStoreVersionsClient, NoOpAppStoreVersionsClient } from './versions-client';

describe('StubAppStoreVersionsClient', () => {
  it('returns canned AppVersion list', async () => {
    const stub = new StubAppStoreVersionsClient([
      { versionString: '2.1.0', state: 'READY_FOR_SALE', createdDate: '2026-01-01T00:00:00Z', earliestReleaseDate: null },
    ]);
    const result = await stub.getAppVersions('any');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0].versionString).toBe('2.1.0');
    expect(result.value[0].state).toBe('READY_FOR_SALE');
  });
});

describe('NoOpAppStoreVersionsClient', () => {
  it('returns empty array', async () => {
    const noop = new NoOpAppStoreVersionsClient();
    const result = await noop.getAppVersions('any');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });
});

// Live smoke test — only runs when real creds are present
const LIVE = process.env.ASC_KEY_ID && process.env.ASC_ISSUER_ID && process.env.ASC_PRIVATE_KEY;
describe.skipIf(!LIVE)('AppleAppStoreVersionsClient (live)', () => {
  it('returns versions for a real app', async () => {
    const { getAppStoreVersionsClient } = await import('./versions-client');
    const client = getAppStoreVersionsClient({
      keyId: process.env.ASC_KEY_ID!,
      issuerId: process.env.ASC_ISSUER_ID!,
      privateKeyPem: process.env.ASC_PRIVATE_KEY!,
    });
    // Apple Pages app — always exists in the App Store
    const result = await client.getAppVersions('361309726');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeGreaterThan(0);
    expect(result.value[0].state).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/server && nvm use 24 && npm test -- asc/versions-client
```
Expected: `Error: Cannot find module './versions-client'`

- [ ] **Step 3: Create `apps/server/src/asc/versions-client.ts`**

```ts
import { signAscToken } from './auth';
import { getGateway } from '../cost/gateway';
import { ok, err } from '../domain/result';
import type { Result } from '../domain/result';
import type { AppVersion, AscError } from './types';
import type { AscCredentials } from './credential-store';

const ASC_BASE = 'https://api.appstoreconnect.apple.com';

export interface AppStoreVersionsClient {
  getAppVersions(appId: string): Promise<Result<AppVersion[], AscError>>;
}

export class AppleAppStoreVersionsClient implements AppStoreVersionsClient {
  constructor(private readonly creds: AscCredentials) {}

  async getAppVersions(appId: string): Promise<Result<AppVersion[], AscError>> {
    const token = signAscToken(this.creds.keyId, this.creds.issuerId, this.creds.privateKeyPem);
    const url = `${ASC_BASE}/v1/apps/${encodeURIComponent(appId)}/appStoreVersions?filter[platform]=IOS&sort=-createdDate&limit=10`;

    let response: Response;
    try {
      response = await getGateway().fetch(url, { kind: 'app', upstream: 'asc' }, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (e) {
      return err({ kind: 'api_error', status: 0, detail: String(e) });
    }

    if (response.status === 401 || response.status === 403) {
      return err({ kind: 'auth_failed', status: response.status });
    }
    if (response.status === 404) {
      return err({ kind: 'not_found', appId });
    }
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      return err({ kind: 'rate_limited', retryAfterMs: retryAfter ? Number(retryAfter) * 1000 : 60_000 });
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return err({ kind: 'api_error', status: response.status, detail: detail.slice(0, 200) });
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      return err({ kind: 'parse_error', raw: 'non-JSON response' });
    }

    return ok(parseVersions(data));
  }
}

function parseVersions(data: unknown): AppVersion[] {
  const d = data as { data?: unknown[] };
  if (!Array.isArray(d?.data)) return [];
  return d.data.map((item: unknown) => {
    const i = item as { attributes?: Record<string, unknown> };
    const a = i?.attributes ?? {};
    return {
      versionString: typeof a['versionString'] === 'string' ? a['versionString'] : '',
      state: typeof a['appStoreState'] === 'string' ? a['appStoreState'] : '',
      createdDate: typeof a['createdDate'] === 'string' ? a['createdDate'] : '',
      earliestReleaseDate: typeof a['earliestReleaseDate'] === 'string' ? a['earliestReleaseDate'] : null,
    };
  });
}

export class StubAppStoreVersionsClient implements AppStoreVersionsClient {
  constructor(private readonly versions: AppVersion[]) {}
  async getAppVersions(_appId: string): Promise<Result<AppVersion[], AscError>> {
    return ok(this.versions);
  }
}

export class NoOpAppStoreVersionsClient implements AppStoreVersionsClient {
  async getAppVersions(_appId: string): Promise<Result<AppVersion[], AscError>> {
    return ok([]);
  }
}

export function getAppStoreVersionsClient(creds: AscCredentials): AppStoreVersionsClient {
  return new AppleAppStoreVersionsClient(creds);
}
```

- [ ] **Step 4: Run tests**

```bash
cd apps/server && nvm use 24 && npm test -- asc/versions-client
```
Expected: `2 tests passed` (Stub + NoOp; live test skipped if no env vars)

- [ ] **Step 5: Run live smoke test (requires creds in `.env`)**

```bash
cd apps/server && ASC_KEY_ID=<your-key-id> ASC_ISSUER_ID=<your-issuer-id> ASC_PRIVATE_KEY="$(cat path/to/key.p8)" nvm use 24 && npm test -- asc/versions-client
```
Expected: `3 tests passed`. If Apple's response shape differs from what `parseVersions` expects, adjust the field names (`appStoreState`, `createdDate`, etc.) based on the real response.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/asc/versions-client.ts apps/server/src/asc/versions-client.test.ts
git commit -m "feat(p7a): AppStoreVersionsClient — sync version-status reads from ASC"
```

---

### Task 5: Analytics client

**Files:**
- Create: `apps/server/src/asc/analytics-client.ts`
- Create: `apps/server/src/asc/analytics-client.test.ts`

**Interfaces:**
- Consumes: `signAscToken` from `./auth`; `ReportType`, `ReportFilters`, `ReportRow`, `ReportPollResult`, `AscError` from `./types`; `AscCredentials` from `./credential-store`; `Result`, `ok`, `err` from `../domain/result`; `getGateway` from `../cost/gateway`
- Produces:
  ```ts
  interface AscAnalyticsClient {
    createReportRequest(type: ReportType, filters: ReportFilters): Promise<Result<string, AscError>>;
    pollReportInstance(requestId: string): Promise<Result<ReportPollResult, AscError>>;
  }
  class AppleAscAnalyticsClient implements AscAnalyticsClient
  class StubAscAnalyticsClient implements AscAnalyticsClient
  class NoOpAscAnalyticsClient implements AscAnalyticsClient
  function getAscAnalyticsClient(creds: AscCredentials): AscAnalyticsClient
  ```

---

- [ ] **Step 1: Write failing tests**

`apps/server/src/asc/analytics-client.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { StubAscAnalyticsClient, NoOpAscAnalyticsClient } from './analytics-client';
import type { ReportRow } from './types';

const ROWS: ReportRow[] = [
  { date: '2026-07-01', impressions: 1200, downloads: 80, conversionRate: 0.067, territory: 'US' },
];

describe('StubAscAnalyticsClient', () => {
  it('createReportRequest returns a requestId', async () => {
    const stub = new StubAscAnalyticsClient(ROWS);
    const result = await stub.createReportRequest('APP_STORE_ENGAGEMENT', {
      appId: '123', frequency: 'DAILY', startDate: '2026-07-01', endDate: '2026-07-07',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.value).toBe('string');
  });

  it('pollReportInstance returns ready with rows', async () => {
    const stub = new StubAscAnalyticsClient(ROWS);
    const created = await stub.createReportRequest('APP_STORE_ENGAGEMENT', {
      appId: '123', frequency: 'DAILY', startDate: '2026-07-01', endDate: '2026-07-07',
    });
    if (!created.ok) throw new Error('create failed');
    const result = await stub.pollReportInstance(created.value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('ready');
    if (result.value.status !== 'ready') return;
    expect(result.value.rows).toEqual(ROWS);
  });
});

describe('NoOpAscAnalyticsClient', () => {
  it('createReportRequest returns a fake id', async () => {
    const noop = new NoOpAscAnalyticsClient();
    const result = await noop.createReportRequest('APP_STORE_ENGAGEMENT', {
      appId: '123', frequency: 'DAILY', startDate: '2026-07-01', endDate: '2026-07-07',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe('noop-request-id');
  });

  it('pollReportInstance always returns pending', async () => {
    const noop = new NoOpAscAnalyticsClient();
    const result = await noop.pollReportInstance('any-id');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('pending');
  });
});

const LIVE = process.env.ASC_KEY_ID && process.env.ASC_ISSUER_ID && process.env.ASC_PRIVATE_KEY;
describe.skipIf(!LIVE)('AppleAscAnalyticsClient (live)', () => {
  it('createReportRequest returns a real requestId from Apple', async () => {
    const { getAscAnalyticsClient } = await import('./analytics-client');
    const client = getAscAnalyticsClient({
      keyId: process.env.ASC_KEY_ID!,
      issuerId: process.env.ASC_ISSUER_ID!,
      privateKeyPem: process.env.ASC_PRIVATE_KEY!,
    });
    // Use your own app ID from ASC
    const appId = process.env.ASC_TEST_APP_ID ?? '0000000000';
    const result = await client.createReportRequest('APP_STORE_ENGAGEMENT', {
      appId,
      frequency: 'DAILY',
      startDate: '2026-07-01',
      endDate: '2026-07-07',
    });
    // Log the raw result so we can inspect Apple's actual response shape
    console.log('[live] createReportRequest result:', JSON.stringify(result));
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/server && nvm use 24 && npm test -- asc/analytics-client
```
Expected: `Error: Cannot find module './analytics-client'`

- [ ] **Step 3: Create `apps/server/src/asc/analytics-client.ts`**

```ts
import { signAscToken } from './auth';
import { getGateway } from '../cost/gateway';
import { ok, err } from '../domain/result';
import type { Result } from '../domain/result';
import type { ReportType, ReportFilters, ReportRow, ReportPollResult, AscError } from './types';
import type { AscCredentials } from './credential-store';

const ASC_BASE = 'https://api.appstoreconnect.apple.com';

export interface AscAnalyticsClient {
  createReportRequest(type: ReportType, filters: ReportFilters): Promise<Result<string, AscError>>;
  pollReportInstance(requestId: string): Promise<Result<ReportPollResult, AscError>>;
}

export class AppleAscAnalyticsClient implements AscAnalyticsClient {
  constructor(private readonly creds: AscCredentials) {}

  async createReportRequest(
    type: ReportType,
    filters: ReportFilters,
  ): Promise<Result<string, AscError>> {
    const token = signAscToken(this.creds.keyId, this.creds.issuerId, this.creds.privateKeyPem);
    const url = `${ASC_BASE}/v1/analyticsReportRequests`;

    let response: Response;
    try {
      response = await getGateway().fetch(url, { kind: 'app', upstream: 'asc' }, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          data: {
            type: 'analyticsReportRequests',
            attributes: {
              accessType: 'ONE_TIME',
              stoppedDueToPrivacy: false,
            },
            relationships: {
              apps: {
                data: [{ type: 'apps', id: filters.appId }],
              },
            },
          },
        }),
      });
    } catch (e) {
      return err({ kind: 'api_error', status: 0, detail: String(e) });
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return err({ kind: 'auth_failed', status: response.status });
      }
      const detail = await response.text().catch(() => '');
      return err({ kind: 'api_error', status: response.status, detail: detail.slice(0, 200) });
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      return err({ kind: 'parse_error', raw: 'non-JSON response from createReportRequest' });
    }

    const requestId = (data as { data?: { id?: string } })?.data?.id;
    if (!requestId) {
      return err({ kind: 'parse_error', raw: JSON.stringify(data).slice(0, 200) });
    }

    return ok(requestId);
  }

  async pollReportInstance(requestId: string): Promise<Result<ReportPollResult, AscError>> {
    const token = signAscToken(this.creds.keyId, this.creds.issuerId, this.creds.privateKeyPem);

    // Step 1: list reports for this request
    const reportsUrl = `${ASC_BASE}/v1/analyticsReportRequests/${encodeURIComponent(requestId)}/reports`;
    let reportsRes: Response;
    try {
      reportsRes = await getGateway().fetch(reportsUrl, { kind: 'app', upstream: 'asc' }, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (e) {
      return err({ kind: 'api_error', status: 0, detail: String(e) });
    }

    if (!reportsRes.ok) {
      const detail = await reportsRes.text().catch(() => '');
      return err({ kind: 'api_error', status: reportsRes.status, detail: detail.slice(0, 200) });
    }

    const reportsData = await reportsRes.json().catch(() => null);
    const reports = (reportsData as { data?: unknown[] })?.data;
    if (!reports || reports.length === 0) return ok({ status: 'pending' });

    // Step 2: get instances for the first report
    const reportId = (reports[0] as { id?: string })?.id;
    if (!reportId) return ok({ status: 'pending' });

    const instancesUrl = `${ASC_BASE}/v1/analyticsReports/${encodeURIComponent(reportId)}/instances`;
    let instancesRes: Response;
    try {
      instancesRes = await getGateway().fetch(instancesUrl, { kind: 'app', upstream: 'asc' }, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (e) {
      return err({ kind: 'api_error', status: 0, detail: String(e) });
    }

    const instancesData = await instancesRes.json().catch(() => null);
    const instances = (instancesData as { data?: unknown[] })?.data;
    if (!instances || instances.length === 0) return ok({ status: 'pending' });

    // Step 3: download the first instance's segments
    const instanceId = (instances[0] as { id?: string })?.id;
    if (!instanceId) return ok({ status: 'pending' });

    const segmentsUrl = `${ASC_BASE}/v1/analyticsReportInstances/${encodeURIComponent(instanceId)}/segments`;
    let segmentsRes: Response;
    try {
      segmentsRes = await getGateway().fetch(segmentsUrl, { kind: 'app', upstream: 'asc' }, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (e) {
      return err({ kind: 'api_error', status: 0, detail: String(e) });
    }

    const segmentsData = await segmentsRes.json().catch(() => null);
    const segments = (segmentsData as { data?: unknown[] })?.data;
    if (!segments || segments.length === 0) return ok({ status: 'pending' });

    // Step 4: download the actual data from the first segment URL
    const downloadUrl = (segments[0] as { attributes?: { url?: string } })?.attributes?.url;
    if (!downloadUrl) return ok({ status: 'pending' });

    let downloadRes: Response;
    try {
      downloadRes = await getGateway().fetch(downloadUrl, { kind: 'app', upstream: 'asc' }, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (e) {
      return err({ kind: 'api_error', status: 0, detail: String(e) });
    }

    const text = await downloadRes.text().catch(() => '');
    const rows = parseReportCsv(text);
    return ok({ status: 'ready', rows });
  }
}

function parseReportCsv(csv: string): ReportRow[] {
  const lines = csv.split('\n').filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split('\t').map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const cols = line.split('\t');
    const get = (name: string) => cols[headers.indexOf(name)] ?? '';
    return {
      date: get('date'),
      impressions: Number(get('impressions')) || 0,
      downloads: Number(get('total downloads')) || Number(get('downloads')) || 0,
      conversionRate: Number(get('conversion rate')) || 0,
      territory: get('territory') || get('storefront'),
    };
  }).filter((r) => r.date);
}

export class StubAscAnalyticsClient implements AscAnalyticsClient {
  #nextId = 1;
  constructor(private readonly rows: ReportRow[]) {}

  async createReportRequest(
    _type: ReportType,
    _filters: ReportFilters,
  ): Promise<Result<string, AscError>> {
    return ok(`stub-request-${this.#nextId++}`);
  }

  async pollReportInstance(_requestId: string): Promise<Result<ReportPollResult, AscError>> {
    return ok({ status: 'ready', rows: this.rows });
  }
}

export class NoOpAscAnalyticsClient implements AscAnalyticsClient {
  async createReportRequest(
    _type: ReportType,
    _filters: ReportFilters,
  ): Promise<Result<string, AscError>> {
    return ok('noop-request-id');
  }

  async pollReportInstance(_requestId: string): Promise<Result<ReportPollResult, AscError>> {
    return ok({ status: 'pending' });
  }
}

export function getAscAnalyticsClient(creds: AscCredentials): AscAnalyticsClient {
  return new AppleAscAnalyticsClient(creds);
}
```

> **Important:** The Analytics Reports API shape above (request body, URL structure, TSV download) is based on Apple's documentation but **has not been verified against real API responses**. Run the live smoke test and inspect the `console.log` output to confirm/adjust the field names, URL paths, and data format before marking this task complete.

- [ ] **Step 4: Run unit tests**

```bash
cd apps/server && nvm use 24 && npm test -- asc/analytics-client
```
Expected: `4 tests passed` (Stub + NoOp; live test skipped)

- [ ] **Step 5: Run live smoke test and verify the API shape**

```bash
cd apps/server && ASC_KEY_ID=<id> ASC_ISSUER_ID=<id> ASC_PRIVATE_KEY="$(cat key.p8)" ASC_TEST_APP_ID=<your-app-id> nvm use 24 && npm test -- asc/analytics-client
```

Inspect the `console.log` output. If Apple's response shape differs, adjust `createReportRequest` (request body fields), `pollReportInstance` (URL paths, field names), or `parseReportCsv` (column names) accordingly. Commit the adjustments with a note: `fix(p7a): adjust analytics client to match real ASC response shape`.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/asc/analytics-client.ts apps/server/src/asc/analytics-client.test.ts
git commit -m "feat(p7a): AscAnalyticsClient — two-phase report request + poll"
```

---

### Task 6: Web settings UI

**Files:**
- Create: `apps/web/src/components/AscSettings.tsx`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: `authedFetch` (internal to `api.ts` — re-use the existing pattern); `ascRoutes` endpoints from Task 3
- Produces: `AscSettings` React component; `getAscStatus()`, `saveAscCredentials()`, `deleteAscCredentials()` in `api.ts`

> **Testing note:** The web app has no React testing infrastructure (`@testing-library/react` / jsdom not installed). Test this task manually by starting the dev server and using the UI.

---

- [ ] **Step 1: Add API client functions to `apps/web/src/lib/api.ts`**

After the last export in `api.ts`, add:

```ts
export interface AscStatus {
  connected: boolean;
  keyId: string | null;
}

export async function getAscStatus(): Promise<AscStatus> {
  const res = await authedFetch('/settings/asc');
  if (!res.ok) return { connected: false, keyId: null };
  return res.json() as Promise<AscStatus>;
}

export async function saveAscCredentials(
  keyId: string,
  issuerId: string,
  privateKey: string,
): Promise<void> {
  const res = await authedFetch('/settings/asc', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyId, issuerId, privateKey }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error ?? 'Failed to save credentials');
  }
}

export async function deleteAscCredentials(): Promise<void> {
  const res = await authedFetch('/settings/asc', { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to disconnect');
}
```

- [ ] **Step 2: Create `apps/web/src/components/AscSettings.tsx`**

```tsx
import { useState, useEffect } from 'react';
import { getAscStatus, saveAscCredentials, deleteAscCredentials, type AscStatus } from '../lib/api';

interface Props {
  onClose: () => void;
}

export function AscSettings({ onClose }: Props) {
  const [status, setStatus] = useState<AscStatus | null>(null);
  const [keyId, setKeyId] = useState('');
  const [issuerId, setIssuerId] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAscStatus().then(setStatus).catch(() => setStatus({ connected: false, keyId: null }));
  }, []);

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await saveAscCredentials(keyId.trim(), issuerId.trim(), privateKey.trim());
      setStatus({ connected: true, keyId: keyId.trim() });
      setPrivateKey('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteAscCredentials();
      setStatus({ connected: false, keyId: null });
      setKeyId('');
      setIssuerId('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50,
    }}>
      <div style={{
        background: '#18181b', border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 12, padding: 24, width: '100%', maxWidth: 440,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, color: '#f4f4f5', margin: 0 }}>
            App Store Connect
          </h2>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#71717a', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}
          >
            ×
          </button>
        </div>

        {status === null ? (
          <p style={{ color: '#71717a', fontSize: 14 }}>Loading…</p>
        ) : status.connected ? (
          <div>
            <p style={{ fontSize: 14, color: '#a1a1aa', marginBottom: 16 }}>
              Connected — Key ID: <span style={{ color: '#f4f4f5', fontFamily: 'monospace' }}>{status.keyId}</span>
            </p>
            {error && <p style={{ color: '#f87171', fontSize: 13, marginBottom: 12 }}>{error}</p>}
            <button
              onClick={handleDisconnect}
              disabled={busy}
              style={{
                padding: '8px 16px', borderRadius: 6, background: '#3f3f46',
                color: '#f4f4f5', border: 'none', cursor: busy ? 'not-allowed' : 'pointer', fontSize: 14,
              }}
            >
              {busy ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </div>
        ) : (
          <form onSubmit={handleConnect} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <p style={{ fontSize: 13, color: '#71717a', margin: 0 }}>
              Required to measure real impressions and downloads. Find these in App Store Connect → Users &amp; Access → Keys.
            </p>
            <input
              type="text"
              placeholder="Key ID"
              value={keyId}
              onChange={(e) => setKeyId(e.target.value)}
              required
              style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #3f3f46', background: '#27272a', color: '#f4f4f5', fontSize: 14 }}
            />
            <input
              type="text"
              placeholder="Issuer ID"
              value={issuerId}
              onChange={(e) => setIssuerId(e.target.value)}
              required
              style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #3f3f46', background: '#27272a', color: '#f4f4f5', fontSize: 14 }}
            />
            <textarea
              placeholder="Private key (.p8 file contents — paste here)"
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              required
              rows={5}
              style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #3f3f46', background: '#27272a', color: '#f4f4f5', fontSize: 13, fontFamily: 'monospace', resize: 'vertical' }}
            />
            {error && <p style={{ color: '#f87171', fontSize: 13, margin: 0 }}>{error}</p>}
            <button
              type="submit"
              disabled={busy}
              style={{
                padding: '9px 12px', borderRadius: 6, background: '#2563eb',
                color: '#fff', border: 'none', cursor: busy ? 'not-allowed' : 'pointer', fontSize: 14,
              }}
            >
              {busy ? 'Connecting…' : 'Connect App Store Connect'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add gear icon and modal to `Header` in `apps/web/src/App.tsx`**

Add the import at the top of `App.tsx`:
```ts
import { AscSettings } from './components/AscSettings';
```

In the `Header` function, add state for the modal:
```ts
function Header() {
  const [health, setHealth] = useState<Health | null>(null);
  const [showAscSettings, setShowAscSettings] = useState(false);  // ADD THIS

  // ... existing useEffect ...

  return (
    <>   {/* WRAP IN FRAGMENT */}
      {showAscSettings && <AscSettings onClose={() => setShowAscSettings(false)} />}
      <header className="shrink-0 border-b border-white/10 px-4 py-3">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4">
          {/* existing left side */}
          <div>
            <h1 className="text-sm font-semibold text-zinc-100">ASO Audit Agent</h1>
            <p className="text-xs text-zinc-500">App Store Optimization audits — built on Mastra</p>
          </div>
          <div className="flex items-center gap-2">   {/* WRAP chips + gear in a flex div */}
            {health && (
              <div className="flex items-center gap-1.5">
                {/* existing Chip components — no change */}
              </div>
            )}
            {/* ADD gear button */}
            <button
              onClick={() => setShowAscSettings(true)}
              title="App Store Connect settings"
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: '#71717a', fontSize: 16, padding: '4px 6px', borderRadius: 6,
                lineHeight: 1,
              }}
            >
              ⚙
            </button>
          </div>
        </div>
      </header>
    </>
  );
}
```

> **Note:** The `Header` function currently has `health && (...)` chips inside the flex div. You are wrapping the existing chips and the new gear button together — do not change the chips' code, just add the wrapping div and the button.

- [ ] **Step 4: Start the dev server and manually test**

```bash
cd /path/to/layers-ai-aso-audit && nvm use 24 && npm run dev
```

Open `http://localhost:3000`, log in, and verify:
1. ⚙ gear icon appears in the header
2. Clicking it opens the AscSettings modal
3. Connecting with real credentials shows "Connected — Key ID: …" after the validation call succeeds
4. Disconnecting returns to the connect form
5. Invalid credentials show a validation error message

- [ ] **Step 5: Run the full server test suite to confirm no regressions**

```bash
cd apps/server && nvm use 24 && npm test
```
Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/AscSettings.tsx apps/web/src/lib/api.ts apps/web/src/App.tsx
git commit -m "feat(p7a): AscSettings modal — connect/disconnect App Store Connect credentials"
```

---

## Self-Review Checklist (for the implementer)

Before opening a PR:
- [ ] All 6 commit messages present on `p7a-asc-auth-read-client` branch
- [ ] `npm test` passes in `apps/server` with no skipped tests (except the two guarded live smokes)
- [ ] Live smoke tests run once with real credentials; `versions-client` and `analytics-client` adjusted to match real Apple response shapes if they differed
- [ ] `ASC_ENCRYPTION_KEY` documented in `.env.example` (if one exists) or in the project README
- [ ] No `console.log` left in production paths (remove the smoke-test `console.log` from `analytics-client.ts` after verifying the shape)
