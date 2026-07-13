# P8-B: Acting on the Listing — Write Path + Review Tracking

## Goal

Close the loop from audit to action. After an audit surfaces recommendations, the user can generate concrete new field values, review a diff, push the changes to App Store Connect, and track Apple's review state — all from within the tool. If Apple rejects, the user re-generates with the rejection reason as context and resubmits.

## Scope

This is the first of two P8 sub-projects:
- **P8-B (this spec):** generate → review → submit → track → reject/resubmit
- **P8-C (next):** stop-loss — after approval, monitor metrics and prompt revert if they drop

## User Flow

1. An audit completes with recommendations touching one or more of: title, subtitle, keywords, description, promotional text, release notes.
2. The audit report shows an **"Apply to Listing"** button.
3. User clicks it → a generation call runs, producing new values for affected fields only.
4. A diff panel opens showing `Current value → Proposed value` for each field. Proposed values are inline-editable with live char counters. Each field has a checkbox (default on). Fields that hit a character limit during generation are highlighted.
5. User reviews, edits, unchecks anything they don't want, then clicks **"Submit to ASC"**.
6. Changes are pushed to ASC via `PATCH appStoreVersionLocalizations`. Status badge updates: `Draft → Submitted → In Review → Approved / Rejected`.
7. The hourly scheduler polls for review state and writes a `listing_update_resolved` change event when the state is terminal.
8. The Activity Feed shows: **"Your update was approved"** or **"Apple rejected your update — [reason]. Fix and resubmit?"**
9. On rejection: user clicks "Fix and Resubmit" → generation re-runs with rejection reason as context → same diff UI → resubmit.

## Constraints

- Only one non-terminal update per `(tenant_id, app_id)` at a time. A new audit cannot produce a second pending update while one is in-flight.
- `whatsNew` (release notes) can only be submitted when there is an in-progress binary version. If the user selects release notes but no such version exists, that field is skipped with an explanation.
- ASC credentials must be saved (from P7-A / P8-A) — the feature is only shown when credentials are present.
- Generation requires the audit to have completed (status `completed`).

## Architecture

### New table: `aso_listing_updates`

```sql
CREATE TABLE aso_listing_updates (
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
);
```

**`proposed_fields` shape:**
```ts
{
  title?: string;
  subtitle?: string;
  keywords?: string;
  description?: string;
  promotionalText?: string;
  releaseNotes?: string;
}
```

**`status` values:** `draft` | `submitted` | `in_review` | `approved` | `rejected`

Only fields that differ from current ASC values appear as keys. Fields are absent (not null) when there is no recommendation for them.

### New file: `apps/server/src/asc/listing-writer.ts`

Single exported function:
```ts
export async function pushListingUpdate(
  creds: AscCredentials,
  localizationId: string,
  fields: ProposedFields,
): Promise<{ ok: true } | { ok: false; error: string }>
```

Two-step:
1. Build `attributes` object from only the provided keys in `fields`.
2. `PATCH /v1/appStoreVersionLocalizations/{localizationId}` — same `signAscToken` + `getGateway().fetch` pattern as `listing-client.ts`.

Returns `{ ok: false, error }` on non-2xx; never throws.

### Modified: `apps/server/src/asc/listing-client.ts`

`AscListingData` gains one new field:
```ts
localizationId: string | null;  // en-US localization record ID, needed for write
```

`fetchAscListingData` already fetches the localizations array — it now also returns the `id` field of the matched locale record.

### New routes: `apps/server/src/mastra/routes.ts`

**`POST /listing-update/generate`**

Body: `{ auditJobId: string }`

1. Load the audit job (verify tenant ownership, status `completed`).
2. Load the app's ASC credentials via `loadCredentials`.
3. Call `fetchAscListingData` to get current field values + `localizationId`.
4. Extract the audit's recommendations from the stored `report_json`.
5. Make a single focused LLM call (fast tier):
   - Input: current field values + list of recommendations per field + character limits
   - Instruction: "Produce a concrete new value for each recommended field. Obey hard limits: title ≤ 30, subtitle ≤ 30, keywords ≤ 100, description ≤ 4000, promotionalText ≤ 170, releaseNotes ≤ 4000."
   - Output: `ProposedFields` object (only fields that differ)
6. Insert `aso_listing_updates` row with `status = 'draft'`, `proposed_fields`, `asc_localization_id`.
7. Return the row id + `proposed_fields` + current values (for diff rendering).

**`POST /listing-update/submit`**

Body: `{ updateId: string; approvedFields: ProposedFields }`

1. Load update row, verify `status = 'draft'`, verify tenant ownership.
2. Call `pushListingUpdate(creds, asc_localization_id, approvedFields)`.
3. On success: set `applied_fields = approvedFields`, `status = 'submitted'`, `submitted_at = now`.
4. Return updated row.

**`GET /listing-update/:appId/current`**

Returns the most recent non-`approved` update for the app (for status badge rendering). Returns `null` if none.

### New scheduler step: `check-listing-updates`

Added to the existing hourly scheduler. Queries:
```sql
SELECT * FROM aso_listing_updates
WHERE status IN ('submitted', 'in_review')
```

For each, calls `GET /v1/apps/{appId}/appStoreVersions` (existing endpoint from continuous tracker) and maps ASC state:

| ASC state | Our status |
|---|---|
| `WAITING_FOR_REVIEW` | `in_review` |
| `IN_REVIEW` | `in_review` |
| `READY_FOR_SALE` | `approved` + `resolved_at` |
| `REJECTED` / `DEVELOPER_REJECTED` | `rejected` + `rejection_reason` + `resolved_at` |

On terminal state, inserts a `listing_update_resolved` change event into `aso_change_events`:
```ts
payload: { updateId, status: 'approved' | 'rejected', rejectionReason?: string }
```

### Rejection re-generation flow

When `status = 'rejected'`, the "Fix and Resubmit" button:
1. Resets `status → 'draft'` (same row, rejection reason preserved).
2. Calls `POST /listing-update/generate` — same endpoint, but the generation prompt now includes:
   *"Apple rejected the previous submission because: [rejection_reason]. Generate new values that address this rejection while still applying the audit recommendations."*
3. The diff UI shows the previous `applied_fields` as "Current" (not the original pre-submission values) so the user sees the delta between attempts.

### Frontend components

**`ListingUpdatePanel`** — appears in the audit report when an update is available or can be generated. States:
- Empty: "Apply to Listing" button
- Generating: spinner
- Draft: diff table (inline-editable proposed values, checkboxes, char counters, Submit button)
- Submitted/In Review: status badge + submitted fields summary
- Approved: success state
- Rejected: rejection reason + "Fix and Resubmit" button

**`ListingUpdateDiff`** — the diff table sub-component. Columns: Field name | Current value + char count | Proposed value (contenteditable) + char count | Checkbox. Char counter turns red when over limit.

**Activity Feed card** — new `listing_update_resolved` event type rendered by `ActivityFeed`. Approved: green check + field names changed. Rejected: red × + reason + resubmit CTA.

## Data Flow

```
User clicks "Apply to Listing"
  → POST /listing-update/generate
    → fetchAscListingData (current values + localizationId)
    → LLM call (fast tier) → ProposedFields
    → INSERT aso_listing_updates (draft)
    → return diff data to frontend

User approves diff → POST /listing-update/submit
  → pushListingUpdate → PATCH /v1/appStoreVersionLocalizations/{id}
  → UPDATE aso_listing_updates (submitted)

Hourly scheduler: check-listing-updates
  → GET /v1/apps/{appId}/appStoreVersions
  → state change → UPDATE aso_listing_updates + INSERT aso_change_events

Activity Feed shows listing_update_resolved card
  → "Fix and Resubmit" → POST /listing-update/generate (with rejection reason)
  → same diff UI → resubmit
```

## Error Handling

| Failure | Behaviour |
|---|---|
| ASC credentials missing | "Apply to Listing" button hidden |
| `fetchAscListingData` fails during generate | Return error, suggest reconnecting ASC |
| LLM generation fails | Show error in panel, "Try again" button |
| `pushListingUpdate` non-2xx | Show error, row stays `draft`, user can retry |
| `check-listing-updates` fetch fails | Log, skip, retry next hour |
| Release notes selected but no in-progress version | Skip that field, explain in UI |

## Out of Scope

- Multi-locale support — en-US only (same as `fetchAscListingData`)
- Screenshot / preview video updates — binary-only, no ASC metadata API
- Stop-loss — P8-C
- Creating a new binary version — users manage that in ASC directly
