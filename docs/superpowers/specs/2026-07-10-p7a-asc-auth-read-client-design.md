# P7-A: ASC Auth + Read Client — Design Spec

> **Sub-spec A of P7 · Connected & Always-On**
> Part of the phased ASO Agent build plan (specification.md v1.3.2).
> Sub-specs: **A (this)** → B (continuous tracking) → C (measurement windows) → D (cost economics)

---

## Goal

Build the App Store Connect read client that every downstream P7 sub-spec depends on:
JWT signing from env-var credentials, a synchronous version-status reader, and an
async two-phase analytics reports client. No scheduling, no storage writes, no UI —
just the authenticated API surface.

## Credentials

Env vars (all optional — absent → no-op client activates, all tests pass without real creds):

| Var | Description |
|---|---|
| `ASC_KEY_ID` | Key ID from App Store Connect → Users & Access → Keys |
| `ASC_ISSUER_ID` | Issuer ID from the same page |
| `ASC_PRIVATE_KEY` | Contents of the `.p8` file — raw PEM (`-----BEGIN EC PRIVATE KEY-----…`) or base64-encoded, both accepted |

Credential UX is env-var / operator-managed for now. Per-tenant credential UI is a
later sub-spec.

---

## Architecture

```
apps/server/src/asc/
  auth.ts              — pure JWT signing utility (no network, no class)
  versions-client.ts   — AppStoreVersionsClient: getAppVersions(appId)
  analytics-client.ts  — AscAnalyticsClient: createReportRequest() + pollReportInstance()
  types.ts             — shared domain types
```

All HTTP calls route through the existing `getGateway()` cost tracker so ASC calls
appear in telemetry alongside iTunes and Gemini. All return `Result<T, AscError>` —
no throws — consistent with the rest of the codebase.

---

## Section 1: JWT auth (`auth.ts`)

Pure function, no state, no network:

```ts
function signAscToken(keyId: string, issuerId: string, privateKeyPem: string): string
```

- **Algorithm:** ES256
- **Header:** `{ alg: 'ES256', kid: keyId, typ: 'JWT' }`
- **Payload:** `{ iss: issuerId, iat: now, exp: now + 20min, aud: 'appstoreconnect-v1' }`
- **Signing:** Node built-in `crypto` — no extra deps
- **Token lifetime:** 20 minutes (Apple's documented maximum)
- **No token cache:** signing is cheap; a stale cached token causes a hard auth failure
  that's harder to debug than signing fresh on each request

`ASC_PRIVATE_KEY` format handling: if the value starts with `-----BEGIN`, treat as
raw PEM; otherwise base64-decode first.

---

## Section 2: Versions client (`versions-client.ts`)

### Interface

```ts
interface AppStoreVersionsClient {
  getAppVersions(appId: string): Promise<Result<AppVersion[], AscError>>;
}

type AppVersion = {
  versionString: string;
  state: string;                  // e.g. 'READY_FOR_SALE' | 'PENDING_DEVELOPER_RELEASE'
  createdDate: string;            // ISO-8601
  earliestReleaseDate: string | null;
};
```

### API call

`GET https://api.appstoreconnect.apple.com/v1/apps/{appId}/appStoreVersions?filter[platform]=IOS`

Returns the list sorted newest-first. B's go-live detection reads
`state === 'READY_FOR_SALE'` and `createdDate` off the top version.

### Implementations

- **`AppleAppStoreVersionsClient`** — real HTTP implementation
- **`NoOpAppStoreVersionsClient`** — returns `[]` when env vars absent
- **`StubAppStoreVersionsClient`** — takes canned result in constructor, for tests
- **`getAppStoreVersionsClient()`** — factory from env

---

## Section 3: Analytics client (`analytics-client.ts`)

### Interface

```ts
interface AscAnalyticsClient {
  createReportRequest(
    type: ReportType,
    filters: ReportFilters,
  ): Promise<Result<string, AscError>>;
  // Returns Apple's reportRequestId — caller persists it, calls pollReportInstance later

  pollReportInstance(
    requestId: string,
  ): Promise<Result<ReportPollResult, AscError>>;
  // Returns { status: 'pending' } or { status: 'ready'; rows: ReportRow[] }
}

type ReportType = 'APP_STORE_ENGAGEMENT';
// Enum grows as later sub-specs need additional report types

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

### Two-phase design rationale

Apple designed the Analytics Reports API as an async generate-then-download flow.
Reports can take minutes. `pollReportInstance` returns `{ status: 'pending' }` when
Apple hasn't finished — the caller (B's scheduler) decides when to check back.
No blocking, no internal sleep loop inside the client.

### Internals

`pollReportInstance` walks Apple's nested resource chain and hides it from callers:
`reportRequest → reports → instances → segments → download`. Only typed `ReportRow[]`
surfaces to the caller.

### Implementations

- **`AppleAscAnalyticsClient`** — real HTTP implementation
- **`NoOpAscAnalyticsClient`** — `createReportRequest` returns a fake id; `pollReportInstance` returns `{ status: 'pending' }`
- **`StubAscAnalyticsClient`** — takes canned result, for tests
- **`getAscAnalyticsClient()`** — factory from env

---

## Section 4: Error types (`types.ts`)

```ts
type AscError =
  | { kind: 'auth_failed';  status: number }
  | { kind: 'not_found';    appId: string }
  | { kind: 'rate_limited'; retryAfterMs: number }
  | { kind: 'api_error';    status: number; detail: string }
  | { kind: 'parse_error';  raw: string };
```

`rate_limited` honours the `Retry-After` header verbatim, consistent with how the
iTunes pacer handles 429s.

---

## Section 5: Testing

| Test | What it checks |
|---|---|
| `auth.test.ts` | `signAscToken` produces a JWT with correct `kid`, `iss`, `aud`, and expiry; base64 key input round-trips correctly |
| `versions-client.test.ts` | `StubAppStoreVersionsClient` returns canned data; `NoOp` returns `[]`; live smoke test guarded behind `if (!process.env.ASC_KEY_ID) test.skip` |
| `analytics-client.test.ts` | `StubAscAnalyticsClient` returns `{ status: 'ready', rows }` on poll; `NoOp` returns `{ status: 'pending' }`; live smoke test guarded |

**Live smoke tests (guarded):** validate the real API shape on first contact.
No golden-file assertions on raw Apple responses since we're designing blind —
the live tests will harden the parser after first contact with the real API.

**Assumption to verify at build-start (from spec §H):** the exact
`reportRequest → instance → poll` lifecycle. The implementation of
`pollReportInstance` must be validated against real Apple API responses before
being considered complete.

---

## Acceptance criteria

- `signAscToken` unit test passes with a known test key
- `getAppVersions(appId)` returns `AppVersion[]` with correct state field for a real app (live smoke)
- `createReportRequest()` returns a non-empty `requestId` string from Apple (live smoke)
- `pollReportInstance(requestId)` returns `{ status: 'pending' }` or `{ status: 'ready'; rows }` without throwing (live smoke)
- `NoOp` client activates when env vars are absent; all tests pass without creds
- All calls appear in gateway telemetry

---

## What this sub-spec deliberately excludes

- Per-tenant credential storage or UI (later sub-spec)
- Scheduling or polling loops (sub-spec B)
- `aso_asc_report_requests` table (B owns persistence of pending requestIds)
- `aso_measurement_windows` table (sub-spec C)
- Write scopes (Phase 8)
