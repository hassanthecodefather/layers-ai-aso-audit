# P8-B: Acting on the Listing — Write Path + Review Tracking

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the audit-to-action loop — users generate concrete new ASC field values from audit recommendations, review an inline-editable diff, push to App Store Connect, and track Apple's review state, all from within the tool. Rejection triggers re-generation with the rejection reason as context.

**Architecture:** A new `aso_listing_updates` table owns a `draft → submitted → in_review → approved/rejected` state machine. Three server routes handle generation (lazy LLM call), submission (ASC PATCH), and current-status polling. The hourly scheduler gains a new step that polls ASC version state for in-flight updates and writes a `listing_update_resolved` change event on terminal state. The frontend adds a `ListingUpdatePanel` to the audit report and a new card type in the Activity Feed.

**Tech Stack:** TypeScript, Postgres (JSONB), Mastra/Hono routes, AI SDK (`generateObject`), ASC REST API, React, Vitest.

## Global Constraints

- Node ≥ 20.12 — use `nvm use 24` in dev shell
- Only en-US locale (same as `fetchAscListingData`)
- One non-terminal update per `(tenant_id, app_id)` at a time — enforced in generate route application logic
- Hard char limits: title ≤ 30, subtitle ≤ 30, keywords ≤ 100, description ≤ 4000, promotionalText ≤ 170, releaseNotes ≤ 4000
- `aso_listing_updates` uses JSONB → must go in `PG_ONLY_MIGRATIONS` (not LibSQL-compatible)
- LLM calls: `generateObject({ model: getLlmProvider('fast').model(), schema, prompt })` — import from `'ai'` and `'../llm'` respectively
- ASC HTTP calls: `getGateway().fetch(url, { kind: 'app', upstream: 'asc' }, { headers: { Authorization: \`Bearer ${token}\` } })`
- Route handlers: `getAuthenticatedTenantId(c)` → body parse `.catch(() => ({}))` → `getPgSql()` → op → `c.json(data, status)`
- IDs: `newId('lu')` for listing update rows (prefix `lu`)
- Test runner: `cd apps/server && npx vitest run <path>` or `cd apps/web && npx vitest run <path>`
- Spec: `docs/superpowers/specs/2026-07-13-p8b-acting-on-listing-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `apps/server/src/memory/pg-migrate.ts` | Modify | Append `aso_listing_updates` CREATE TABLE to `PG_ONLY_MIGRATIONS` |
| `apps/server/src/queue/listing-update-store.ts` | **Create** | CRUD for `aso_listing_updates` table |
| `apps/server/src/queue/listing-update-store.test.ts` | **Create** | Unit tests for store functions |
| `apps/server/src/asc/listing-client.ts` | Modify | Add `localizationId: string \| null` to `AscListingData`; return locale record `id` |
| `apps/server/src/asc/listing-client.test.ts` | Modify | Extend existing tests to assert `localizationId` |
| `apps/server/src/asc/listing-writer.ts` | **Create** | `pushListingUpdate` — PATCH `/v1/appStoreVersionLocalizations/{id}` |
| `apps/server/src/asc/listing-writer.test.ts` | **Create** | Unit tests for `pushListingUpdate` |
| `apps/server/src/mastra/listing-update-routes.ts` | **Create** | Three routes: generate, submit, current |
| `apps/server/src/mastra/index.ts` | Modify | Add `listingUpdateRoutes` to `apiRoutes` array |
| `apps/server/src/tracking/listing-update-checker.ts` | **Create** | `runListingUpdateCheck` — polls ASC state for in-flight updates |
| `apps/server/src/tracking/scheduler.ts` | Modify | Call `runListingUpdateCheck` in `tick()` after the per-app scan loop |
| `apps/web/src/lib/api.ts` | Modify | Add `generateListingUpdate`, `submitListingUpdate`, `getListingUpdateCurrent`; extend `ActivityEvent` type |
| `apps/web/src/components/ListingUpdateDiff.tsx` | **Create** | Diff table: field name, current value, proposed value (editable + char counter), checkbox |
| `apps/web/src/components/ListingUpdatePanel.tsx` | **Create** | State-machine panel: idle → generating → draft → submitted/in_review → approved/rejected |
| `apps/web/src/components/ActivityFeed.tsx` | Modify | Handle `listing_update_resolved` event card |

---

## Task 1: DB migration + `listing-update-store.ts`

**Files:**
- Modify: `apps/server/src/memory/pg-migrate.ts`
- Create: `apps/server/src/queue/listing-update-store.ts`
- Create: `apps/server/src/queue/listing-update-store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ListingUpdateStatus = 'draft' | 'submitted' | 'in_review' | 'approved' | 'rejected';
  export interface ListingUpdate { id, tenantId, appId, auditJobId, proposedFields, appliedFields, ascLocalizationId, status, rejectionReason, submittedAt, resolvedAt, createdAt }
  export type ProposedFields = { title?, subtitle?, keywords?, description?, promotionalText?, releaseNotes? }
  export async function insertListingUpdate(sql, params): Promise<ListingUpdate>
  export async function getListingUpdateById(sql, tenantId, id): Promise<ListingUpdate | null>
  export async function getLatestListingUpdate(sql, tenantId, appId): Promise<ListingUpdate | null>
  export async function getInFlightListingUpdates(sql): Promise<ListingUpdate[]>
  export async function setListingUpdateSubmitted(sql, id, appliedFields): Promise<void>
  export async function setListingUpdateStatus(sql, id, status, rejectionReason?, resolvedAt?): Promise<void>
  export async function resetListingUpdateToDraft(sql, id): Promise<void>
  ```

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/queue/listing-update-store.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

// Mock gateway is not needed here — we mock the sql function directly
const makeRow = (overrides = {}) => ({
  id: 'lu_abc',
  tenant_id: 'tenant1',
  app_id: '123456',
  audit_job_id: 'job_1',
  proposed_fields: JSON.stringify({ title: 'New Title' }),
  applied_fields: null,
  asc_localization_id: 'loc_1',
  status: 'draft',
  rejection_reason: null,
  submitted_at: null,
  resolved_at: null,
  created_at: new Date('2026-01-01'),
  ...overrides,
});

describe('listing-update-store', () => {
  let mockSql: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    // postgres tagged-template calls are plain function calls under the hood
    mockSql = vi.fn().mockResolvedValue([]);
  });

  it('insertListingUpdate returns a mapped ListingUpdate', async () => {
    mockSql.mockResolvedValueOnce([makeRow()]);
    const { insertListingUpdate } = await import('./listing-update-store');
    const result = await insertListingUpdate(mockSql as unknown as postgres.Sql, {
      tenantId: 'tenant1',
      appId: '123456',
      auditJobId: 'job_1',
      proposedFields: { title: 'New Title' },
      ascLocalizationId: 'loc_1',
    });
    expect(result.id).toBe('lu_abc');
    expect(result.tenantId).toBe('tenant1');
    expect(result.status).toBe('draft');
    expect(result.proposedFields).toEqual({ title: 'New Title' });
    expect(result.appliedFields).toBeNull();
  });

  it('getListingUpdateById returns null when no row', async () => {
    mockSql.mockResolvedValueOnce([]);
    const { getListingUpdateById } = await import('./listing-update-store');
    const result = await getListingUpdateById(mockSql as unknown as postgres.Sql, 'tenant1', 'lu_missing');
    expect(result).toBeNull();
  });

  it('getLatestListingUpdate returns the most recent non-approved update', async () => {
    const row = makeRow({ status: 'submitted' });
    mockSql.mockResolvedValueOnce([row]);
    const { getLatestListingUpdate } = await import('./listing-update-store');
    const result = await getLatestListingUpdate(mockSql as unknown as postgres.Sql, 'tenant1', '123456');
    expect(result?.status).toBe('submitted');
  });

  it('getInFlightListingUpdates returns submitted and in_review rows', async () => {
    const rows = [makeRow({ status: 'submitted' }), makeRow({ id: 'lu_2', status: 'in_review' })];
    mockSql.mockResolvedValueOnce(rows);
    const { getInFlightListingUpdates } = await import('./listing-update-store');
    const results = await getInFlightListingUpdates(mockSql as unknown as postgres.Sql);
    expect(results).toHaveLength(2);
  });

  it('setListingUpdateStatus updates status and resolution fields', async () => {
    const { setListingUpdateStatus } = await import('./listing-update-store');
    await setListingUpdateStatus(mockSql as unknown as postgres.Sql, 'lu_abc', 'approved', null, new Date());
    expect(mockSql).toHaveBeenCalled();
  });

  it('resetListingUpdateToDraft resets status to draft', async () => {
    const { resetListingUpdateToDraft } = await import('./listing-update-store');
    await resetListingUpdateToDraft(mockSql as unknown as postgres.Sql, 'lu_abc');
    expect(mockSql).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests — verify they fail with module-not-found**

```bash
cd apps/server && npx vitest run src/queue/listing-update-store.test.ts
```

Expected: FAIL — `Cannot find module './listing-update-store'`

- [ ] **Step 3: Append migration to `pg-migrate.ts`**

Find `PG_ONLY_MIGRATIONS` in `apps/server/src/memory/pg-migrate.ts` and append the new entry at the end of the array (before the closing `]`):

```typescript
  `CREATE TABLE IF NOT EXISTS aso_listing_updates (
    id                   TEXT PRIMARY KEY,
    tenant_id            TEXT NOT NULL,
    app_id               TEXT NOT NULL,
    audit_job_id         TEXT REFERENCES aso_audit_jobs(id),
    proposed_fields      JSONB NOT NULL,
    applied_fields       JSONB,
    asc_localization_id  TEXT,
    status               TEXT NOT NULL DEFAULT 'draft',
    rejection_reason     TEXT,
    submitted_at         TIMESTAMPTZ,
    resolved_at          TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS aso_listing_updates_tenant_app
    ON aso_listing_updates (tenant_id, app_id)`,
```

- [ ] **Step 4: Create `apps/server/src/queue/listing-update-store.ts`**

```typescript
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';

export type ListingUpdateStatus = 'draft' | 'submitted' | 'in_review' | 'approved' | 'rejected';

export type ProposedFields = {
  title?: string;
  subtitle?: string;
  keywords?: string;
  description?: string;
  promotionalText?: string;
  releaseNotes?: string;
};

export interface ListingUpdate {
  id: string;
  tenantId: string;
  appId: string;
  auditJobId: string | null;
  proposedFields: ProposedFields;
  appliedFields: ProposedFields | null;
  ascLocalizationId: string | null;
  status: ListingUpdateStatus;
  rejectionReason: string | null;
  submittedAt: Date | null;
  resolvedAt: Date | null;
  createdAt: Date;
}

interface ListingUpdateRow {
  id: string;
  tenant_id: string;
  app_id: string;
  audit_job_id: string | null;
  proposed_fields: string;
  applied_fields: string | null;
  asc_localization_id: string | null;
  status: string;
  rejection_reason: string | null;
  submitted_at: Date | null;
  resolved_at: Date | null;
  created_at: Date;
}

function rowToListingUpdate(r: ListingUpdateRow): ListingUpdate {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    appId: r.app_id,
    auditJobId: r.audit_job_id,
    proposedFields: typeof r.proposed_fields === 'string'
      ? (JSON.parse(r.proposed_fields) as ProposedFields)
      : (r.proposed_fields as unknown as ProposedFields),
    appliedFields: r.applied_fields
      ? (typeof r.applied_fields === 'string'
          ? (JSON.parse(r.applied_fields) as ProposedFields)
          : (r.applied_fields as unknown as ProposedFields))
      : null,
    ascLocalizationId: r.asc_localization_id,
    status: r.status as ListingUpdateStatus,
    rejectionReason: r.rejection_reason,
    submittedAt: r.submitted_at,
    resolvedAt: r.resolved_at,
    createdAt: r.created_at,
  };
}

export async function insertListingUpdate(
  sql: postgres.Sql,
  params: {
    tenantId: string;
    appId: string;
    auditJobId?: string | null;
    proposedFields: ProposedFields;
    ascLocalizationId?: string | null;
  },
): Promise<ListingUpdate> {
  const id = `lu_${randomUUID()}`;
  const rows = await sql<ListingUpdateRow[]>`
    INSERT INTO aso_listing_updates
      (id, tenant_id, app_id, audit_job_id, proposed_fields, asc_localization_id)
    VALUES (
      ${id},
      ${params.tenantId},
      ${params.appId},
      ${params.auditJobId ?? null},
      ${JSON.stringify(params.proposedFields)},
      ${params.ascLocalizationId ?? null}
    )
    RETURNING *
  `;
  return rowToListingUpdate(rows[0]);
}

export async function getListingUpdateById(
  sql: postgres.Sql,
  tenantId: string,
  id: string,
): Promise<ListingUpdate | null> {
  const rows = await sql<ListingUpdateRow[]>`
    SELECT * FROM aso_listing_updates
    WHERE id = ${id} AND tenant_id = ${tenantId}
    LIMIT 1
  `;
  return rows[0] ? rowToListingUpdate(rows[0]) : null;
}

export async function getLatestListingUpdate(
  sql: postgres.Sql,
  tenantId: string,
  appId: string,
): Promise<ListingUpdate | null> {
  const rows = await sql<ListingUpdateRow[]>`
    SELECT * FROM aso_listing_updates
    WHERE tenant_id = ${tenantId}
      AND app_id = ${appId}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return rows[0] ? rowToListingUpdate(rows[0]) : null;
}

export async function getInFlightListingUpdates(
  sql: postgres.Sql,
): Promise<ListingUpdate[]> {
  const rows = await sql<ListingUpdateRow[]>`
    SELECT * FROM aso_listing_updates
    WHERE status IN ('submitted', 'in_review')
    ORDER BY submitted_at ASC
  `;
  return rows.map(rowToListingUpdate);
}

export async function setListingUpdateSubmitted(
  sql: postgres.Sql,
  id: string,
  appliedFields: ProposedFields,
): Promise<void> {
  await sql`
    UPDATE aso_listing_updates
    SET applied_fields = ${JSON.stringify(appliedFields)},
        status         = 'submitted',
        submitted_at   = NOW()
    WHERE id = ${id}
  `;
}

export async function setListingUpdateStatus(
  sql: postgres.Sql,
  id: string,
  status: ListingUpdateStatus,
  rejectionReason: string | null,
  resolvedAt: Date | null,
): Promise<void> {
  await sql`
    UPDATE aso_listing_updates
    SET status           = ${status},
        rejection_reason = ${rejectionReason},
        resolved_at      = ${resolvedAt}
    WHERE id = ${id}
  `;
}

export async function resetListingUpdateToDraft(
  sql: postgres.Sql,
  id: string,
): Promise<void> {
  await sql`
    UPDATE aso_listing_updates
    SET status         = 'draft',
        applied_fields = NULL,
        submitted_at   = NULL,
        resolved_at    = NULL
    WHERE id = ${id}
  `;
}
```

- [ ] **Step 5: Run tests — verify they pass**

```bash
cd apps/server && npx vitest run src/queue/listing-update-store.test.ts
```

Expected: 6 tests PASS

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/memory/pg-migrate.ts \
        apps/server/src/queue/listing-update-store.ts \
        apps/server/src/queue/listing-update-store.test.ts
git commit -m "feat(p8b): add aso_listing_updates table + store CRUD"
```

---

## Task 2: Extend `listing-client.ts` — add `localizationId`

**Files:**
- Modify: `apps/server/src/asc/listing-client.ts`
- Modify: `apps/server/src/asc/listing-client.test.ts`

**Interfaces:**
- Consumes: existing `AscListingData`, `fetchAscListingData`
- Produces (extended):
  ```ts
  export type AscListingData = {
    keywords: string | null;
    promotionalText: string | null;
    localizationId: string | null;  // NEW — en-US locale record ID for PATCH writes
  };
  ```

- [ ] **Step 1: Extend the existing tests**

In `apps/server/src/asc/listing-client.test.ts`, find the test that asserts `{ keywords: ..., promotionalText: ... }` and add `localizationId` assertions. There should be at least 4 tests (en-US found, fallback locale, no version, non-2xx). Add `localizationId` to every expected result:

For the **en-US found** test — the locale record mock should have an `id` field. Update the mock localizations response to include `id: 'loc_en_us'` on the en-US record:

```typescript
// Example existing mock shape — update to include id:
{
  data: [
    {
      id: 'loc_en_us',
      attributes: { locale: 'en-US', keywords: 'remote start,car key', promotionalText: 'Best app' },
    },
    {
      id: 'loc_fr',
      attributes: { locale: 'fr-FR', keywords: 'démarrage', promotionalText: '' },
    },
  ],
}
```

Then in the test assertion:
```typescript
expect(result).toEqual({
  keywords: 'remote start,car key',
  promotionalText: 'Best app',
  localizationId: 'loc_en_us',   // ADD THIS
});
```

For the **fallback locale** test — the fallback record should have `id: 'loc_fr'`:
```typescript
expect(result).toEqual({
  keywords: 'démarrage',
  promotionalText: '',
  localizationId: 'loc_fr',  // ADD THIS
});
```

For the **no version** and **non-2xx** tests:
```typescript
expect(result).toEqual({ keywords: null, promotionalText: null, localizationId: null });
```

- [ ] **Step 2: Run tests — verify the new assertions fail**

```bash
cd apps/server && npx vitest run src/asc/listing-client.test.ts
```

Expected: FAIL — `localizationId` not in result (undefined !== 'loc_en_us')

- [ ] **Step 3: Update `listing-client.ts`**

In `apps/server/src/asc/listing-client.ts`:

1. Add `localizationId: string | null` to `AscListingData`:
```typescript
export type AscListingData = {
  keywords: string | null;
  promotionalText: string | null;
  localizationId: string | null;
};
```

2. Update `NULL_RESULT` constant (or the inline fallback return value):
```typescript
const NULL_RESULT: AscListingData = { keywords: null, promotionalText: null, localizationId: null };
```

3. In the locale-selection logic, extract `.id` alongside `.attributes`:
```typescript
// Before (approximate — match what's in the file):
const locale = locData.data.find((d) => d.attributes.locale === 'en-US') ?? locData.data[0];
return {
  keywords: locale?.attributes?.keywords ?? null,
  promotionalText: locale?.attributes?.promotionalText ?? null,
};

// After:
const locale = locData.data.find((d) => d.attributes.locale === 'en-US') ?? locData.data[0];
return {
  keywords: locale?.attributes?.keywords ?? null,
  promotionalText: locale?.attributes?.promotionalText ?? null,
  localizationId: locale?.id ?? null,
};
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd apps/server && npx vitest run src/asc/listing-client.test.ts
```

Expected: all tests PASS (count should match previous count — no new tests added, only assertions extended)

- [ ] **Step 5: Run the full server test suite to confirm no regressions**

```bash
cd apps/server && npx vitest run
```

Expected: PASS (the only consumers of `AscListingData` that destructure it are in `audit-workflow.ts` — adding a new optional field is backwards-compatible)

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/asc/listing-client.ts \
        apps/server/src/asc/listing-client.test.ts
git commit -m "feat(p8b): add localizationId to AscListingData for write path"
```

---

## Task 3: `listing-writer.ts` — ASC PATCH client

**Files:**
- Create: `apps/server/src/asc/listing-writer.ts`
- Create: `apps/server/src/asc/listing-writer.test.ts`

**Interfaces:**
- Consumes: `AscCredentials` (from `./credential-store`), `ProposedFields` (from `../queue/listing-update-store`)
- Produces:
  ```ts
  export async function pushListingUpdate(
    creds: AscCredentials,
    localizationId: string,
    fields: ProposedFields,
  ): Promise<{ ok: true } | { ok: false; error: string }>
  ```

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/asc/listing-writer.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../cost/gateway', () => ({
  getGateway: () => ({ fetch: vi.fn() }),
}));

vi.mock('./credential-store', () => ({
  signAscToken: vi.fn().mockReturnValue('mock-jwt-token'),
}));

const mockGatewayFetch = vi.fn();
vi.mock('../cost/gateway', () => ({
  getGateway: () => ({ fetch: mockGatewayFetch }),
}));

describe('pushListingUpdate', () => {
  const creds = { keyId: 'K1', issuerId: 'I1', privateKeyPem: '-----BEGIN...' };

  beforeEach(() => {
    vi.resetModules();
    mockGatewayFetch.mockReset();
  });

  it('returns ok:true on 200 response', async () => {
    mockGatewayFetch.mockResolvedValue(new Response('{}', { status: 200 }));
    const { pushListingUpdate } = await import('./listing-writer');
    const result = await pushListingUpdate(creds, 'loc_123', { title: 'New Title' });
    expect(result).toEqual({ ok: true });
  });

  it('sends only the provided fields as attributes', async () => {
    mockGatewayFetch.mockResolvedValue(new Response('{}', { status: 200 }));
    const { pushListingUpdate } = await import('./listing-writer');
    await pushListingUpdate(creds, 'loc_123', { title: 'T', keywords: 'a,b,c' });
    const call = mockGatewayFetch.mock.calls[0];
    const body = JSON.parse(call[2]?.body as string);
    expect(body.data.attributes).toEqual({ name: 'T', keywords: 'a,b,c' });
    expect(body.data.attributes.description).toBeUndefined();
  });

  it('maps title→name and releaseNotes→whatsNew', async () => {
    mockGatewayFetch.mockResolvedValue(new Response('{}', { status: 200 }));
    const { pushListingUpdate } = await import('./listing-writer');
    await pushListingUpdate(creds, 'loc_123', { title: 'T', releaseNotes: 'Bug fixes' });
    const call = mockGatewayFetch.mock.calls[0];
    const body = JSON.parse(call[2]?.body as string);
    expect(body.data.attributes.name).toBe('T');
    expect(body.data.attributes.whatsNew).toBe('Bug fixes');
    expect(body.data.attributes.title).toBeUndefined();
    expect(body.data.attributes.releaseNotes).toBeUndefined();
  });

  it('returns ok:false on non-2xx response', async () => {
    mockGatewayFetch.mockResolvedValue(new Response('Forbidden', { status: 403 }));
    const { pushListingUpdate } = await import('./listing-writer');
    const result = await pushListingUpdate(creds, 'loc_123', { title: 'T' });
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain('403');
  });

  it('returns ok:false when fetch throws', async () => {
    mockGatewayFetch.mockRejectedValue(new Error('network error'));
    const { pushListingUpdate } = await import('./listing-writer');
    const result = await pushListingUpdate(creds, 'loc_123', { title: 'T' });
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd apps/server && npx vitest run src/asc/listing-writer.test.ts
```

Expected: FAIL — `Cannot find module './listing-writer'`

- [ ] **Step 3: Create `apps/server/src/asc/listing-writer.ts`**

```typescript
import { getGateway } from '../cost/gateway';
import { signAscToken } from './credential-store';
import type { AscCredentials } from './credential-store';
import type { ProposedFields } from '../queue/listing-update-store';

const ASC_BASE = 'https://api.appstoreconnect.apple.com';

// ASC field name differs from our internal names for two fields:
//   title        → name
//   releaseNotes → whatsNew
function toAscAttributes(fields: ProposedFields): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (fields.title !== undefined) attrs.name = fields.title;
  if (fields.subtitle !== undefined) attrs.subtitle = fields.subtitle;
  if (fields.keywords !== undefined) attrs.keywords = fields.keywords;
  if (fields.description !== undefined) attrs.description = fields.description;
  if (fields.promotionalText !== undefined) attrs.promotionalText = fields.promotionalText;
  if (fields.releaseNotes !== undefined) attrs.whatsNew = fields.releaseNotes;
  return attrs;
}

export async function pushListingUpdate(
  creds: AscCredentials,
  localizationId: string,
  fields: ProposedFields,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const token = signAscToken(creds.keyId, creds.issuerId, creds.privateKeyPem);
    const url = `${ASC_BASE}/v1/appStoreVersionLocalizations/${encodeURIComponent(localizationId)}`;
    const body = JSON.stringify({
      data: {
        type: 'appStoreVersionLocalizations',
        id: localizationId,
        attributes: toAscAttributes(fields),
      },
    });
    const res = await getGateway().fetch(
      url,
      { kind: 'app', upstream: 'asc' },
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body,
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `ASC returned ${res.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd apps/server && npx vitest run src/asc/listing-writer.test.ts
```

Expected: 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/asc/listing-writer.ts \
        apps/server/src/asc/listing-writer.test.ts
git commit -m "feat(p8b): add pushListingUpdate ASC PATCH client"
```

---

## Task 4: Server routes — generate, submit, current

**Files:**
- Create: `apps/server/src/mastra/listing-update-routes.ts`
- Modify: `apps/server/src/mastra/index.ts`

**Interfaces:**
- Consumes:
  - `insertListingUpdate`, `getListingUpdateById`, `getLatestListingUpdate`, `setListingUpdateSubmitted`, `resetListingUpdateToDraft`, `ProposedFields` from `../queue/listing-update-store`
  - `loadCredentials` from `../asc/credential-store`
  - `fetchAscListingData` from `../asc/listing-client`
  - `pushListingUpdate` from `../asc/listing-writer`
  - `getAuthenticatedTenantId`, `getPgSql` from existing route utilities
  - `getLlmProvider` from `../llm`
  - `generateObject` from `'ai'`
  - `z` from `'zod'`
  - `AuditJob` type and `getJobById` (or equivalent) from `../queue/job-store` — read that file to find the correct query function name

**Routes produced:**
- `POST /listing-update/generate` — body: `{ auditJobId: string }`
- `POST /listing-update/submit` — body: `{ updateId: string; approvedFields: ProposedFields }`
- `GET /listing-update/:appId/current`

**Note to implementer:** Before writing code, read `apps/server/src/queue/job-store.ts` to find the function that loads a single job by ID (e.g. `getJobById` or `getJob`). Also read `apps/server/src/mastra/routes.ts` fully to understand the `registerApiRoute` import path and `getAuthenticatedTenantId` / `getPgSql` import paths — replicate them exactly.

- [ ] **Step 1: Write the failing test (route logic unit test)**

Create `apps/server/src/mastra/listing-update-routes.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The routes themselves are hard to unit-test without a full Hono context,
// so we test the core generate logic by extracting and testing the prompt-building
// and field-mapping functions directly.
// Route integration is verified manually with curl after deployment.

// Test the ProposedFieldsSchema Zod validation used in the generate route:
describe('ProposedFieldsSchema', () => {
  it('strips fields exceeding char limits via refinement', async () => {
    const { ProposedFieldsSchema } = await import('./listing-update-routes');
    const result = ProposedFieldsSchema.safeParse({
      title: 'A'.repeat(31),  // over 30 char limit
      keywords: 'valid',
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid fields', async () => {
    const { ProposedFieldsSchema } = await import('./listing-update-routes');
    const result = ProposedFieldsSchema.safeParse({
      title: 'Short Title',
      keywords: 'a,b,c',
    });
    expect(result.success).toBe(true);
  });

  it('accepts partial objects (only changed fields)', async () => {
    const { ProposedFieldsSchema } = await import('./listing-update-routes');
    const result = ProposedFieldsSchema.safeParse({ keywords: 'remote start,ios' });
    expect(result.success).toBe(true);
    expect(result.data?.title).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd apps/server && npx vitest run src/mastra/listing-update-routes.test.ts
```

Expected: FAIL — `Cannot find module './listing-update-routes'`

- [ ] **Step 3: Create `apps/server/src/mastra/listing-update-routes.ts`**

Read `apps/server/src/mastra/routes.ts` first to get the exact import paths for `registerApiRoute`, `getAuthenticatedTenantId`, `getPgSql`. Read `apps/server/src/queue/job-store.ts` to find the single-job-by-id lookup function name (could be `getJobById`, `getAuditJob`, etc.).

```typescript
import { registerApiRoute } from '@mastra/core/server';
import { z } from 'zod';
import { generateObject } from 'ai';
import { getAuthenticatedTenantId, getPgSql } from './routes';  // adjust import path to match existing pattern
import {
  insertListingUpdate,
  getListingUpdateById,
  getLatestListingUpdate,
  setListingUpdateSubmitted,
  resetListingUpdateToDraft,
} from '../queue/listing-update-store';
import { loadCredentials } from '../asc/credential-store';
import { fetchAscListingData } from '../asc/listing-client';
import { pushListingUpdate } from '../asc/listing-writer';
import { getLlmProvider } from '../llm';
// Import the job lookup function — read job-store.ts for exact name:
import { getJobById } from '../queue/job-store';  // update if function name differs
import type { AuditReport } from '../domain/audit';

export const ProposedFieldsSchema = z.object({
  title: z.string().max(30).optional(),
  subtitle: z.string().max(30).optional(),
  keywords: z.string().max(100).optional(),
  description: z.string().max(4000).optional(),
  promotionalText: z.string().max(170).optional(),
  releaseNotes: z.string().max(4000).optional(),
});

function buildGeneratePrompt(params: {
  currentFields: Record<string, string | null>;
  recommendations: string;
  rejectionReason?: string | null;
}): string {
  const { currentFields, recommendations, rejectionReason } = params;
  const fieldLines = Object.entries(currentFields)
    .map(([k, v]) => `${k}: "${v ?? ''}"`)
    .join('\n');

  const rejectionContext = rejectionReason
    ? `\nIMPORTANT: Apple rejected the previous submission because: "${rejectionReason}". Generate new values that address this rejection while still applying the audit recommendations.\n`
    : '';

  return `You are an App Store Optimization expert. Based on the audit recommendations below, generate concrete new field values for this App Store listing.${rejectionContext}

CURRENT LISTING:
${fieldLines}

AUDIT RECOMMENDATIONS:
${recommendations}

INSTRUCTIONS:
- Only output fields that have recommendations and should change.
- Stay strictly within hard character limits: title ≤ 30, subtitle ≤ 30, keywords ≤ 100, description ≤ 4000, promotionalText ≤ 170, releaseNotes ≤ 4000.
- For keywords: comma-separated, no spaces after commas, no duplication of title/subtitle words.
- Return ONLY the fields that differ from current values.`;
}

export const listingUpdateRoutes = [
  registerApiRoute('/listing-update/generate', {
    method: 'POST',
    handler: async (c) => {
      const tenantId = await getAuthenticatedTenantId(c);
      if (!tenantId) return c.json({ error: 'Unauthorized' }, 401);
      const sql = getPgSql();
      if (!sql) return c.json({ error: 'Database not configured.' }, 503);

      const body = await c.req.json().catch(() => ({}));
      const auditJobId = typeof body?.auditJobId === 'string' ? body.auditJobId.trim() : '';
      if (!auditJobId) return c.json({ error: 'Missing auditJobId.' }, 400);

      try {
        // Load and verify the audit job
        const job = await getJobById(sql, tenantId, auditJobId);
        if (!job) return c.json({ error: 'Audit job not found.' }, 404);
        if (job.status !== 'done') return c.json({ error: 'Audit not yet complete.' }, 400);

        // Block if a non-terminal update already exists
        const existing = await getLatestListingUpdate(sql, tenantId, job.appId ?? '');
        if (existing && !['approved', 'rejected'].includes(existing.status)) {
          return c.json({ error: 'An update is already in progress.', updateId: existing.id }, 409);
        }

        // Load ASC credentials
        const credsResult = await loadCredentials(sql, tenantId);
        if (!credsResult.ok || !credsResult.value) {
          return c.json({ error: 'ASC credentials not configured.' }, 400);
        }
        const creds = credsResult.value;

        // Fetch current listing data + localization ID
        // The appId is stored in the job — read job-store.ts to find the exact field name
        // It may be stored in the URL field or a separate appId field:
        const appId = job.appId ?? extractAppIdFromUrl(job.url);
        const ascData = await fetchAscListingData(creds, appId);
        if (!ascData.localizationId) {
          return c.json({ error: 'Could not fetch ASC listing data. Check credentials and that app has a live version.' }, 400);
        }

        // Parse audit report recommendations
        const report = JSON.parse(job.resultJson ?? '{}') as Partial<AuditReport>;
        const allRecs = [
          ...(report.quickWins ?? []),
          ...(report.highImpact ?? []),
          ...(report.strategic ?? []),
        ];
        const recommendationsText = allRecs
          .map((r) => `[${r.referent ?? r.dimension}] ${r.title}: ${r.rationale}`)
          .join('\n');

        // Get rejection reason from existing rejected update (for re-generation flow)
        const rejectionReason = existing?.status === 'rejected' ? existing.rejectionReason : null;
        if (existing?.status === 'rejected') {
          await resetListingUpdateToDraft(sql, existing.id);
        }

        // LLM call — generate proposed field values
        const currentFields = {
          title: null as string | null,       // ASC listing-client doesn't return title/subtitle yet
          subtitle: null as string | null,    // These will be null unless we extend fetchAscListingData
          keywords: ascData.keywords,
          description: null as string | null,
          promotionalText: ascData.promotionalText,
        };

        const { object: proposedFields } = await generateObject({
          model: getLlmProvider('fast').model(),
          schema: ProposedFieldsSchema,
          prompt: buildGeneratePrompt({ currentFields, recommendations: recommendationsText, rejectionReason }),
        });

        // Insert draft row (or update the reset rejected row)
        const updateRow = await insertListingUpdate(sql, {
          tenantId,
          appId,
          auditJobId,
          proposedFields,
          ascLocalizationId: ascData.localizationId,
        });

        return c.json({
          updateId: updateRow.id,
          proposedFields: updateRow.proposedFields,
          currentFields,
          status: updateRow.status,
        });
      } catch (e) {
        console.error('[listing-update/generate] failed:', e);
        return c.json({ error: 'Generation failed.' }, 500);
      }
    },
  }),

  registerApiRoute('/listing-update/submit', {
    method: 'POST',
    handler: async (c) => {
      const tenantId = await getAuthenticatedTenantId(c);
      if (!tenantId) return c.json({ error: 'Unauthorized' }, 401);
      const sql = getPgSql();
      if (!sql) return c.json({ error: 'Database not configured.' }, 503);

      const body = await c.req.json().catch(() => ({}));
      const updateId = typeof body?.updateId === 'string' ? body.updateId.trim() : '';
      const approvedFields = body?.approvedFields;
      if (!updateId) return c.json({ error: 'Missing updateId.' }, 400);
      if (!approvedFields || typeof approvedFields !== 'object') {
        return c.json({ error: 'Missing approvedFields.' }, 400);
      }

      const fieldsResult = ProposedFieldsSchema.safeParse(approvedFields);
      if (!fieldsResult.success) {
        return c.json({ error: 'Invalid approvedFields.', details: fieldsResult.error.issues }, 400);
      }

      try {
        const update = await getListingUpdateById(sql, tenantId, updateId);
        if (!update) return c.json({ error: 'Update not found.' }, 404);
        if (update.status !== 'draft') return c.json({ error: 'Update is not in draft status.' }, 400);
        if (!update.ascLocalizationId) return c.json({ error: 'No ASC localization ID on this update.' }, 400);

        const credsResult = await loadCredentials(sql, tenantId);
        if (!credsResult.ok || !credsResult.value) {
          return c.json({ error: 'ASC credentials not configured.' }, 400);
        }

        const pushResult = await pushListingUpdate(credsResult.value, update.ascLocalizationId, fieldsResult.data);
        if (!pushResult.ok) {
          return c.json({ error: `ASC push failed: ${pushResult.error}` }, 502);
        }

        await setListingUpdateSubmitted(sql, updateId, fieldsResult.data);
        const updated = await getListingUpdateById(sql, tenantId, updateId);
        return c.json({ update: updated });
      } catch (e) {
        console.error('[listing-update/submit] failed:', e);
        return c.json({ error: 'Submit failed.' }, 500);
      }
    },
  }),

  registerApiRoute('/listing-update/:appId/current', {
    method: 'GET',
    handler: async (c) => {
      const tenantId = await getAuthenticatedTenantId(c);
      if (!tenantId) return c.json({ error: 'Unauthorized' }, 401);
      const sql = getPgSql();
      if (!sql) return c.json({ error: 'Database not configured.' }, 503);

      const appId = c.req.param('appId');
      if (!appId) return c.json({ error: 'Missing appId.' }, 400);

      try {
        const update = await getLatestListingUpdate(sql, tenantId, appId);
        return c.json({ update: update ?? null });
      } catch (e) {
        console.error('[listing-update/current] failed:', e);
        return c.json({ error: 'Lookup failed.' }, 500);
      }
    },
  }),
];

// Helper: extract numeric appId from an App Store URL
// e.g. https://apps.apple.com/app/id1234567890 → "1234567890"
function extractAppIdFromUrl(url: string): string {
  const match = /\/id(\d+)/.exec(url);
  return match?.[1] ?? '';
}
```

**Note:** The `job.appId` field reference assumes the audit job stores an appId. If it doesn't (the job only stores `url`), use `extractAppIdFromUrl(job.url)` exclusively. Read `job-store.ts` to confirm.

- [ ] **Step 4: Register routes in `apps/server/src/mastra/index.ts`**

Find the `apiRoutes` array in `index.ts` and add `...listingUpdateRoutes`:

```typescript
// Add at the top of the file with other route imports:
import { listingUpdateRoutes } from './listing-update-routes';

// In the Mastra constructor, add to apiRoutes:
apiRoutes: [...auditRoutes, ...authRoutes, ...healthRoutes, ...ascRoutes, ...trackingRoutes, ...costRoutes, ...listingUpdateRoutes, ...getWebStaticRoutes()],
```

- [ ] **Step 5: Run the Zod schema unit tests**

```bash
cd apps/server && npx vitest run src/mastra/listing-update-routes.test.ts
```

Expected: 3 tests PASS

- [ ] **Step 6: Run full server test suite**

```bash
cd apps/server && npx vitest run
```

Expected: PASS (no regressions)

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/mastra/listing-update-routes.ts \
        apps/server/src/mastra/listing-update-routes.test.ts \
        apps/server/src/mastra/index.ts
git commit -m "feat(p8b): add listing-update routes (generate, submit, current)"
```

---

## Task 5: Scheduler step — `check-listing-updates`

**Files:**
- Create: `apps/server/src/tracking/listing-update-checker.ts`
- Modify: `apps/server/src/tracking/scheduler.ts`

**Interfaces:**
- Consumes:
  - `getInFlightListingUpdates`, `setListingUpdateStatus` from `../queue/listing-update-store`
  - `loadCredentials` from `../asc/credential-store`
  - `signAscToken` from `../asc/credential-store`
  - `getGateway` from `../cost/gateway`
  - `insertChangeEvent` from `./store`
- Produces:
  ```ts
  export async function runListingUpdateCheck(sql: postgres.Sql): Promise<void>
  ```

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/tracking/listing-update-checker.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

const mockSql = vi.fn().mockResolvedValue([]) as unknown as postgres.Sql;

vi.mock('../queue/listing-update-store', () => ({
  getInFlightListingUpdates: vi.fn(),
  setListingUpdateStatus: vi.fn(),
}));

vi.mock('../asc/credential-store', () => ({
  loadCredentials: vi.fn(),
  signAscToken: vi.fn().mockReturnValue('mock-token'),
}));

vi.mock('../cost/gateway', () => ({
  getGateway: () => ({ fetch: vi.fn() }),
}));

vi.mock('./store', () => ({
  insertChangeEvent: vi.fn(),
}));

const mockGatewayFetch = vi.fn();
vi.mock('../cost/gateway', () => ({
  getGateway: () => ({ fetch: mockGatewayFetch }),
}));

describe('runListingUpdateCheck', () => {
  beforeEach(() => {
    vi.resetModules();
    mockGatewayFetch.mockReset();
  });

  it('does nothing when no in-flight updates', async () => {
    const { getInFlightListingUpdates } = await import('../queue/listing-update-store');
    vi.mocked(getInFlightListingUpdates).mockResolvedValue([]);
    const { runListingUpdateCheck } = await import('./listing-update-checker');
    await expect(runListingUpdateCheck(mockSql)).resolves.toBeUndefined();
    expect(mockGatewayFetch).not.toHaveBeenCalled();
  });

  it('marks update approved when ASC state is READY_FOR_SALE', async () => {
    const { getInFlightListingUpdates, setListingUpdateStatus } = await import('../queue/listing-update-store');
    const { loadCredentials } = await import('../asc/credential-store');
    const { insertChangeEvent } = await import('./store');

    vi.mocked(getInFlightListingUpdates).mockResolvedValue([{
      id: 'lu_1', tenantId: 'tenant1', appId: '123', status: 'submitted',
      ascLocalizationId: 'loc_1', auditJobId: null, proposedFields: {},
      appliedFields: null, rejectionReason: null, submittedAt: new Date(), resolvedAt: null, createdAt: new Date(),
    }]);
    vi.mocked(loadCredentials).mockResolvedValue({ ok: true, value: { keyId: 'K1', issuerId: 'I1', privateKeyPem: '---' } });
    mockGatewayFetch.mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'v1', attributes: { appStoreState: 'READY_FOR_SALE', versionString: '2.0' } }],
    }), { status: 200 }));

    const { runListingUpdateCheck } = await import('./listing-update-checker');
    await runListingUpdateCheck(mockSql);

    expect(setListingUpdateStatus).toHaveBeenCalledWith(
      mockSql, 'lu_1', 'approved', null, expect.any(Date),
    );
    expect(insertChangeEvent).toHaveBeenCalledWith(
      mockSql, 'tenant1',
      expect.objectContaining({ eventType: 'listing_update_resolved', payload: expect.objectContaining({ status: 'approved' }) }),
    );
  });

  it('marks update rejected when ASC state is REJECTED', async () => {
    const { getInFlightListingUpdates, setListingUpdateStatus } = await import('../queue/listing-update-store');
    const { loadCredentials } = await import('../asc/credential-store');

    vi.mocked(getInFlightListingUpdates).mockResolvedValue([{
      id: 'lu_2', tenantId: 'tenant1', appId: '123', status: 'in_review',
      ascLocalizationId: 'loc_1', auditJobId: null, proposedFields: {},
      appliedFields: null, rejectionReason: null, submittedAt: new Date(), resolvedAt: null, createdAt: new Date(),
    }]);
    vi.mocked(loadCredentials).mockResolvedValue({ ok: true, value: { keyId: 'K1', issuerId: 'I1', privateKeyPem: '---' } });
    mockGatewayFetch.mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'v1', attributes: { appStoreState: 'REJECTED', versionString: '2.0' } }],
    }), { status: 200 }));

    const { runListingUpdateCheck } = await import('./listing-update-checker');
    await runListingUpdateCheck(mockSql);

    expect(setListingUpdateStatus).toHaveBeenCalledWith(
      mockSql, 'lu_2', 'rejected', null, expect.any(Date),
    );
  });

  it('updates status to in_review when ASC state is IN_REVIEW', async () => {
    const { getInFlightListingUpdates, setListingUpdateStatus } = await import('../queue/listing-update-store');
    const { loadCredentials } = await import('../asc/credential-store');

    vi.mocked(getInFlightListingUpdates).mockResolvedValue([{
      id: 'lu_3', tenantId: 'tenant1', appId: '123', status: 'submitted',
      ascLocalizationId: 'loc_1', auditJobId: null, proposedFields: {},
      appliedFields: null, rejectionReason: null, submittedAt: new Date(), resolvedAt: null, createdAt: new Date(),
    }]);
    vi.mocked(loadCredentials).mockResolvedValue({ ok: true, value: { keyId: 'K1', issuerId: 'I1', privateKeyPem: '---' } });
    mockGatewayFetch.mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'v1', attributes: { appStoreState: 'IN_REVIEW', versionString: '2.0' } }],
    }), { status: 200 }));

    const { runListingUpdateCheck } = await import('./listing-update-checker');
    await runListingUpdateCheck(mockSql);

    expect(setListingUpdateStatus).toHaveBeenCalledWith(
      mockSql, 'lu_3', 'in_review', null, null,
    );
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd apps/server && npx vitest run src/tracking/listing-update-checker.test.ts
```

Expected: FAIL — `Cannot find module './listing-update-checker'`

- [ ] **Step 3: Create `apps/server/src/tracking/listing-update-checker.ts`**

```typescript
import type postgres from 'postgres';
import { getInFlightListingUpdates, setListingUpdateStatus } from '../queue/listing-update-store';
import type { ListingUpdate } from '../queue/listing-update-store';
import { loadCredentials, signAscToken } from '../asc/credential-store';
import { getGateway } from '../cost/gateway';
import { insertChangeEvent } from './store';

const ASC_BASE = 'https://api.appstoreconnect.apple.com';

const ASC_STATE_MAP: Record<string, 'in_review' | 'approved' | 'rejected' | null> = {
  WAITING_FOR_REVIEW: 'in_review',
  IN_REVIEW: 'in_review',
  PENDING_DEVELOPER_RELEASE: 'in_review',
  READY_FOR_SALE: 'approved',
  REJECTED: 'rejected',
  DEVELOPER_REJECTED: 'rejected',
};

async function checkOneUpdate(sql: postgres.Sql, update: ListingUpdate): Promise<void> {
  const credsResult = await loadCredentials(sql, update.tenantId);
  if (!credsResult.ok || !credsResult.value) return;

  const creds = credsResult.value;
  const token = signAscToken(creds.keyId, creds.issuerId, creds.privateKeyPem);
  const url = `${ASC_BASE}/v1/apps/${encodeURIComponent(update.appId)}/appStoreVersions?filter[platform]=IOS&limit=1&sort=-createdDate`;

  const res = await getGateway().fetch(url, { kind: 'app', upstream: 'asc' }, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return;

  const data = await res.json().catch(() => null);
  const version = data?.data?.[0];
  if (!version) return;

  const ascState: string = version.attributes?.appStoreState ?? '';
  const ourStatus = ASC_STATE_MAP[ascState] ?? null;

  if (!ourStatus || ourStatus === update.status) return;

  const isTerminal = ourStatus === 'approved' || ourStatus === 'rejected';
  const resolvedAt = isTerminal ? new Date() : null;

  // For rejections, attempt to fetch rejection reason from review detail
  let rejectionReason: string | null = null;
  if (ourStatus === 'rejected') {
    try {
      const detailUrl = `${ASC_BASE}/v1/appStoreVersions/${version.id}/appStoreReviewDetail`;
      const detailRes = await getGateway().fetch(detailUrl, { kind: 'app', upstream: 'asc' }, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (detailRes.ok) {
        const detail = await detailRes.json().catch(() => null);
        const reasons: string[] = detail?.data?.attributes?.contactEmail
          ? []
          : (detail?.data?.attributes?.rejectionReasons ?? []);
        rejectionReason = reasons.join('; ') || null;
      }
    } catch {
      // non-critical — rejection reason may not be available
    }
  }

  await setListingUpdateStatus(sql, update.id, ourStatus, rejectionReason, resolvedAt);

  if (isTerminal) {
    await insertChangeEvent(sql, update.tenantId, {
      appId: update.appId,
      country: 'us',
      eventType: 'listing_update_resolved',
      payload: {
        updateId: update.id,
        status: ourStatus,
        ...(rejectionReason ? { rejectionReason } : {}),
      },
    });
  }
}

export async function runListingUpdateCheck(sql: postgres.Sql): Promise<void> {
  const updates = await getInFlightListingUpdates(sql);
  for (const update of updates) {
    try {
      await checkOneUpdate(sql, update);
    } catch (e) {
      console.error(`[listing-update-check] error for update ${update.id}:`, e);
    }
  }
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd apps/server && npx vitest run src/tracking/listing-update-checker.test.ts
```

Expected: 4 tests PASS

- [ ] **Step 5: Add `runListingUpdateCheck` to the scheduler**

In `apps/server/src/tracking/scheduler.ts`, add the import and call it in `tick()`:

```typescript
// Add import at the top with other tracking imports:
import { runListingUpdateCheck } from './listing-update-checker';
```

In the `tick()` function, add a call AFTER the `for` loop that processes due apps (after `updateLastScanned`):

```typescript
async function tick(): Promise<void> {
  // ... existing getDueApps + for loop ...

  // After the per-app scan loop, check all in-flight listing updates:
  try {
    await runListingUpdateCheck(sql);
  } catch (e) {
    console.error('[tracking] runListingUpdateCheck failed:', e);
  }
}
```

- [ ] **Step 6: Run full server test suite**

```bash
cd apps/server && npx vitest run
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/tracking/listing-update-checker.ts \
        apps/server/src/tracking/listing-update-checker.test.ts \
        apps/server/src/tracking/scheduler.ts
git commit -m "feat(p8b): add check-listing-updates scheduler step"
```

---

## Task 6: Frontend — `ListingUpdatePanel`, `ListingUpdateDiff`, Activity Feed

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Create: `apps/web/src/components/ListingUpdateDiff.tsx`
- Create: `apps/web/src/components/ListingUpdatePanel.tsx`
- Modify: `apps/web/src/components/ActivityFeed.tsx`

**Interfaces:**
- Consumes from api.ts:
  ```ts
  export async function generateListingUpdate(auditJobId: string): Promise<GenerateResult>
  export async function submitListingUpdate(updateId: string, approvedFields: ProposedFields): Promise<SubmitResult>
  export async function getListingUpdateCurrent(appId: string): Promise<{ update: ListingUpdate | null }>
  ```
- Produces: `ListingUpdatePanel` accepts `{ auditJobId: string; appId: string }` props

**Note to implementer:** Before writing code, read `apps/web/src/lib/api.ts` in full to understand the fetch base URL convention, auth headers, and error-handling pattern used by existing functions like `startAudit` and `fetchActivity`. Replicate that pattern exactly.

Also read `apps/web/src/components/ActivityFeed.tsx` fully to understand the `ActivityCard` component structure and where to add the new event type.

- [ ] **Step 1: Write the failing test for `ListingUpdateDiff`**

Create `apps/web/src/components/ListingUpdateDiff.test.tsx`:

```typescript
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ListingUpdateDiff } from './ListingUpdateDiff';

describe('ListingUpdateDiff', () => {
  const baseProps = {
    fields: [
      { key: 'title', label: 'Title', current: 'Old Title', proposed: 'New Title', maxLength: 30 },
      { key: 'keywords', label: 'Keywords', current: 'a,b', proposed: 'a,b,c', maxLength: 100 },
    ],
    onChange: vi.fn(),
    onToggle: vi.fn(),
    checked: { title: true, keywords: true },
  };

  it('renders field rows', () => {
    render(<ListingUpdateDiff {...baseProps} />);
    expect(screen.getByText('Title')).toBeTruthy();
    expect(screen.getByText('Keywords')).toBeTruthy();
  });

  it('shows char counts', () => {
    render(<ListingUpdateDiff {...baseProps} />);
    // "New Title" = 9 chars, limit = 30
    expect(screen.getByText('9/30')).toBeTruthy();
  });

  it('shows red char count when over limit', () => {
    const over = {
      ...baseProps,
      fields: [{ key: 'title', label: 'Title', current: 'Old', proposed: 'A'.repeat(31), maxLength: 30 }],
    };
    render(<ListingUpdateDiff {...over} />);
    const counter = screen.getByText('31/30');
    expect(counter.className).toMatch(/red|danger|over/);
  });

  it('calls onChange when proposed value is edited', () => {
    const onChange = vi.fn();
    render(<ListingUpdateDiff {...baseProps} onChange={onChange} />);
    // The proposed value cell is contenteditable — simulate input
    const cells = document.querySelectorAll('[contenteditable="true"]');
    fireEvent.input(cells[0], { target: { innerText: 'Updated Title' } });
    expect(onChange).toHaveBeenCalledWith('title', 'Updated Title');
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd apps/web && npx vitest run src/components/ListingUpdateDiff.test.tsx
```

Expected: FAIL — `Cannot find module './ListingUpdateDiff'`

- [ ] **Step 3: Extend `apps/web/src/lib/api.ts`**

Read the file first, then add at the end (or near other audit-related functions):

```typescript
// — Listing Update types (mirrors server ProposedFields) —
export type ProposedFields = {
  title?: string;
  subtitle?: string;
  keywords?: string;
  description?: string;
  promotionalText?: string;
  releaseNotes?: string;
};

export type ListingUpdateStatus = 'draft' | 'submitted' | 'in_review' | 'approved' | 'rejected';

export interface ListingUpdate {
  id: string;
  tenantId: string;
  appId: string;
  auditJobId: string | null;
  proposedFields: ProposedFields;
  appliedFields: ProposedFields | null;
  ascLocalizationId: string | null;
  status: ListingUpdateStatus;
  rejectionReason: string | null;
  submittedAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface GenerateResult {
  updateId: string;
  proposedFields: ProposedFields;
  currentFields: Record<string, string | null>;
  status: ListingUpdateStatus;
}

export async function generateListingUpdate(auditJobId: string): Promise<GenerateResult> {
  const res = await apiFetch('/listing-update/generate', {
    method: 'POST',
    body: JSON.stringify({ auditJobId }),
  });
  if (!res.ok) throw new Error(`Generate failed: ${res.status}`);
  return res.json() as Promise<GenerateResult>;
}

export async function submitListingUpdate(
  updateId: string,
  approvedFields: ProposedFields,
): Promise<{ update: ListingUpdate }> {
  const res = await apiFetch('/listing-update/submit', {
    method: 'POST',
    body: JSON.stringify({ updateId, approvedFields }),
  });
  if (!res.ok) throw new Error(`Submit failed: ${res.status}`);
  return res.json() as Promise<{ update: ListingUpdate }>;
}

export async function getListingUpdateCurrent(appId: string): Promise<{ update: ListingUpdate | null }> {
  const res = await apiFetch(`/listing-update/${encodeURIComponent(appId)}/current`);
  if (!res.ok) throw new Error(`Current lookup failed: ${res.status}`);
  return res.json() as Promise<{ update: ListingUpdate | null }>;
}
```

**Note:** Replace `apiFetch` with whatever fetch wrapper the existing `api.ts` uses (could be `apiFetch`, `fetchApi`, or a plain `fetch` with a base URL). Read the file to find it.

Also extend `ActivityEvent` type to include the new event type:

```typescript
// Find the ActivityEvent type definition and add:
| { eventType: 'listing_update_resolved'; payload: { updateId: string; status: 'approved' | 'rejected'; rejectionReason?: string } }
```

- [ ] **Step 4: Create `apps/web/src/components/ListingUpdateDiff.tsx`**

```typescript
import React, { useRef } from 'react';
import type { ProposedFields } from '../lib/api';

const FIELD_LABELS: Record<string, string> = {
  title: 'Title',
  subtitle: 'Subtitle',
  keywords: 'Keywords',
  description: 'Description',
  promotionalText: 'Promotional Text',
  releaseNotes: "What's New",
};

const FIELD_LIMITS: Record<string, number> = {
  title: 30,
  subtitle: 30,
  keywords: 100,
  description: 4000,
  promotionalText: 170,
  releaseNotes: 4000,
};

export interface DiffField {
  key: keyof ProposedFields;
  label: string;
  current: string | null;
  proposed: string;
  maxLength: number;
}

interface ListingUpdateDiffProps {
  fields: DiffField[];
  checked: Partial<Record<keyof ProposedFields, boolean>>;
  onChange: (key: keyof ProposedFields, value: string) => void;
  onToggle: (key: keyof ProposedFields, checked: boolean) => void;
}

export function ListingUpdateDiff({ fields, checked, onChange, onToggle }: ListingUpdateDiffProps) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr style={{ borderBottom: '1px solid #333' }}>
          <th style={{ textAlign: 'left', padding: '6px 8px', width: 120 }}>Field</th>
          <th style={{ textAlign: 'left', padding: '6px 8px' }}>Current</th>
          <th style={{ textAlign: 'left', padding: '6px 8px' }}>Proposed</th>
          <th style={{ textAlign: 'center', padding: '6px 8px', width: 40 }}>✓</th>
        </tr>
      </thead>
      <tbody>
        {fields.map((field) => (
          <DiffRow
            key={field.key}
            field={field}
            isChecked={checked[field.key] !== false}
            onChange={onChange}
            onToggle={onToggle}
          />
        ))}
      </tbody>
    </table>
  );
}

function DiffRow({
  field,
  isChecked,
  onChange,
  onToggle,
}: {
  field: DiffField;
  isChecked: boolean;
  onChange: (key: keyof ProposedFields, value: string) => void;
  onToggle: (key: keyof ProposedFields, checked: boolean) => void;
}) {
  const editRef = useRef<HTMLDivElement>(null);
  const charCount = (editRef.current?.innerText ?? field.proposed).length;
  const isOver = charCount > field.maxLength;

  return (
    <tr style={{ borderBottom: '1px solid #222', opacity: isChecked ? 1 : 0.5 }}>
      <td style={{ padding: '8px', fontWeight: 500, verticalAlign: 'top' }}>{field.label}</td>
      <td style={{ padding: '8px', color: '#888', verticalAlign: 'top', maxWidth: 200, wordBreak: 'break-word' }}>
        {field.current ?? <em style={{ color: '#555' }}>—</em>}
      </td>
      <td style={{ padding: '8px', verticalAlign: 'top' }}>
        <div
          ref={editRef}
          contentEditable
          suppressContentEditableWarning
          onInput={(e) => onChange(field.key, (e.target as HTMLDivElement).innerText)}
          style={{
            minHeight: 24,
            outline: 'none',
            borderBottom: '1px solid #444',
            paddingBottom: 2,
            wordBreak: 'break-word',
          }}
        >
          {field.proposed}
        </div>
        <span style={{ fontSize: 11, color: isOver ? '#f55' : '#666' }}>
          {charCount}/{field.maxLength}
        </span>
      </td>
      <td style={{ padding: '8px', textAlign: 'center', verticalAlign: 'top' }}>
        <input
          type="checkbox"
          checked={isChecked}
          onChange={(e) => onToggle(field.key, e.target.checked)}
        />
      </td>
    </tr>
  );
}

// Helper: build DiffField array from a ProposedFields object and current values
export function buildDiffFields(
  proposed: ProposedFields,
  current: Record<string, string | null>,
): DiffField[] {
  return (Object.keys(proposed) as Array<keyof ProposedFields>)
    .filter((key) => proposed[key] !== undefined)
    .map((key) => ({
      key,
      label: FIELD_LABELS[key] ?? key,
      current: current[key] ?? null,
      proposed: proposed[key]!,
      maxLength: FIELD_LIMITS[key] ?? 4000,
    }));
}
```

- [ ] **Step 5: Run `ListingUpdateDiff` tests**

```bash
cd apps/web && npx vitest run src/components/ListingUpdateDiff.test.tsx
```

Expected: 4 tests PASS (char count display, red state, onChange callback, field rendering)

- [ ] **Step 6: Create `apps/web/src/components/ListingUpdatePanel.tsx`**

```typescript
import React, { useState, useCallback } from 'react';
import {
  generateListingUpdate,
  submitListingUpdate,
  type ProposedFields,
  type ListingUpdate,
} from '../lib/api';
import { ListingUpdateDiff, buildDiffFields } from './ListingUpdateDiff';

type PanelState =
  | { phase: 'idle' }
  | { phase: 'generating' }
  | { phase: 'draft'; update: ListingUpdate; currentFields: Record<string, string | null>; edits: ProposedFields; checked: Partial<Record<keyof ProposedFields, boolean>> }
  | { phase: 'submitting' }
  | { phase: 'submitted'; update: ListingUpdate }
  | { phase: 'error'; message: string };

interface ListingUpdatePanelProps {
  auditJobId: string;
  appId: string;
  existingUpdate?: ListingUpdate | null;
}

export function ListingUpdatePanel({ auditJobId, appId, existingUpdate }: ListingUpdatePanelProps) {
  const [state, setState] = useState<PanelState>(() => {
    if (!existingUpdate) return { phase: 'idle' };
    if (existingUpdate.status === 'draft') return { phase: 'idle' }; // will re-generate
    return { phase: 'submitted', update: existingUpdate };
  });

  const handleGenerate = useCallback(async () => {
    setState({ phase: 'generating' });
    try {
      const result = await generateListingUpdate(auditJobId);
      const initialEdits = { ...result.proposedFields };
      const initialChecked: Partial<Record<keyof ProposedFields, boolean>> = {};
      (Object.keys(initialEdits) as Array<keyof ProposedFields>).forEach((k) => {
        initialChecked[k] = true;
      });
      setState({
        phase: 'draft',
        update: { ...existingUpdate, id: result.updateId, status: 'draft', proposedFields: result.proposedFields } as ListingUpdate,
        currentFields: result.currentFields,
        edits: initialEdits,
        checked: initialChecked,
      });
    } catch (e) {
      setState({ phase: 'error', message: String(e) });
    }
  }, [auditJobId, existingUpdate]);

  const handleFieldChange = useCallback((key: keyof ProposedFields, value: string) => {
    setState((prev) => {
      if (prev.phase !== 'draft') return prev;
      return { ...prev, edits: { ...prev.edits, [key]: value } };
    });
  }, []);

  const handleToggle = useCallback((key: keyof ProposedFields, checked: boolean) => {
    setState((prev) => {
      if (prev.phase !== 'draft') return prev;
      return { ...prev, checked: { ...prev.checked, [key]: checked } };
    });
  }, []);

  const handleSubmit = useCallback(async () => {
    if (state.phase !== 'draft') return;
    const approvedFields: ProposedFields = {};
    (Object.keys(state.edits) as Array<keyof ProposedFields>).forEach((key) => {
      if (state.checked[key] !== false && state.edits[key] !== undefined) {
        (approvedFields as Record<string, string>)[key] = state.edits[key]!;
      }
    });
    setState({ phase: 'submitting' });
    try {
      const result = await submitListingUpdate(state.update.id, approvedFields);
      setState({ phase: 'submitted', update: result.update });
    } catch (e) {
      setState({ phase: 'error', message: String(e) });
    }
  }, [state]);

  if (state.phase === 'idle') {
    const isRejected = existingUpdate?.status === 'rejected';
    return (
      <div style={{ marginTop: 16 }}>
        {isRejected && (
          <div style={{ marginBottom: 8, color: '#f55', fontSize: 13 }}>
            Apple rejected the last submission
            {existingUpdate?.rejectionReason ? `: ${existingUpdate.rejectionReason}` : ''}.
          </div>
        )}
        <button onClick={handleGenerate} style={{ padding: '8px 16px', cursor: 'pointer' }}>
          {isRejected ? 'Fix and Resubmit' : 'Apply to Listing'}
        </button>
      </div>
    );
  }

  if (state.phase === 'generating') {
    return <div style={{ marginTop: 16, color: '#888' }}>Generating new values…</div>;
  }

  if (state.phase === 'draft') {
    const diffFields = buildDiffFields(state.edits, state.currentFields);
    return (
      <div style={{ marginTop: 16 }}>
        <ListingUpdateDiff
          fields={diffFields}
          checked={state.checked}
          onChange={handleFieldChange}
          onToggle={handleToggle}
        />
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <button onClick={handleSubmit} style={{ padding: '8px 16px', cursor: 'pointer' }}>
            Submit to ASC
          </button>
          <button onClick={() => setState({ phase: 'idle' })} style={{ padding: '8px 16px', cursor: 'pointer', opacity: 0.7 }}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (state.phase === 'submitting') {
    return <div style={{ marginTop: 16, color: '#888' }}>Submitting to App Store Connect…</div>;
  }

  if (state.phase === 'submitted') {
    const statusLabels: Record<string, string> = {
      submitted: 'Submitted — waiting for Apple review',
      in_review: 'In Review',
      approved: 'Approved ✓',
      rejected: 'Rejected',
    };
    return (
      <div style={{ marginTop: 16 }}>
        <div style={{ fontSize: 13, color: state.update.status === 'approved' ? '#4f4' : '#aaa' }}>
          {statusLabels[state.update.status] ?? state.update.status}
        </div>
      </div>
    );
  }

  if (state.phase === 'error') {
    return (
      <div style={{ marginTop: 16 }}>
        <div style={{ color: '#f55', fontSize: 13, marginBottom: 8 }}>{state.message}</div>
        <button onClick={() => setState({ phase: 'idle' })} style={{ padding: '6px 12px', cursor: 'pointer' }}>
          Try Again
        </button>
      </div>
    );
  }

  return null;
}
```

- [ ] **Step 7: Add `listing_update_resolved` card to `ActivityFeed.tsx`**

Open `apps/web/src/components/ActivityFeed.tsx`. Find the `ActivityCard` component (or wherever `eventType` is switched on). Add handling for the new event type:

```typescript
// Find the block that renders different event types and add:
if (event.eventType === 'listing_update_resolved') {
  const p = event.payload as { status: 'approved' | 'rejected'; rejectionReason?: string };
  const isApproved = p.status === 'approved';
  return (
    <div style={{
      padding: '12px 16px',
      borderLeft: `3px solid ${isApproved ? '#4f4' : '#f55'}`,
      marginBottom: 8,
      background: '#1a1a1a',
    }}>
      <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>
        {new Date(event.createdAt).toLocaleDateString()} · {event.appName}
      </div>
      <div style={{ fontWeight: 500 }}>
        {isApproved ? '✓ Your listing update was approved' : '✗ Apple rejected your listing update'}
      </div>
      {!isApproved && p.rejectionReason && (
        <div style={{ fontSize: 13, color: '#aaa', marginTop: 4 }}>{p.rejectionReason}</div>
      )}
    </div>
  );
}
```

Also update the `ActivityEvent` type union in `api.ts` if it hasn't been updated yet (it should have been in Step 3).

- [ ] **Step 8: Run `ListingUpdateDiff` tests again to confirm still passing**

```bash
cd apps/web && npx vitest run src/components/ListingUpdateDiff.test.tsx
```

Expected: 4 tests PASS

- [ ] **Step 9: Run full web test suite**

```bash
cd apps/web && npx vitest run
```

Expected: PASS (no regressions)

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/lib/api.ts \
        apps/web/src/components/ListingUpdateDiff.tsx \
        apps/web/src/components/ListingUpdateDiff.test.tsx \
        apps/web/src/components/ListingUpdatePanel.tsx \
        apps/web/src/components/ActivityFeed.tsx
git commit -m "feat(p8b): add ListingUpdatePanel, ListingUpdateDiff, Activity Feed card"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| Generate button in audit report | Task 6 — `ListingUpdatePanel` |
| Lazy LLM call on click | Task 4 — generate route |
| Diff panel with inline-editable proposed values | Task 6 — `ListingUpdateDiff` |
| Char counters turning red over limit | Task 6 — `ListingUpdateDiff` char counter |
| Per-field checkboxes | Task 6 — `ListingUpdateDiff` checkbox column |
| Submit to ASC via PATCH | Task 3 — `pushListingUpdate`, Task 4 — submit route |
| Status badge draft → submitted → in_review → approved/rejected | Task 6 — `ListingUpdatePanel` states |
| Hourly scheduler polls ASC state | Task 5 — `runListingUpdateCheck` in scheduler |
| `listing_update_resolved` change event on terminal state | Task 5 — `checkOneUpdate` |
| Activity Feed card for approved/rejected | Task 6 — `ActivityFeed.tsx` |
| Rejection re-generation with reason as context | Task 4 — `buildGeneratePrompt` rejectionContext, Task 6 — "Fix and Resubmit" button |
| One non-terminal update per (tenant_id, app_id) | Task 4 — generate route 409 check |
| ASC localizationId for write | Task 2 — `listing-client.ts` extension |
| Field name mapping (title→name, releaseNotes→whatsNew) | Task 3 — `toAscAttributes` |
| JSONB fields in Postgres-only migration | Task 1 — `PG_ONLY_MIGRATIONS` |

**Known limitations (out of scope per spec):**
- `fetchAscListingData` only returns `keywords` and `promotionalText` — title, subtitle, description are `null` in `currentFields`. The diff will show `—` for these. Extending `fetchAscListingData` to return all 6 fields is a natural follow-on.
- `whatsNew` skip logic (no in-progress binary) is not enforced — the LLM may propose `releaseNotes` even if no binary version is staged. Add a pre-submit check in the submit route if needed.
- Rejection reason from ASC review detail API is best-effort — the endpoint may not return structured reasons on all rejection types.
