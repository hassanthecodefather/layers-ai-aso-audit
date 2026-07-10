# P7-A: ASC Auth + Read Client — Design Spec

> **Sub-spec A of P7 · Connected & Always-On**
> Part of the phased ASO Agent build plan (specification.md v1.3.2).
> Sub-specs: **A (this)** → B (continuous tracking) → C (measurement windows) → D (cost economics)

---

## Goal

Build the complete App Store Connect read client — end to end: per-tenant credential
storage (encrypted), a settings screen to connect/disconnect, JWT signing, a
synchronous version-status reader, and an async two-phase analytics reports client.

No scheduling, no measurement windows, no write scopes — just connect, store, and read.

---

## Architecture overview

```
apps/server/src/asc/
  auth.ts              — pure JWT signing utility (no network, no class)
  versions-client.ts   — AppStoreVersionsClient interface + impl + stub + noop + factory
  analytics-client.ts  — AscAnalyticsClient interface + impl + stub + noop + factory
  credential-store.ts  — per-tenant encrypted credential read/write
  routes.ts            — /api/settings/asc PUT | GET | DELETE

apps/web/src/
  components/AscSettings.tsx   — settings modal (connect / disconnect)
  lib/api.ts                   — add getAscStatus(), saveAscCredentials(), deleteAscCredentials()
```

All HTTP calls route through the existing `getGateway()` cost tracker. All server
functions return `Result<T, AscError>` — no throws.

---

## Section 1: Credential storage

### DB table (migration added to `pg-migrate.ts`)

```sql
CREATE TABLE IF NOT EXISTS aso_asc_credentials (
  tenant_id        TEXT PRIMARY KEY,
  key_id           TEXT NOT NULL,          -- not secret, stored plain
  issuer_id        TEXT NOT NULL,          -- not secret, stored plain
  private_key_enc  TEXT NOT NULL,          -- AES-256-GCM encrypted (see below)
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
```

### Encryption

AES-256-GCM. Key comes from a new required env var `ASC_ENCRYPTION_KEY` (32-byte
base64). A fresh 12-byte IV is generated per encryption. The stored string is:

```
base64(iv):base64(authTag):base64(ciphertext)
```

`ASC_ENCRYPTION_KEY` is added to `env.ts` validation as always-required (simpler than
conditional validation — if the key is not set, startup fails with a clear message). Uses
Node built-in `crypto.createCipheriv('aes-256-gcm', …)` — no extra deps.

### `credential-store.ts`

```ts
interface AscCredentials {
  keyId: string;
  issuerId: string;
  privateKeyPem: string;   // decrypted at read time
}

async function saveCredentials(sql, tenantId, creds: AscCredentials): Promise<Result<void, AscError>>
async function loadCredentials(sql, tenantId): Promise<Result<AscCredentials | null, AscError>>
async function deleteCredentials(sql, tenantId): Promise<Result<void, AscError>>
```

The `.p8` private key is accepted as raw PEM (`-----BEGIN EC PRIVATE KEY-----…`) or
base64-encoded — both normalised to PEM on save.

---

## Section 2: Settings API (`routes.ts`)

Three routes registered via `registerApiRoute`, behind the existing auth middleware:

| Method | Path | Body / Response |
|---|---|---|
| `PUT` | `/api/settings/asc` | `{ keyId, issuerId, privateKey }` → `204` |
| `GET` | `/api/settings/asc` | `{ connected: boolean, keyId: string \| null }` — private key never returned |
| `DELETE` | `/api/settings/asc` | `204` |

`PUT` validates that the supplied credentials can successfully sign a JWT and call
`GET /v1/apps` (a cheap list call) before persisting — so a typo fails fast at save
time rather than silently at first tracking run.

---

## Section 3: Settings UI (`AscSettings.tsx`)

A modal accessible via a gear icon in the existing `Header` component. No new router.

**Disconnected state:** a single "Connect App Store Connect" button plus a short
explanation ("Required to measure real impressions and downloads").

**Connect form (three fields):**
- Key ID (text input)
- Issuer ID (text input)
- Private Key (textarea — paste the `.p8` file contents, or upload file)

On submit: calls `PUT /api/settings/asc`, shows inline loading state, shows success
confirmation ("Connected — Key ID: XXXXXXXX") or inline error on failure.

**Connected state:** shows `{ connected: true, keyId }` with a "Disconnect" button
that calls `DELETE /api/settings/asc`.

---

## Section 4: JWT auth (`auth.ts`)

Pure function — no network, no state:

```ts
function signAscToken(keyId: string, issuerId: string, privateKeyPem: string): string
```

- **Algorithm:** ES256
- **Header:** `{ alg: 'ES256', kid: keyId, typ: 'JWT' }`
- **Payload:** `{ iss: issuerId, iat: now, exp: now + 20min, aud: 'appstoreconnect-v1' }`
- **Signing:** Node built-in `crypto` — no extra deps
- **No token cache:** signing is cheap; a stale cached token causes a hard auth failure

Both clients load credentials from `credential-store.ts` once per request and call
`signAscToken` fresh — no cached tokens.

---

## Section 5: Versions client (`versions-client.ts`)

```ts
interface AppStoreVersionsClient {
  getAppVersions(appId: string): Promise<Result<AppVersion[], AscError>>;
}

type AppVersion = {
  versionString: string;
  state: string;                  // 'READY_FOR_SALE' | 'PENDING_DEVELOPER_RELEASE' | ...
  createdDate: string;            // ISO-8601
  earliestReleaseDate: string | null;
};
```

`GET https://api.appstoreconnect.apple.com/v1/apps/{appId}/appStoreVersions?filter[platform]=IOS`

Returns newest-first. B's go-live detection reads `state` and `createdDate` off the
top version.

**Implementations:** `AppleAppStoreVersionsClient` (real) · `NoOpAppStoreVersionsClient`
(returns `[]`) · `StubAppStoreVersionsClient` (canned result) · `getAppStoreVersionsClient(tenantId, sql)`

---

## Section 6: Analytics client (`analytics-client.ts`)

### Interface

```ts
interface AscAnalyticsClient {
  createReportRequest(
    type: ReportType,
    filters: ReportFilters,
  ): Promise<Result<string, AscError>>;
  // Returns Apple's reportRequestId — caller persists it

  pollReportInstance(
    requestId: string,
  ): Promise<Result<ReportPollResult, AscError>>;
}

type ReportType = 'APP_STORE_ENGAGEMENT';   // grows as later sub-specs need more

type ReportFilters = {
  appId: string;
  frequency: 'DAILY';
  startDate: string;   // YYYY-MM-DD
  endDate: string;     // YYYY-MM-DD
};

type ReportRow = {
  date: string;
  impressions: number;
  downloads: number;
  conversionRate: number;
  territory: string;
};

type ReportPollResult =
  | { status: 'pending' }
  | { status: 'ready'; rows: ReportRow[] };
```

`pollReportInstance` walks Apple's nested chain (`reportRequest → reports → instances
→ segments → download`) and hides it — only typed `ReportRow[]` surfaces to callers.
Returns `{ status: 'pending' }` when Apple hasn't finished; no internal sleep loop.

**Implementations:** `AppleAscAnalyticsClient` (real) · `NoOpAscAnalyticsClient`
(`createReportRequest` → fake id; `pollReportInstance` → `{ status: 'pending' }`) ·
`StubAscAnalyticsClient` (canned) · `getAscAnalyticsClient(tenantId, sql)`

---

## Section 7: Error types

```ts
type AscError =
  | { kind: 'auth_failed';    status: number }
  | { kind: 'not_found';      appId: string }
  | { kind: 'rate_limited';   retryAfterMs: number }
  | { kind: 'api_error';      status: number; detail: string }
  | { kind: 'parse_error';    raw: string }
  | { kind: 'no_credentials'; tenantId: string };
```

`rate_limited` honours `Retry-After` verbatim, consistent with the iTunes pacer.
`no_credentials` surfaces when a tenant hasn't connected yet — B uses this to skip
tracking for unconnected tenants rather than throwing.

---

## Section 8: Testing

| Test | What |
|---|---|
| `auth.test.ts` | `signAscToken` produces correct `kid`, `iss`, `aud`, expiry; base64 key input round-trips |
| `credential-store.test.ts` | encrypt → save → load → decrypt round-trip; PEM and base64 key inputs both normalise correctly |
| `routes.test.ts` | `PUT` validation fires on bad key; `GET` returns masked status; `DELETE` removes row |
| `versions-client.test.ts` | Stub returns canned data; NoOp returns `[]`; live smoke guarded by `test.skip` when no `ASC_KEY_ID` |
| `analytics-client.test.ts` | Stub returns `ready`; NoOp returns `pending`; live smoke guarded |
| `AscSettings.test.tsx` | Connect form submits correctly; connected state shows key ID; disconnect calls DELETE |

---

## New env var

| Var | Required | Description |
|---|---|---|
| `ASC_ENCRYPTION_KEY` | Always required | 32-byte base64 key for AES-256-GCM encryption of stored private keys |

Added to `env.ts` validation.

---

## Acceptance criteria

- Encrypt → save → load → decrypt round-trips the `.p8` key without loss
- `PUT /api/settings/asc` with bad credentials returns a validation error before persisting
- `GET /api/settings/asc` never returns the private key
- `getAppVersions(appId)` returns correct `state` for a real app (live smoke)
- `createReportRequest()` returns a non-empty `requestId` from Apple (live smoke)
- `pollReportInstance(requestId)` returns `pending` or `ready` without throwing (live smoke)
- `no_credentials` error returned gracefully when tenant has no credentials stored
- All ASC HTTP calls appear in gateway telemetry

---

## What this sub-spec deliberately excludes

- Scheduling or polling loops (sub-spec B)
- `aso_asc_report_requests` table — B owns persistence of pending requestIds
- `aso_measurement_windows` table (sub-spec C)
- Write scopes (Phase 8)
- Per-tenant credential rotation UI

---

## Assumption to verify at build-start

The exact `reportRequest → instance → poll` lifecycle of the Analytics Reports API
(flagged in specification.md §H). The implementation of `pollReportInstance` must be
validated against real Apple API responses before being considered complete. Creds
are available locally for live smoke testing.
