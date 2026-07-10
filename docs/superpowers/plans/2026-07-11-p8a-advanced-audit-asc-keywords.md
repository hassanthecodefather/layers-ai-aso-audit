# P8-A Advanced Audit — ASC Keyword Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace inferred keyword-field and promotional-text signals with actual data from ASC, enabling character-aware, gap-specific recommendations in the audit.

**Architecture:** A new `fetchAscListingData` function fetches the developer's hidden keyword bank and promotional text from the ASC API. `computeSignals` is extended to accept this data and expose it as `keywordField.observable: true`. The audit prompt and recommendations use the real values instead of inference. On the frontend, an "Advanced Audit" toggle on the Composer checks for saved ASC credentials (or prompts to connect) before submitting the audit with `advancedAudit: true`.

**Tech Stack:** TypeScript, postgres.js, Mastra workflow, React, Vitest (TDD), Zod

## Global Constraints

- Node ≥ 20.12 — use `nvm use 24` before running any commands
- All DB queries use postgres.js template literals — no string concatenation
- Migrations append-only to `PG_ONLY_MIGRATIONS` in `apps/server/src/memory/pg-migrate.ts` — no trailing semicolons, idempotent (ADD COLUMN IF NOT EXISTS is injected automatically by `runPgMigrations`)
- Tests run with `pnpm test <pattern>` from `apps/server` or `apps/web`
- TypeScript strict — zero `tsc --noEmit` errors required
- YAGNI — no features beyond this spec; no backwards-compat shims

---

### Task 1: `fetchAscListingData` — ASC listing client + tests

**Files:**
- Create: `apps/server/src/asc/listing-client.ts`
- Create: `apps/server/src/asc/listing-client.test.ts`

**Interfaces:**
- Consumes: `signAscToken(keyId, issuerId, pem)` from `./auth`; `getGateway()` from `../cost/gateway`; `AscCredentials` type from `./credential-store`
- Produces: `AscListingData` type; `fetchAscListingData(creds, appId)` — used by Task 5

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/src/asc/listing-client.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./auth', () => ({ signAscToken: () => 'fake.jwt.token' }));

const mockGatewayFetch = vi.fn();
vi.mock('../cost/gateway', () => ({
  getGateway: () => ({ fetch: mockGatewayFetch }),
}));

const CREDS = { keyId: 'K1', issuerId: 'I1', privateKeyPem: '---BEGIN EC PRIVATE KEY---\nfake\n---END EC PRIVATE KEY---' };

describe('fetchAscListingData', () => {
  beforeEach(() => { mockGatewayFetch.mockReset(); });

  it('returns keywords and promotionalText from en-US locale', async () => {
    const { fetchAscListingData } = await import('./listing-client');
    mockGatewayFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: 'ver-123', attributes: {} }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [
          { attributes: { locale: 'en-US', keywords: 'remote start,car key', promotionalText: 'Open your car from anywhere.' } },
        ],
      }), { status: 200 }));

    const result = await fetchAscListingData(CREDS, '12345');
    expect(result.keywords).toBe('remote start,car key');
    expect(result.promotionalText).toBe('Open your car from anywhere.');
  });

  it('falls back to first locale when en-US is absent', async () => {
    const { fetchAscListingData } = await import('./listing-client');
    mockGatewayFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: 'ver-123', attributes: {} }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [
          { attributes: { locale: 'de-DE', keywords: 'fernstart,autoschlüssel', promotionalText: null } },
        ],
      }), { status: 200 }));

    const result = await fetchAscListingData(CREDS, '12345');
    expect(result.keywords).toBe('fernstart,autoschlüssel');
    expect(result.promotionalText).toBeNull();
  });

  it('returns nulls when no READY_FOR_SALE version exists', async () => {
    const { fetchAscListingData } = await import('./listing-client');
    mockGatewayFetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const result = await fetchAscListingData(CREDS, '12345');
    expect(result).toEqual({ keywords: null, promotionalText: null });
  });

  it('returns nulls on non-2xx response', async () => {
    const { fetchAscListingData } = await import('./listing-client');
    mockGatewayFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    const result = await fetchAscListingData(CREDS, '12345');
    expect(result).toEqual({ keywords: null, promotionalText: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
. ~/.nvm/nvm.sh && nvm use 24 && cd apps/server && pnpm test asc/listing-client.test.ts
```
Expected: FAIL — `Cannot find module './listing-client'`

- [ ] **Step 3: Implement `apps/server/src/asc/listing-client.ts`**

```ts
import { signAscToken } from './auth';
import { getGateway } from '../cost/gateway';
import type { AscCredentials } from './credential-store';

const ASC_BASE = 'https://api.appstoreconnect.apple.com';

export type AscListingData = {
  keywords: string | null;
  promotionalText: string | null;
};

const NULL_RESULT: AscListingData = { keywords: null, promotionalText: null };

export async function fetchAscListingData(
  creds: AscCredentials,
  appId: string,
): Promise<AscListingData> {
  try {
    const token = signAscToken(creds.keyId, creds.issuerId, creds.privateKeyPem);
    const headers = { Authorization: `Bearer ${token}` };
    const gateway = getGateway();

    const versionsUrl =
      `${ASC_BASE}/v1/apps/${encodeURIComponent(appId)}/appStoreVersions` +
      `?filter[appStoreState]=READY_FOR_SALE&filter[platform]=IOS&limit=1`;
    const versionsRes = await gateway.fetch(versionsUrl, { kind: 'app', upstream: 'asc' }, { headers });
    if (!versionsRes.ok) return NULL_RESULT;

    const versionsData = await versionsRes.json().catch(() => null) as
      { data?: { id: string }[] } | null;
    const versionId = versionsData?.data?.[0]?.id;
    if (!versionId) return NULL_RESULT;

    const locUrl =
      `${ASC_BASE}/v1/appStoreVersions/${encodeURIComponent(versionId)}/appStoreVersionLocalizations`;
    const locRes = await gateway.fetch(locUrl, { kind: 'app', upstream: 'asc' }, { headers });
    if (!locRes.ok) return NULL_RESULT;

    const locData = await locRes.json().catch(() => null) as {
      data?: { attributes: { locale: string; keywords: string | null; promotionalText: string | null } }[]
    } | null;
    if (!Array.isArray(locData?.data) || locData.data.length === 0) return NULL_RESULT;

    const enUs = locData.data.find((d) => d.attributes.locale === 'en-US');
    const loc = enUs ?? locData.data[0]!;

    return {
      keywords: loc.attributes.keywords || null,
      promotionalText: loc.attributes.promotionalText || null,
    };
  } catch {
    return NULL_RESULT;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
. ~/.nvm/nvm.sh && nvm use 24 && cd apps/server && pnpm test asc/listing-client.test.ts
```
Expected: PASS — 4 passed

- [ ] **Step 5: Type-check**

```bash
. ~/.nvm/nvm.sh && nvm use 24 && cd apps/server && pnpm tsc --noEmit 2>&1 | grep "asc/listing"
```
Expected: no output (zero errors in this file)

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/asc/listing-client.ts apps/server/src/asc/listing-client.test.ts
git commit -m "feat(p8a): fetchAscListingData — fetch keyword field + promotional text from ASC"
```

---

### Task 2: Signals extension — observable keyword field + promotional text

**Files:**
- Modify: `apps/server/src/scoring/signals.ts`
- Modify: `apps/server/src/scoring/signals.test.ts`

**Interfaces:**
- Consumes: `AscListingData` from `../asc/listing-client` (Task 1)
- Produces:
  - `ListingSignals.keywordField`: discriminated union `{ observable: false; note: string } | { observable: true; value: string; length: number; charsRemaining: number; wordsSharedWithTitle: string[] }`
  - `ListingSignals.conversion.promotionalText: string | null` — new field
  - `computeSignals(listing: AppListing, ascData?: AscListingData): ListingSignals` — extended signature

- [ ] **Step 1: Write the failing tests**

Open `apps/server/src/scoring/signals.test.ts` and add these tests at the end of the file:

```ts
describe('computeSignals — ASC keyword enrichment', () => {
  it('keywordField is observable when ascData.keywords is provided', () => {
    const listing = makeListing({ name: 'Smart Car Key' });
    const signals = computeSignals(listing, { keywords: 'remote start,vehicle', promotionalText: null });
    expect(signals.keywordField.observable).toBe(true);
    if (!signals.keywordField.observable) return;
    expect(signals.keywordField.value).toBe('remote start,vehicle');
    expect(signals.keywordField.length).toBe(20);
    expect(signals.keywordField.charsRemaining).toBe(80);
  });

  it('wordsSharedWithTitle flags title duplicates in keyword field', () => {
    const listing = makeListing({ name: 'Smart Car Key' });
    // 'car' and 'key' are in the title; 'remote' is not
    const signals = computeSignals(listing, { keywords: 'remote,car,key', promotionalText: null });
    if (!signals.keywordField.observable) return;
    expect(signals.keywordField.wordsSharedWithTitle).toEqual(expect.arrayContaining(['car', 'key']));
    expect(signals.keywordField.wordsSharedWithTitle).not.toContain('remote');
  });

  it('keywordField stays unobservable when ascData.keywords is null', () => {
    const listing = makeListing();
    const signals = computeSignals(listing, { keywords: null, promotionalText: null });
    expect(signals.keywordField.observable).toBe(false);
  });

  it('conversion.promotionalText is set from ascData', () => {
    const listing = makeListing();
    const signals = computeSignals(listing, { keywords: null, promotionalText: 'Open from anywhere.' });
    expect(signals.conversion.promotionalText).toBe('Open from anywhere.');
  });

  it('conversion.promotionalText is null when ascData is not provided', () => {
    const listing = makeListing();
    const signals = computeSignals(listing);
    expect(signals.conversion.promotionalText).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
. ~/.nvm/nvm.sh && nvm use 24 && cd apps/server && pnpm test scoring/signals.test.ts
```
Expected: 5 new test failures; existing tests still pass

- [ ] **Step 3: Update `apps/server/src/scoring/signals.ts`**

**3a.** Add import at the top of the file (after the existing imports):
```ts
import type { AscListingData } from '../asc/listing-client';
```

**3b.** Replace the `keywordField` property in `ListingSignals` (currently `{ observable: false; note: string }`) with the discriminated union:
```ts
  keywordField:
    | { observable: false; note: string }
    | { observable: true; value: string; length: number; charsRemaining: number; wordsSharedWithTitle: string[] };
```

**3c.** Add `promotionalText: string | null` to the `conversion` block:
```ts
  conversion: {
    promotionalTextObservable: boolean;
    hasPromotionalText: boolean;
    promotionalText: string | null;
    hasReleaseNotes: boolean;
    releaseNotesLength: number;
    daysSinceLastUpdate: number | null;
  };
```

**3d.** Update the `computeSignals` function signature:
```ts
export function computeSignals(listing: AppListing, ascData?: AscListingData): ListingSignals {
```

**3e.** Inside `computeSignals`, replace the `keywordField` line (currently `keywordField: { observable: false, note: KEYWORD_FIELD_NOTE },`) with:
```ts
    keywordField: ascData?.keywords
      ? {
          observable: true as const,
          value: ascData.keywords,
          length: ascData.keywords.length,
          charsRemaining: 100 - ascData.keywords.length,
          wordsSharedWithTitle: words(ascData.keywords).filter((w) => titleWords.has(w)),
        }
      : { observable: false as const, note: KEYWORD_FIELD_NOTE },
```

**3f.** Inside `computeSignals`, update the `conversion` block to include `promotionalText`:
```ts
    conversion: {
      promotionalTextObservable: listing.provenance.crawler,
      hasPromotionalText: Boolean(listing.promotionalText),
      promotionalText: ascData?.promotionalText ?? null,
      hasReleaseNotes: Boolean(listing.releaseNotes),
      releaseNotesLength: listing.releaseNotes?.length ?? 0,
      daysSinceLastUpdate: daysSince(listing.currentVersionReleaseDate),
    },
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
. ~/.nvm/nvm.sh && nvm use 24 && cd apps/server && pnpm test scoring/signals.test.ts
```
Expected: all tests pass (new 5 + existing)

- [ ] **Step 5: Type-check**

```bash
. ~/.nvm/nvm.sh && nvm use 24 && cd apps/server && pnpm tsc --noEmit 2>&1 | grep "signals"
```
Expected: no output (zero errors)

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/scoring/signals.ts apps/server/src/scoring/signals.test.ts
git commit -m "feat(p8a): extend ListingSignals with observable keywordField union and conversion.promotionalText"
```

---

### Task 3: Prompt — use actual keyword data, promotional text, limitation note

**Files:**
- Modify: `apps/server/src/scoring/prompt.ts`

**Interfaces:**
- Consumes: `ListingSignals.keywordField` discriminated union from Task 2; `ListingSignals.conversion.promotionalText` from Task 2
- Produces: `buildAuditPrompt(..., advancedAuditFailed?: boolean)` — extended signature used by Task 5

- [ ] **Step 1: Update `keywordLinterFacts` signature and logic**

In `apps/server/src/scoring/prompt.ts`, find:
```ts
function keywordLinterFacts(linter: LinterResult): string {
```

Replace the entire function with:

```ts
function keywordLinterFacts(linter: LinterResult, keywordField: ListingSignals['keywordField']): string {
  // When observable: true, actual data from ASC is available
  const kfLine = keywordField.observable
    ? `Keyword field (actual, confidence "verified"): '${keywordField.value}' — ` +
      `${keywordField.length}/100 chars used, ${keywordField.charsRemaining} remaining.` +
      (keywordField.wordsSharedWithTitle.length > 0
        ? ` Words already in title: [${keywordField.wordsSharedWithTitle.join(', ')}] — Apple ignores duplicates, these chars are wasted.`
        : ` No words duplicated from title.`) +
      ` Score based on actual content, confidence "verified".`
    : `Keyword field: unobservable (100-char budget inferred).`;

  if (!linter.scriptSupported) {
    if (keywordField.observable) {
      return ['## Keyword linter', kfLine].join('\n');
    }
    return '## Keyword linter\nScript not yet supported — keyword mechanics suppressed. Score the keyword field by inference only (confidence "inferred").';
  }

  const lines: string[] = ['## Keyword linter — deterministic, no model call needed'];
  lines.push(
    `Title: ${linter.titleUsed}/${30} chars used. ` +
    `Subtitle: ${linter.subtitleUsed}/${30} chars used. ` +
    kfLine,
  );

  if (linter.reclaimableChars > 0) {
    lines.push(`Reclaimable chars in visible fields: ${linter.reclaimableChars}`);
  }

  if (linter.estimatedKeywordWaste > 0) {
    lines.push(
      `Estimated keyword-field waste: ≤${linter.estimatedKeywordWaste} chars may be wasted ` +
      `if developer repeated title/subtitle words in keyword field (inferred).`,
    );
  }

  const byReason = (reason: LinterResult['flags'][number]['reason']) =>
    linter.flags.filter((f) => f.reason === reason);

  const dups = byReason('cross_field_duplicate');
  const plural = byReason('plural_redundant');
  const wasted = byReason('wasted_word');

  if (dups.length > 0) {
    lines.push(
      `Cross-field duplicates (subtitle repeats title coverage): ` +
      dups.map((f) => `"${f.term}" (${f.field}, −${f.reclaimableChars} chars)`).join(', '),
    );
  }
  if (plural.length > 0) {
    lines.push(
      `Plural redundancies (singular+plural of same root): ` +
      plural.map((f) => `"${f.term}" (${f.field}, −${f.reclaimableChars} chars)`).join(', '),
    );
  }
  if (wasted.length > 0) {
    lines.push(
      `Wasted words (generic, no keyword value): ` +
      wasted.map((f) => `"${f.term}" (${f.field}, −${f.reclaimableChars} chars)`).join(', '),
    );
  }

  if (linter.flags.length === 0) {
    lines.push('No cross-field duplicates, plural redundancies, or wasted words detected.');
  }

  if (!keywordField.observable) {
    lines.push('IMPORTANT: keyword field findings are confidence "inferred" (field not publicly observable).');
  }
  return lines.join('\n');
}
```

- [ ] **Step 2: Add `ascPromoTextFacts` helper function**

Add this new function directly before the `buildAuditPrompt` function:

```ts
function ascPromoTextFacts(signals: ListingSignals): string {
  const text = signals.conversion.promotionalText;
  if (text === null) return '';
  return [
    '## ASC promotional text (actual, from App Store Connect)',
    text.length > 0
      ? `"${text}" (${text.length}/170 chars used)`
      : '(empty — slot is unused)',
    '⚠ Promotional text is NOT indexed by Apple — do not suggest keywords here. Assess relevance, freshness, and whether it supports conversion.',
  ].join('\n');
}
```

- [ ] **Step 3: Update `buildAuditPrompt` signature and body**

Find the `buildAuditPrompt` function signature:
```ts
export function buildAuditPrompt(
  listing: AppListing,
  signals: ListingSignals,
  priorContext?: string,
  visionResult?: VisionResult,
  candidateResult?: CandidateResult,
  themeResult?: ThemeAnalysisResult | null,
  rankedKeywords?: RankedKeyword[],
  competitorMining?: CompetitorMiningResult | null,
  competitorTiering?: CompetitorTieringResult | null,
): string {
```

Replace with (add `advancedAuditFailed` as final optional param):
```ts
export function buildAuditPrompt(
  listing: AppListing,
  signals: ListingSignals,
  priorContext?: string,
  visionResult?: VisionResult,
  candidateResult?: CandidateResult,
  themeResult?: ThemeAnalysisResult | null,
  rankedKeywords?: RankedKeyword[],
  competitorMining?: CompetitorMiningResult | null,
  competitorTiering?: CompetitorTieringResult | null,
  advancedAuditFailed?: boolean,
): string {
```

Inside `buildAuditPrompt`, update the `keywordLinterFacts` call:

Find:
```ts
    keywordLinterFacts(signals.keywordLinter),
```
Replace with:
```ts
    keywordLinterFacts(signals.keywordLinter, signals.keywordField),
```

After that line, add the ASC promo text section (insert after `keywordLinterFacts` call):
```ts
    ...(ascPromoTextFacts(signals) ? [ascPromoTextFacts(signals), ''] : []),
```

Add the `advancedAuditFailed` note. Find the line `'## Rubric — score each dimension 0-10 against these checks',` and insert the following block immediately before it:
```ts
    ...(advancedAuditFailed ? [
      '## Advanced Audit — ASC data unavailable',
      'This audit was requested in Advanced mode but App Store Connect data could not be retrieved.',
      'Score the keyword field by inference only (confidence "inferred").',
      'Add this sentence verbatim to your "limitations" array: "Advanced Audit requested but ASC data unavailable — keyword field is inferred. Reconnect ASC credentials in Settings and re-run for full keyword analysis."',
      '',
    ] : []),
```

- [ ] **Step 4: Type-check**

```bash
. ~/.nvm/nvm.sh && nvm use 24 && cd apps/server && pnpm tsc --noEmit 2>&1 | grep "prompt"
```
Expected: no output (zero errors in this file)

- [ ] **Step 5: Run scoring tests**

```bash
. ~/.nvm/nvm.sh && nvm use 24 && cd apps/server && pnpm test scoring/
```
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/scoring/prompt.ts
git commit -m "feat(p8a): use actual ASC keyword data in audit prompt; add limitation note when unavailable"
```

---

### Task 4: Job plumbing — `advancedAudit` through job store, migration, and route

**Files:**
- Modify: `apps/server/src/queue/job-store.ts`
- Modify: `apps/server/src/memory/pg-migrate.ts`
- Modify: `apps/server/src/mastra/routes.ts`

**Interfaces:**
- Produces: `AuditJob.advancedAudit: boolean`; `insertJob` accepts `advancedAudit?: boolean`; `/audit/start` reads `advancedAudit` from body

- [ ] **Step 1: Update `apps/server/src/queue/job-store.ts`**

**1a.** Add `advancedAudit: boolean` to `AuditJob` interface immediately after `reopenIdentity: boolean`:
```ts
  reopenIdentity: boolean;
  advancedAudit: boolean;
```

**1b.** Add `advanced_audit: boolean` to `JobRow` interface immediately after `reopen_identity: number`:
```ts
  reopen_identity: number; advanced_audit: boolean; status: string; step: string | null;
```

**1c.** Add `advancedAudit: r.advanced_audit,` to `rowToJob` immediately after `reopenIdentity: r.reopen_identity !== 0,`:
```ts
    reopenIdentity: r.reopen_identity !== 0,
    advancedAudit: r.advanced_audit,
```

**1d.** Update `insertJob` params to include `advancedAudit?: boolean`:
```ts
export async function insertJob(
  sql: postgres.Sql,
  params: { id?: string; runId: string; tenantId: string; url: string; reopenIdentity?: boolean; advancedAudit?: boolean },
): Promise<AuditJob> {
```

**1e.** Update the SQL INSERT in `insertJob` to include `advanced_audit`:

Find:
```ts
    INSERT INTO aso_audit_jobs (id, run_id, tenant_id, url, reopen_identity, status)
    VALUES (${id}, ${params.runId}, ${params.tenantId}, ${params.url},
            ${params.reopenIdentity ? 1 : 0}, 'pending')
```
Replace with:
```ts
    INSERT INTO aso_audit_jobs (id, run_id, tenant_id, url, reopen_identity, advanced_audit, status)
    VALUES (${id}, ${params.runId}, ${params.tenantId}, ${params.url},
            ${params.reopenIdentity ? 1 : 0}, ${params.advancedAudit ?? false}, 'pending')
```

- [ ] **Step 2: Add migration to `apps/server/src/memory/pg-migrate.ts`**

Append to the `PG_ONLY_MIGRATIONS` array after the `cost_json` migration (currently last entry):
```ts
  `ALTER TABLE aso_audit_jobs ADD COLUMN advanced_audit BOOLEAN NOT NULL DEFAULT FALSE`,
```

- [ ] **Step 3: Update `/audit/start` route in `apps/server/src/mastra/routes.ts`**

Find:
```ts
        const reopenIdentity = body?.reopenIdentity === true;
        const runId = newId('run');
        const job = await insertJob(sql, { runId, tenantId, url, reopenIdentity });
```
Replace with:
```ts
        const reopenIdentity = body?.reopenIdentity === true;
        const advancedAudit = body?.advancedAudit === true;
        const runId = newId('run');
        const job = await insertJob(sql, { runId, tenantId, url, reopenIdentity, advancedAudit });
```

- [ ] **Step 4: Type-check**

```bash
. ~/.nvm/nvm.sh && nvm use 24 && cd apps/server && pnpm tsc --noEmit 2>&1 | grep -E "job-store|pg-migrate|routes"
```
Expected: no output (zero errors)

- [ ] **Step 5: Run affected tests**

```bash
. ~/.nvm/nvm.sh && nvm use 24 && cd apps/server && pnpm test queue/ mastra/
```
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/queue/job-store.ts apps/server/src/memory/pg-migrate.ts apps/server/src/mastra/routes.ts
git commit -m "feat(p8a): add advancedAudit flag to job store, migration, and audit/start route"
```

---

### Task 5: Audit workflow — fetch ASC data, inject into signals and prompt

**Files:**
- Modify: `apps/server/src/mastra/workflows/audit-workflow.ts`

**Interfaces:**
- Consumes: `fetchAscListingData` (Task 1); `AscListingData` (Task 1); `computeSignals(..., ascData?)` (Task 2); `buildAuditPrompt(..., advancedAuditFailed?)` (Task 3); `loadCredentials` from `../../asc/credential-store`
- Produces: keyword field is `observable: true` in the audit when ASC data was fetched; limitation note in prompt when `advancedAudit` was requested but data unavailable

- [ ] **Step 1: Add imports at the top of `apps/server/src/mastra/workflows/audit-workflow.ts`**

After the last existing import line, add:
```ts
import { fetchAscListingData, type AscListingData } from '../../asc/listing-client';
import { loadCredentials } from '../../asc/credential-store';
```

- [ ] **Step 2: Move `sql` declaration before the `try` block in `scoreStep`**

Inside `scoreStep.execute`, currently the `finally` block contains:
```ts
    } finally {
      getGovernor().endRun();
      const sql = getPgSql();
      if (sql && runId) {
```

Move `const sql = getPgSql()` to just before `return runWithTenant(...)`. Find:
```ts
    const ledger = new CostLedger(parseInt(process.env.AUDIT_BUDGET_CENTS ?? '500', 10));
    // tenantId guard is inside the try so endRun() is guaranteed even if it throws.
    return runWithTenant(tenantId ?? 'default', async () => {
```
Replace with:
```ts
    const ledger = new CostLedger(parseInt(process.env.AUDIT_BUDGET_CENTS ?? '500', 10));
    const sql = getPgSql();
    // tenantId guard is inside the try so endRun() is guaranteed even if it throws.
    return runWithTenant(tenantId ?? 'default', async () => {
```

Remove `const sql = getPgSql();` from the `finally` block. Find:
```ts
    } finally {
      getGovernor().endRun();
      const sql = getPgSql();
      if (sql && runId) {
```
Replace with:
```ts
    } finally {
      getGovernor().endRun();
      if (sql && runId) {
```

- [ ] **Step 3: Look up `advanced_audit` from the job record**

Inside the `try` block, immediately after the tenantId check line (`if (!tenantId) throw ...`), add:

```ts
    const [jobRow] = sql
      ? await sql<{ advanced_audit: boolean }[]>`
          SELECT advanced_audit FROM aso_audit_jobs WHERE run_id = ${runId}
        `
      : [];
```

- [ ] **Step 4: Fetch ASC listing data before `computeSignals`**

Find the existing `computeSignals` call:
```ts
    const signals = computeSignals(listing);
```

Replace with:

```ts
    let ascListingData: AscListingData | undefined;
    if (jobRow?.advanced_audit && tenantId) {
      const credsResult = await loadCredentials(sql!, tenantId);
      if (credsResult.ok && credsResult.value) {
        try {
          ascListingData = await fetchAscListingData(credsResult.value, listing.appId);
        } catch { /* non-critical — fall through to inferred mode */ }
      }
    }
    const signals = computeSignals(listing, ascListingData);
    const advancedAuditFailed =
      !!jobRow?.advanced_audit && signals.keywordField.observable === false;
```

- [ ] **Step 5: Pass `advancedAuditFailed` to `buildAuditPrompt`**

Find:
```ts
    const builtPrompt = buildAuditPrompt(listing, signals, priorContext, visionResult, candidateResult, themeResult, rankedKeywords, competitorMining, competitorTiering);
```
Replace with:
```ts
    const builtPrompt = buildAuditPrompt(listing, signals, priorContext, visionResult, candidateResult, themeResult, rankedKeywords, competitorMining, competitorTiering, advancedAuditFailed);
```

- [ ] **Step 6: Type-check**

```bash
. ~/.nvm/nvm.sh && nvm use 24 && cd apps/server && pnpm tsc --noEmit 2>&1 | grep -v "measurement/\|asc/versions\|tracking/scan"
```
Expected: no errors in audit-workflow or asc/listing-client related paths

- [ ] **Step 7: Run server test suite**

```bash
. ~/.nvm/nvm.sh && nvm use 24 && cd apps/server && pnpm test
```
Expected: all pass

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/mastra/workflows/audit-workflow.ts
git commit -m "feat(p8a): wire ASC listing data fetch into audit workflow; inject keyword signals"
```

---

### Task 6: Frontend — AscConnectModal + Composer Advanced toggle

**Files:**
- Create: `apps/web/src/components/AscConnectModal.tsx`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/hooks/useAudit.ts`
- Modify: `apps/web/src/components/Composer.tsx`

**Interfaces:**
- Consumes: `getAscStatus()`, `saveAscCredentials()` from `../lib/api`; `startAudit(url, opts?)` updated signature
- Produces: `AscConnectModal` component; `Composer.onSubmit(url, opts?)` passes `advancedAudit: true` when enabled

- [ ] **Step 1: Create `apps/web/src/components/AscConnectModal.tsx`**

```tsx
import { useState } from 'react';
import { saveAscCredentials } from '../lib/api';

interface Props {
  isOpen: boolean;
  onConnected: () => void;
  onClose: () => void;
}

export function AscConnectModal({ isOpen, onConnected, onClose }: Props) {
  const [keyId, setKeyId] = useState('');
  const [issuerId, setIssuerId] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await saveAscCredentials(keyId.trim(), issuerId.trim(), privateKey.trim());
      onConnected();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
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
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, color: '#f4f4f5', margin: 0 }}>
            Connect App Store Connect
          </h2>
          <button
            type="button"
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#71717a', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}
          >
            ×
          </button>
        </div>
        <form onSubmit={handleConnect} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ fontSize: 13, color: '#71717a', margin: 0 }}>
            Required to include your keyword field and promotional text in the audit.
            Find these in App Store Connect → Users &amp; Access → Keys.
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
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update `startAudit` in `apps/web/src/lib/api.ts`**

Find:
```ts
export async function startAudit(url: string, reopenIdentity = false): Promise<StartAuditResult> {
  const res = await authedFetch('/audit/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, reopenIdentity }),
  });
```
Replace with:
```ts
export async function startAudit(
  url: string,
  opts?: { reopenIdentity?: boolean; advancedAudit?: boolean },
): Promise<StartAuditResult> {
  const res = await authedFetch('/audit/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, reopenIdentity: opts?.reopenIdentity, advancedAudit: opts?.advancedAudit }),
  });
```

- [ ] **Step 3: Update `useAudit.ts`**

**3a.** Update the `UseAudit` interface — change `submitUrl` signature:
```ts
  submitUrl: (url: string, opts?: { advancedAudit?: boolean }) => void;
```

**3b.** Update the `submitUrl` callback (find `const submitUrl = useCallback((raw: string) => {`):
```ts
  const submitUrl = useCallback((raw: string, opts?: { advancedAudit?: boolean }) => {
    const url = raw.trim();
    if (!url || status === 'starting' || status === 'running') return;

    stopPolling();
    add({ id: nextId(), kind: 'user', text: url });
    setPendingUrl(url);
    setStatus('starting');

    const thinkingId = nextId();
    add({ id: thinkingId, kind: 'agent', text: 'Queuing audit…' });

    startAudit(url, opts)
```
(Only the first line and the `startAudit(url)` → `startAudit(url, opts)` call need changing; leave the rest of the callback body as-is.)

**3c.** Update the `reopenIdentity` callback — change `startAudit(pendingUrl, true)` to `startAudit(pendingUrl, { reopenIdentity: true })`:
```ts
    startAudit(pendingUrl, { reopenIdentity: true })
```

- [ ] **Step 4: Update `apps/web/src/components/Composer.tsx`**

Replace the entire file:

```tsx
import { useState, type FormEvent } from 'react';
import { getAscStatus } from '../lib/api';
import { AscConnectModal } from './AscConnectModal';

interface ComposerProps {
  disabled: boolean;
  onSubmit: (url: string, opts?: { advancedAudit?: boolean }) => void;
}

const EXAMPLE =
  'https://apps.apple.com/us/app/spotify-music-and-podcasts/id324684580';

export function Composer({ disabled, onSubmit }: ComposerProps) {
  const [value, setValue] = useState('');
  const [advancedEnabled, setAdvancedEnabled] = useState(false);
  const [ascStatus, setAscStatus] = useState<'unknown' | 'connected' | 'disconnected'>('unknown');
  const [showModal, setShowModal] = useState(false);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const url = value.trim();
    if (!url || disabled) return;
    onSubmit(url, { advancedAudit: advancedEnabled });
    setValue('');
    setAdvancedEnabled(false);
  }

  async function handleAdvancedToggle() {
    if (advancedEnabled) {
      setAdvancedEnabled(false);
      return;
    }
    let status = ascStatus;
    if (status === 'unknown') {
      const s = await getAscStatus().catch(() => ({ connected: false, keyId: null }));
      status = s.connected ? 'connected' : 'disconnected';
      setAscStatus(status);
    }
    if (status === 'connected') {
      setAdvancedEnabled(true);
    } else {
      setShowModal(true);
    }
  }

  function handleConnected() {
    setAscStatus('connected');
    setShowModal(false);
    setAdvancedEnabled(true);
  }

  return (
    <div className="border-t border-white/10 bg-[#0a0a0f]/95 px-4 py-4 backdrop-blur">
      <form
        onSubmit={handleSubmit}
        className="mx-auto flex max-w-3xl items-center gap-2"
      >
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={disabled}
          placeholder="Paste an Apple App Store URL…"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-indigo-400/60 focus:bg-white/[0.07] disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={disabled || !value.trim()}
          className="shrink-0 rounded-xl bg-indigo-500 px-5 py-3 text-sm font-medium text-white transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Audit
        </button>
      </form>

      <div className="mx-auto mt-2 max-w-3xl flex items-center gap-3">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={advancedEnabled}
            onChange={handleAdvancedToggle}
            disabled={disabled}
            className="rounded"
          />
          <span className="text-xs text-zinc-500">Advanced Audit</span>
        </label>
        {advancedEnabled && (
          <span className="text-xs text-emerald-400">
            ASC connected · keyword + promotional text will be included
          </span>
        )}
      </div>

      <button
        type="button"
        disabled={disabled}
        onClick={() => setValue(EXAMPLE)}
        className="mx-auto mt-1 block max-w-3xl text-left text-xs text-zinc-600 transition hover:text-zinc-400 disabled:opacity-40"
      >
        Try an example — Spotify
      </button>

      <AscConnectModal
        isOpen={showModal}
        onConnected={handleConnected}
        onClose={() => setShowModal(false)}
      />
    </div>
  );
}
```

- [ ] **Step 5: Build verification**

```bash
. ~/.nvm/nvm.sh && nvm use 24 && cd apps/web && pnpm build 2>&1 | tail -20
```
Expected: build succeeds, zero TypeScript errors

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/AscConnectModal.tsx apps/web/src/components/Composer.tsx apps/web/src/lib/api.ts apps/web/src/hooks/useAudit.ts
git commit -m "feat(p8a): Advanced Audit toggle in Composer; AscConnectModal; advancedAudit flag in startAudit"
```

---

## Self-Review

**1. Spec coverage**

| Spec requirement | Task |
|---|---|
| `fetchAscListingData` — en-US, fallback, nulls on error | Task 1 |
| `ListingSignals.keywordField` observable union | Task 2 |
| `ListingSignals.conversion.promotionalText` | Task 2 |
| `computeSignals(listing, ascData?)` | Task 2 |
| `keywordLinterFacts` branches on `observable` | Task 3 |
| ASC promo text section in prompt | Task 3 |
| `advancedAuditFailed` limitation note in prompt | Task 3 |
| `advanced_audit` migration | Task 4 |
| `AuditJob.advancedAudit` + `insertJob` | Task 4 |
| `/audit/start` reads `advancedAudit` | Task 4 |
| Workflow: DB lookup + ASC fetch + inject | Task 5 |
| `buildAuditPrompt` receives `advancedAuditFailed` | Task 5 |
| `AscConnectModal` (3-field form, saves creds) | Task 6 |
| `Composer` Advanced toggle + badge + modal trigger | Task 6 |
| `startAudit` opts bag | Task 6 |
| `useAudit.submitUrl` passes opts through | Task 6 |

**2. Placeholder scan:** No TBD/TODO. All code blocks are complete. ✓

**3. Type consistency:**
- `AscListingData` defined in Task 1, imported in Tasks 2 and 5 ✓
- `ListingSignals.keywordField` discriminated union defined in Task 2, consumed in Task 3 ✓
- `buildAuditPrompt` new `advancedAuditFailed?` param defined in Task 3, called in Task 5 ✓
- `insertJob` `advancedAudit?` param defined in Task 4, called from Task 4 route ✓
- `startAudit(url, opts?)` defined in Task 6, called by `useAudit` ✓
