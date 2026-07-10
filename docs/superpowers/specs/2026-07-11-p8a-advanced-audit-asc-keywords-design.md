# P8-A: Advanced Audit — ASC Keyword Enrichment Design

## Goal

Replace inferred keyword-field and promotional-text signals with the developer's actual ASC metadata, enabling character-aware, gap-specific recommendations instead of hedged inferences.

## Problem

The `keywordField` rubric (14 % weight) is always scored as `confidence: "inferred"` because the keyword bank is invisible to the public. The LLM guesses whether obvious terms are missing. With real ASC credentials, we can fetch the exact 100-char keyword string the developer set and produce pinpoint recommendations: what is there, what is wasted (duplicates title/subtitle), what is missing, and a concrete replacement string.

Promotional text (`conversion` section) has the same problem — `promotionalTextObservable: false` today.

## User Flow

1. User pastes an App Store URL in the Composer.
2. User toggles **Advanced Audit** (new checkbox below the input).
3. **Credentials already saved (Settings)** → inline confirmation badge appears: *"ASC connected — keyword data will be included"*. User clicks Audit.
4. **No credentials** → a modal opens with the same 3-field form as Settings (Key ID, Issuer ID, .p8 contents). On successful connect the credentials are saved (identical to Settings flow) and the confirmation badge replaces the modal.
5. `POST /audit/start` is called with `advancedAudit: true`.
6. During the audit workflow, ASC listing data is fetched (keywords + promotional text for the `en-US` locale, falling back to the first available locale if `en-US` returns empty keywords).
7. If the fetch fails for any reason, the audit continues in standard inferred mode — Advanced Audit never blocks the run.
8. The audit report shows `keywordField` as `observable: true` with the real value; recommendations are character-aware and gap-specific.

## Architecture

### New file: `apps/server/src/asc/listing-client.ts`

Single exported function:

```ts
export type AscListingData = {
  keywords: string | null;          // raw 100-char keyword field, null if not set
  promotionalText: string | null;   // up to 170 chars, null if not set
};

export async function fetchAscListingData(
  creds: AscCredentials,
  appId: string,
): Promise<AscListingData>
```

Two sequential ASC calls:

1. `GET /v1/apps/{appId}/appStoreVersions?filter[appStoreState]=READY_FOR_SALE&filter[platform]=IOS&limit=1`
   → get the live version ID.

2. `GET /v1/appStoreVersions/{versionId}/appStoreVersionLocalizations`
   → iterate locales: prefer `en-US`, fall back to first entry.
   → extract `keywords` and `promotionalText`.

Returns `{ keywords: null, promotionalText: null }` on any non-2xx response or empty result set (never throws; caller treats null as "not available").

Test file: `apps/server/src/asc/listing-client.test.ts` — mock `fetch` (same pattern as `versions-client.test.ts`), covering: en-US found, en-US missing → fallback locale, no READY_FOR_SALE version → nulls, non-2xx → nulls.

### Modified: `apps/server/src/scoring/signals.ts`

Extend `keywordField` to a discriminated union:

```ts
keywordField:
  | { observable: false; note: string }
  | { observable: true; value: string; length: number; charsRemaining: number; wordsSharedWithTitle: string[] }
```

Extend `conversion` with one new optional field:

```ts
promotionalText: string | null   // null = not observable; string = actual value (may be empty string)
```

`computeSignals(listing, ascData?: AscListingData)` accepts optional ASC data. When `ascData.keywords` is a non-null string:
- Sets `keywordField = { observable: true, value, length: value.length, charsRemaining: 100 - value.length, wordsSharedWithTitle: [...] }`

When `ascData.promotionalText` is non-null:
- Sets `conversion.promotionalText = ascData.promotionalText`

### Modified: `apps/server/src/scoring/prompt.ts`

In `keywordLinterFacts()`, branch on `signals.keywordField.observable`:

**observable: false (current behaviour, unchanged)**
> `"Keyword field: unobservable (100-char budget inferred). Score by inference only (confidence "inferred")."`

**observable: true (new)**
> `"Keyword field (actual, confidence "verified"): '{value}' — {length}/100 chars used, {charsRemaining} remaining. Words already in title: [{shared}] — Apple ignores duplicates, these chars are wasted. Score based on actual content."`

Remove the `"Script not yet supported"` fallback note when `observable: true`.

For promotional text in the prompt: when `signals.conversion.promotionalText` is a non-null string, include its value verbatim so the LLM can assess its relevance and freshness.

### Modified: `apps/server/src/mastra/workflows/audit-workflow.ts`

After the listing-fetch step resolves, and before `computeSignals()`:

```ts
let ascListingData: AscListingData | undefined;
if (job.advancedAudit) {
  const credsResult = await loadCredentials(sql, tenantId);
  if (credsResult.ok && credsResult.value) {
    try {
      ascListingData = await fetchAscListingData(credsResult.value, appId);
    } catch {
      // non-critical — fall through to inferred mode
    }
  }
}
const signals = computeSignals(listing, ascListingData);
```

### Modified: `apps/server/src/queue/job-store.ts`

Add `advancedAudit: boolean` to `AuditJob` (next to `reopenIdentity`).
Add `advanced_audit: boolean` to `JobRow`.
Update `rowToJob` and `insertJob` accordingly.

### Modified: `apps/server/src/memory/pg-migrate.ts`

Append migration:
```sql
ALTER TABLE aso_audit_jobs ADD COLUMN advanced_audit BOOLEAN NOT NULL DEFAULT FALSE
```

### Modified: `apps/server/src/mastra/routes.ts`

Accept `advancedAudit?: boolean` from request body and pass to `insertJob`.

### New component: `apps/web/src/components/AscConnectModal.tsx`

Thin wrapper: the same 3-field form (Key ID, Issuer ID, .p8 textarea) and Connect logic from `AscSettings`, rendered as a modal overlay. On successful connect, calls `onConnected()` prop. No new API calls — reuses `PUT /settings/asc`.

Props:
```ts
{ isOpen: boolean; onConnected: () => void; onClose: () => void }
```

### Modified: `apps/web/src/components/Composer.tsx`

Below the URL input, add:

```
[ ] Advanced Audit  — includes keyword data from App Store Connect
```

State: `advancedEnabled: boolean`, `ascStatus: 'unknown' | 'connected' | 'disconnected'`.

On toggle:
- If `ascStatus === 'connected'`: show inline badge, no modal.
- If `ascStatus === 'disconnected'`: open `AscConnectModal`.
- If `ascStatus === 'unknown'`: fetch `GET /settings/asc`, then branch as above.

On form submit: pass `advancedAudit: advancedEnabled` to `startAudit()`.

Confirmation badge (inline, below the toggle when enabled):
> *"ASC connected · keyword + promotional text will be included"*

If Advanced Audit is toggled off mid-flow: badge disappears, audit submits without `advancedAudit`.

### Modified: `apps/web/src/lib/api.ts`

```ts
export async function startAudit(url: string, opts?: { reopenIdentity?: boolean; advancedAudit?: boolean }): Promise<...>
```

## Data Flow Summary

```
Composer (advancedAudit=true)
  → POST /audit/start { url, advancedAudit: true }
    → insertJob { ..., advancedAudit: true }
      → worker picks up job
        → audit-workflow: job.advancedAudit → fetchAscListingData(creds, appId)
          → { keywords: "remote start,car key,...", promotionalText: "..." }
            → computeSignals(listing, ascData)
              → keywordField: { observable: true, value: "...", charsRemaining: 43, ... }
                → prompt: actual keyword string + char count + title overlap
                  → LLM: character-aware, gap-specific recommendations
```

## Failure Modes

| Failure | Behaviour |
|---|---|
| ASC fetch throws | Caught, `ascListingData` stays undefined, audit runs in inferred mode |
| No READY_FOR_SALE version | `fetchAscListingData` returns `{ keywords: null, promotionalText: null }` — treated as inferred |
| Credentials revoked between connect and audit | `loadCredentials` returns ok+null → no fetch → inferred mode |
| Modal dismissed without connecting | `advancedEnabled` stays false, audit submits without flag |

## Out of Scope

- Fetching analytics (impressions/conversion rates) — these require async report requests (24–48 h) and belong in the Measurement Windows feature (P7-C).
- Non-English locales beyond the en-US → first-available fallback.
- Displaying the raw keyword value in the audit report UI — LLM uses it as context; the report shows recommendations, not raw ASC fields.
