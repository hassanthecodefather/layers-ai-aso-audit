# Phase 6a — Auth & Tenant Isolation Design

## Goal

Add open-signup email/password authentication and strict per-user tenant isolation so that a second user can register and audit apps without ever seeing another user's data.

## Context

The beta ran as a single-operator tool with no auth. Phase 6a is the first correctness gate: the moment user #2 exists, the single-tenant shortcuts become bugs. This spec covers the auth + isolation sub-phase of 6a. The shared rate limiter (Redis) and Postgres swap are separate specs.

## Architecture

Three layers of change:

1. **Data model** — new user + refresh-token tables; `tenant_id` column added to every `aso_*` table.
2. **Server** — auth endpoints (signup / login / refresh / logout) + JWT middleware protecting all `/audit/*` routes; `tenantId` threaded through every storage call.
3. **Frontend** — login/signup forms; access token in memory; httpOnly refresh cookie; silent 401 → refresh → retry.

One user = one tenant. No team workspaces in this phase.

---

## Section 1: Data Model

### New tables (appended to `migrate.ts`)

```sql
CREATE TABLE IF NOT EXISTS aso_users (
  id           TEXT PRIMARY KEY,   -- UUID v4
  email        TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,     -- bcrypt, cost 12
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS aso_refresh_tokens (
  id          TEXT PRIMARY KEY,    -- UUID v4
  user_id     TEXT NOT NULL REFERENCES aso_users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,       -- sha256(raw_token), raw never stored
  expires_at  TEXT NOT NULL,       -- ISO-8601, 7 days from issue
  revoked_at  TEXT,                -- nullable; set on rotate or logout
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS aso_refresh_tokens_user
  ON aso_refresh_tokens (user_id, revoked_at);
```

### Tenant column migration (one ALTER per existing table)

```sql
ALTER TABLE aso_listing_snapshots    ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE aso_recommendations      ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE aso_rec_occurrences      ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE aso_identity_versions    ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE aso_competitor_tombstones ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
```

### New composite indexes (replace existing `(app_id, country)` indexes)

```sql
CREATE INDEX IF NOT EXISTS aso_listing_snapshots_tenant_app
  ON aso_listing_snapshots (tenant_id, app_id, country, fetched_at DESC);

CREATE INDEX IF NOT EXISTS aso_recommendations_tenant_app
  ON aso_recommendations (tenant_id, app_id, country);

CREATE INDEX IF NOT EXISTS aso_identity_versions_tenant_app
  ON aso_identity_versions (tenant_id, app_id, country, version DESC);

CREATE INDEX IF NOT EXISTS aso_competitor_tombstones_tenant_app
  ON aso_competitor_tombstones (tenant_id, app_id, country);
```

**Migration safety:** `DEFAULT 'default'` means all existing single-user beta data migrates forward without data loss. The existing indexes are left in place (SQLite allows duplicates; Postgres will too — they are harmless extra indexes).

---

## Section 2: Auth Endpoints

### File

`apps/server/src/mastra/routes/auth-routes.ts` — registered in `mastra/index.ts` alongside `auditRoutes`.

### Endpoints

| Method | Path | Auth required | Body | Response |
|---|---|---|---|---|
| POST | `/auth/signup` | No | `{ email, password }` | `{ userId, accessToken }` + refresh cookie |
| POST | `/auth/login` | No | `{ email, password }` | `{ userId, accessToken }` + refresh cookie |
| POST | `/auth/refresh` | No (cookie) | — | `{ accessToken }` + new refresh cookie |
| POST | `/auth/logout` | No (cookie) | — | `{}` + cleared cookie |

### Token details

**Access token**
- JWT, signed with `ASO_JWT_SECRET` env var (HS256)
- Payload: `{ sub: userId, iat, exp }`, expires in 15 minutes
- Returned in JSON response body — frontend stores in memory

**Refresh token**
- 32-byte random hex string generated with `crypto.randomBytes(32)`
- Stored as `sha256(token)` in `aso_refresh_tokens` — raw token never persisted
- Set as `httpOnly; SameSite=Strict; Secure` cookie, `Max-Age: 604800` (7 days)
- Never returned in the response body

**Refresh rotation**
- Every `/auth/refresh` call issues a new refresh token and marks the old one `revoked_at = now`
- If the presented token is already revoked (reuse detected): delete **all** refresh tokens for that user (full family revocation), return 401 — forces re-login

**Password hashing**
- `bcryptjs` (pure JS, no native build), cost factor 12
- On signup: `bcrypt.hash(password, 12)`
- On login: `bcrypt.compare(password, stored_hash)`

**Validation**
- Email: must contain `@` and a `.` after it; normalised to lowercase
- Password: minimum 8 characters
- Return 400 with `{ error: string }` on validation failure
- Return 409 on duplicate email at signup
- Return 401 with generic message on bad credentials at login (no user enumeration)

---

## Section 3: JWT Middleware

### File

`apps/server/src/mastra/middleware/auth.ts`

### Behaviour

```typescript
// Hono middleware — reads Authorization: Bearer <token>
// Verifies signature (ASO_JWT_SECRET) and expiry
// On success: sets c.set('tenantId', payload.sub) and calls next()
// On failure: returns 401 { error: 'Unauthorized' }
export const requireAuth: MiddlewareHandler
```

Applied in `routes.ts` to every `/audit/*` route. The `/auth/*` routes are public — no middleware.

The route handler reads `c.get('tenantId')` and passes it as part of the workflow trigger input. `audit-workflow.ts` receives it in its typed input schema and threads it to every storage call.

**JWT library:** `jose` — Web Crypto API, works in Node 18+, no native bindings. Add to `apps/server/package.json`.

---

## Section 4: StorageClient Tenant Isolation

### Interface change (`storage-client.ts`)

Every method gains `tenantId: string` as its **first** parameter:

```typescript
export interface StorageClient {
  putSnapshot(tenantId: string, s: ListingSnapshot): Promise<Result<void>>;
  latestSnapshot(tenantId: string, appId: string, country: string): Promise<Result<ListingSnapshot | null>>;
  upsertRecommendation(tenantId: string, r: LedgerRecommendation): Promise<Result<void>>;
  recordOccurrence(tenantId: string, recId: string, snapshotId: string, wasDismissed: boolean): Promise<Result<void>>;
  ledger(tenantId: string, appId: string, country: string): Promise<Result<LedgerRecommendation[]>>;
  appendIdentity(tenantId: string, v: IdentityVersion): Promise<Result<void>>;
  latestIdentity(tenantId: string, appId: string, country: string): Promise<Result<IdentityVersion | null>>;
  maxIdentityVersion(tenantId: string, appId: string, country: string): Promise<Result<number>>;
  tombstoneCompetitor(tenantId: string, appId: string, country: string, competitorAppId: string): Promise<Result<void>>;
  tombstones(tenantId: string, appId: string, country: string): Promise<Result<Set<string>>>;
}
```

### LibSQLStorageClient changes

Every SQL query gains `AND tenant_id = ?` in WHERE clauses and `tenant_id` in INSERT column lists. No logic changes — purely mechanical SQL additions.

### Workflow changes (`audit-workflow.ts`)

The workflow input schema gains `tenantId: string`. Every call to a storage method passes it as the first argument. The route handler injects it from `res.locals.tenantId` when triggering the workflow.

### Conformance suite changes (`storage-client.conformance.ts`)

- All test helper calls gain `'tenant-test'` as the first argument (mechanical)
- **One new cross-tenant isolation test added:**
  ```
  write snapshot under tenant 'tenant-A'
  read latestSnapshot under tenant 'tenant-B'
  assert result === null
  ```
  This test is the 6a DoD gate — it must pass against both LibSQL and (at Postgres swap time) Postgres.

---

## Section 5: Frontend

### New files

- `apps/web/src/lib/auth.tsx` — `AuthContext` + `AuthProvider`
- `apps/web/src/components/LoginForm.tsx`
- `apps/web/src/components/SignupForm.tsx`

### Auth context

```typescript
interface AuthState {
  userId: string | null;
  accessToken: string | null;
}
// Exposed: login(email, password), signup(email, password), logout(), refreshToken()
```

Access token stored in React state (memory) — never `localStorage` or `sessionStorage`. Refresh token lives in the httpOnly cookie; the frontend never reads it.

### App shell (`App.tsx`)

If `accessToken === null`: render `<LoginForm>` / `<SignupForm>` toggle. If set: render the existing chat UI (unchanged). No routing library needed — simple conditional render.

### API layer (`apps/web/src/lib/api.ts`)

Every fetch adds `Authorization: Bearer <accessToken>` header. A 401 response triggers:
1. One silent call to `POST /auth/refresh` (cookie sent automatically)
2. On success: update `accessToken` in context, retry the original request
3. On failure (refresh also 401): clear auth state → show login form

### No password reset in this phase

Email delivery (SendGrid/etc.) is not wired up. Recovery path: log out and create a new account. A `TODO` comment marks the reset endpoint as a future addition.

---

## Definition of Done (6a auth)

From `specification.md §F`:

> **6a:** two tenants fully isolated (cross-tenant read returns nothing)

Specific tests:
1. `storage-client.conformance.ts` cross-tenant isolation test passes (LibSQL)
2. `POST /auth/signup` → `POST /auth/login` → `POST /audit/identify` (with token) returns 200
3. `POST /audit/identify` without token returns 401
4. Refresh token reuse (present revoked token) → 401 + all user tokens revoked
5. Two users each audit the same app → each sees only their own snapshots + ledger

---

## New environment variables

| Variable | Purpose | Required |
|---|---|---|
| `ASO_JWT_SECRET` | HMAC secret for signing JWTs | Yes |

---

## New dependencies

| Package | Used for |
|---|---|
| `bcryptjs` | Password hashing (pure JS) |
| `@types/bcryptjs` | TypeScript types |
| `jose` | JWT sign + verify (Web Crypto) |
