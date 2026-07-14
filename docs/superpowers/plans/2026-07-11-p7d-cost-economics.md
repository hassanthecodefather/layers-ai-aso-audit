# P7-D: Cost Economics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make cost a first-class concern — route cheap tasks to a cheaper LLM tier, skip vision when screenshots haven't changed, enforce a hard per-run token budget, and expose unit-economics via a summary API route.

**Architecture:** `getLlmProvider(tier)` selects between `LLM_MODEL` (capable) and `LLM_MODEL_FAST` (fast) based on the task. A hash of screenshot URLs gates vision runs. A `CostLedger` class accumulates token usage per task, throws `BudgetExceededError` when the limit is hit, and the workflow persists it as `cost_json` on the job row. `GET /api/cost/summary` aggregates `cost_json` across the tenant's recent jobs.

**Tech Stack:** Node.js crypto (SHA-256), postgres.js template literals, Mastra step `runId` context, Vitest + real Postgres for integration tests.

## Global Constraints

- All DB queries use `postgres.js` template literals (`sql\`...\``). Never string-concatenate SQL.
- All migrations are appended to `PG_ONLY_MIGRATIONS` in `apps/server/src/memory/pg-migrate.ts` — no trailing semicolons, append-only.
- New env vars `LLM_MODEL_FAST` and `AUDIT_BUDGET_CENTS` are optional with documented defaults. Do NOT add them to the `REQUIRED` block in `env.ts`.
- `LLM_MODEL_FAST` defaults to `LLM_MODEL` when unset — existing deployments are unaffected.
- Run: `nvm use 24` before any `pnpm` command (shell defaults to Node 18).
- Test files use real Postgres with a unique schema prefix for isolation (same pattern as `measurement/store.test.ts`).
- All new types must be compatible with existing Zod schemas (add as `.optional()` fields for backward compat).

---

## File Map

**New files:**
- `apps/server/src/vision/screenshot-hash.ts` — pure hash function
- `apps/server/src/vision/screenshot-hash.test.ts`
- `apps/server/src/cost/ledger.ts` — `CostLedger` class, `BudgetExceededError`
- `apps/server/src/cost/ledger.test.ts`
- `apps/server/src/cost/routes.ts` — `GET /api/cost/summary`
- `apps/server/src/cost/routes.test.ts`

**Modified files:**
- `apps/server/src/llm/index.ts` — add `tier` param to `getLlmProvider()`
- `apps/server/src/mastra/tools/resolve-identity.ts` — call `getLlmProvider('fast')` internally
- `apps/server/src/reviews/themes.ts` — add optional `_ledger` param to `analyzeThemes`
- `apps/server/src/keywords/competitor-mining.ts` — add optional `_ledger` param to `mineCompetitorReviews`
- `apps/server/src/memory/audit-memory.ts` — `PersistInput.screenshotHash`, ledger wiring in `runGeneration`/`produceAuditDraft`
- `apps/server/src/domain/snapshot.ts` — add `screenshotHash` optional field
- `apps/server/src/memory/postgres-storage-client.ts` — `screenshot_hash` in INSERT + parse
- `apps/server/src/memory/pg-migrate.ts` — two new `ALTER TABLE` migrations
- `apps/server/src/queue/job-store.ts` — `costJson` field + `updateJobCostJson` function
- `apps/server/src/mastra/workflows/audit-workflow.ts` — tier wiring + vision gate + ledger
- `apps/server/src/mastra/index.ts` — register `costRoutes`

---

## Task 1: Model Tiering

**Files:**
- Modify: `apps/server/src/llm/index.ts`
- Modify: `apps/server/src/mastra/tools/resolve-identity.ts:155`
- Modify: `apps/server/src/mastra/workflows/audit-workflow.ts:360-362,492,502,545,623`

**Interfaces:**
- Produces: `getLlmProvider(tier?: 'fast' | 'capable'): LlmProvider` — default remains `'capable'`; when `LLM_MODEL_FAST` is unset, `'fast'` returns the same model as `'capable'`

- [ ] **Step 1: Update `getLlmProvider` in `apps/server/src/llm/index.ts`**

Find:
```ts
export function getLlmProvider(): LlmProvider {
  const id = (process.env.LLM_PROVIDER ?? 'google').trim().toLowerCase();

  switch (id) {
    case 'google':
      return new GoogleProvider({
        baseUrl: process.env.LLM_BASE_URL?.trim() || DEFAULT_GOOGLE_BASE_URL,
        model: process.env.LLM_MODEL?.trim() || DEFAULT_GOOGLE_MODEL,
        apiKey:
```

Replace with:
```ts
export function getLlmProvider(tier: 'fast' | 'capable' = 'capable'): LlmProvider {
  const id = (process.env.LLM_PROVIDER ?? 'google').trim().toLowerCase();

  switch (id) {
    case 'google': {
      const capableModel = process.env.LLM_MODEL?.trim() || DEFAULT_GOOGLE_MODEL;
      const fastModel = process.env.LLM_MODEL_FAST?.trim() || capableModel;
      return new GoogleProvider({
        baseUrl: process.env.LLM_BASE_URL?.trim() || DEFAULT_GOOGLE_BASE_URL,
        model: tier === 'fast' ? fastModel : capableModel,
        apiKey:
```

Also close the existing `case 'google':` block: the existing `})` and `;` at the end of the `case 'google':` block needs a `}` added. Find:
```ts
        '',
      });
    default:
```
Replace with:
```ts
        '',
      });
    }
    default:
```

- [ ] **Step 2: Update `geminiClassifier` in `apps/server/src/mastra/tools/resolve-identity.ts`**

Find (line 155):
```ts
export const geminiClassifier: IdentityClassifier = async (factSheet) => {
  const llm = getLlmProvider();
```

Replace with:
```ts
export const geminiClassifier: IdentityClassifier = async (factSheet) => {
  const llm = getLlmProvider('fast');
```

- [ ] **Step 3: Update tier assignments in `apps/server/src/mastra/workflows/audit-workflow.ts`**

Find (around line 360):
```ts
    const llm = getLlmProvider();
    if (!(await llm.reachable())) {
      throw new Error(
        `Couldn't reach Gemini at ${llm.endpoint}. Check that LLM_API_KEY ` +
```

Replace with:
```ts
    const capableLlm = getLlmProvider();
    const fastLlm = getLlmProvider('fast');
    if (!(await capableLlm.reachable())) {
      throw new Error(
        `Couldn't reach Gemini at ${capableLlm.endpoint}. Check that LLM_API_KEY ` +
```

Find (around line 492):
```ts
      listing.reviews.length > 0 ? await analyzeThemes(listing.reviews, llm) : null
```
Replace with:
```ts
      listing.reviews.length > 0 ? await analyzeThemes(listing.reviews, fastLlm) : null
```

Find (around line 502):
```ts
      ? (priorMiningResult ?? await mineCompetitorReviews(listing.competitors, ref.country, llm))
```
Replace with:
```ts
      ? (priorMiningResult ?? await mineCompetitorReviews(listing.competitors, ref.country, fastLlm))
```

Find (around line 545):
```ts
        `The auditor model (${llm.modelId}) failed: ` +
```
Replace with:
```ts
        `The auditor model (${capableLlm.modelId}) failed: ` +
```

Find (around line 623):
```ts
      usedModelId = llm.modelId;
```
Replace with:
```ts
      usedModelId = capableLlm.modelId;
```

- [ ] **Step 4: Build verification**

Run: `nvm use 24 && cd apps/server && pnpm tsc --noEmit`
Expected: zero TypeScript errors.

- [ ] **Step 5: Run existing llm + workflow tests**

Run: `nvm use 24 && cd apps/server && pnpm test llm/ mastra/workflows/`
Expected: all passing (behavior is transparent when `LLM_MODEL_FAST` is unset).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/llm/index.ts apps/server/src/mastra/tools/resolve-identity.ts apps/server/src/mastra/workflows/audit-workflow.ts
git commit -m "feat(p7d): model tiering — getLlmProvider(tier); fast tier for extraction tasks"
```

---

## Task 2: Vision Gate-on-Change

**Files:**
- Create: `apps/server/src/vision/screenshot-hash.ts`
- Create: `apps/server/src/vision/screenshot-hash.test.ts`
- Modify: `apps/server/src/domain/snapshot.ts`
- Modify: `apps/server/src/memory/audit-memory.ts`
- Modify: `apps/server/src/memory/postgres-storage-client.ts`
- Modify: `apps/server/src/memory/pg-migrate.ts`
- Modify: `apps/server/src/mastra/workflows/audit-workflow.ts`

**Interfaces:**
- Consumes: `ListingSnapshot.screenshotHash` (added here), `listing.screenshotUrls: string[]`
- Produces: `computeScreenshotHash(screenshotUrls: string[]): string | null` — stable hash of sorted URL set; `null` when empty

- [ ] **Step 1: Write the failing test — `apps/server/src/vision/screenshot-hash.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { computeScreenshotHash } from './screenshot-hash';

describe('computeScreenshotHash', () => {
  it('returns null for empty array', () => {
    expect(computeScreenshotHash([])).toBeNull();
  });

  it('same URLs in different order produce the same hash', () => {
    const a = computeScreenshotHash(['https://example.com/a.png', 'https://example.com/b.png']);
    const b = computeScreenshotHash(['https://example.com/b.png', 'https://example.com/a.png']);
    expect(a).toBe(b);
    expect(a).not.toBeNull();
  });

  it('different URL set produces a different hash', () => {
    const a = computeScreenshotHash(['https://example.com/a.png']);
    const b = computeScreenshotHash(['https://example.com/c.png']);
    expect(a).not.toBe(b);
  });

  it('adding one URL changes the hash', () => {
    const a = computeScreenshotHash(['https://example.com/a.png']);
    const b = computeScreenshotHash(['https://example.com/a.png', 'https://example.com/new.png']);
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nvm use 24 && cd apps/server && pnpm test vision/screenshot-hash.test.ts`
Expected: FAIL — `Cannot find module './screenshot-hash'`.

- [ ] **Step 3: Implement `apps/server/src/vision/screenshot-hash.ts`**

```ts
import { createHash } from 'node:crypto';

export function computeScreenshotHash(screenshotUrls: string[]): string | null {
  if (!screenshotUrls.length) return null;
  return createHash('sha256')
    .update([...screenshotUrls].sort().join('|'))
    .digest('hex');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `nvm use 24 && cd apps/server && pnpm test vision/screenshot-hash.test.ts`
Expected: PASS — 4 passed.

- [ ] **Step 5: Add `screenshotHash` to `apps/server/src/domain/snapshot.ts`**

Find:
```ts
  competitorMiningResult: z.unknown().optional(),
});
export type ListingSnapshot = z.infer<typeof ListingSnapshotSchema>;
```

Replace with:
```ts
  competitorMiningResult: z.unknown().optional(),
  /**
   * SHA-256 hash of sorted screenshot URLs at snapshot time. Used by the
   * vision gate to skip B1/B2/B3 when screenshots are unchanged.
   * Absent in pre-P7-D snapshots — treated as "vision needed."
   */
  screenshotHash: z.string().nullable().optional(),
});
export type ListingSnapshot = z.infer<typeof ListingSnapshotSchema>;
```

- [ ] **Step 6: Update `PersistInput` in `apps/server/src/memory/audit-memory.ts`**

Find (the `PersistInput` interface definition — look for `visionResult?: unknown;`):
```ts
  visionResult?: unknown;
```
There should be surrounding context. Add `screenshotHash` alongside it. Find the full block (around line 247):
```ts
  visionResult?: unknown;
  candidateResult?: unknown;
```
Replace with:
```ts
  screenshotHash?: string | null;
  visionResult?: unknown;
  candidateResult?: unknown;
```

Also add it to the snapshot object constructed inside `persistAudit` (around line 321, where the snapshot object is built). Find:
```ts
    visionResult: input.visionResult,
    candidateResult: input.candidateResult,
```
Replace with:
```ts
    screenshotHash: input.screenshotHash,
    visionResult: input.visionResult,
    candidateResult: input.candidateResult,
```

- [ ] **Step 7: Update `postgres-storage-client.ts` — add `screenshot_hash` to INSERT and parse**

In `putSnapshot`, find (the INSERT column list):
```ts
           report_json, rubric_version, prompt_hash, model_id, vision_result_json,
           candidate_result_json, theme_result_json,
           function_competitor_seeds_json, competitor_mining_result_json)
        Values (
          ${s.id}, ${s.appId}, ${s.country}, ${tenantId}, ${s.fetchedAt},
          ${JSON.stringify(s.listing)}, ${JSON.stringify(s.signals ?? null)},
          ${JSON.stringify(s.report)}, ${s.rubricVersion}, ${s.promptHash}, ${s.modelId},
          ${s.visionResult != null ? JSON.stringify(s.visionResult) : null},
          ${s.candidateResult != null ? JSON.stringify(s.candidateResult) : null},
          ${s.themeResult != null ? JSON.stringify(s.themeResult) : null},
          ${s.functionCompetitorSeeds != null ? JSON.stringify(s.functionCompetitorSeeds) : null},
          ${s.competitorMiningResult != null ? JSON.stringify(s.competitorMiningResult) : null}
```

Replace with:
```ts
           report_json, rubric_version, prompt_hash, model_id, vision_result_json,
           candidate_result_json, theme_result_json,
           function_competitor_seeds_json, competitor_mining_result_json, screenshot_hash)
        Values (
          ${s.id}, ${s.appId}, ${s.country}, ${tenantId}, ${s.fetchedAt},
          ${JSON.stringify(s.listing)}, ${JSON.stringify(s.signals ?? null)},
          ${JSON.stringify(s.report)}, ${s.rubricVersion}, ${s.promptHash}, ${s.modelId},
          ${s.visionResult != null ? JSON.stringify(s.visionResult) : null},
          ${s.candidateResult != null ? JSON.stringify(s.candidateResult) : null},
          ${s.themeResult != null ? JSON.stringify(s.themeResult) : null},
          ${s.functionCompetitorSeeds != null ? JSON.stringify(s.functionCompetitorSeeds) : null},
          ${s.competitorMiningResult != null ? JSON.stringify(s.competitorMiningResult) : null},
          ${s.screenshotHash ?? null}
```

In `#parseSnapshot`, find (the safeParse object, around line 267):
```ts
      competitorMiningResult: competitorMiningResultRaw,
    });
```
Replace with:
```ts
      competitorMiningResult: competitorMiningResultRaw,
      screenshotHash: row.screenshot_hash != null ? String(row.screenshot_hash) : undefined,
    });
```

- [ ] **Step 8: Add migration to `apps/server/src/memory/pg-migrate.ts`**

Find the last entry in `PG_ONLY_MIGRATIONS` (the `aso_measurement_windows_uniq_version` index). Append after the last backtick-comma:

```ts
  `CREATE UNIQUE INDEX IF NOT EXISTS aso_measurement_windows_uniq_version ON aso_measurement_windows (tenant_id, app_id, country, version_string)`,
```

After it, add:
```ts
  `ALTER TABLE aso_listing_snapshots ADD COLUMN screenshot_hash TEXT`,
```

- [ ] **Step 9: Add vision gate to `apps/server/src/mastra/workflows/audit-workflow.ts`**

Add the import at the top of the file, alongside existing vision imports (line 33):
```ts
import { getVisionClient, runVision, selectVisionResult } from '../../vision';
```
Replace with:
```ts
import { getVisionClient, runVision, selectVisionResult } from '../../vision';
import { computeScreenshotHash } from '../../vision/screenshot-hash';
```

Find the existing vision block (around lines 456-463):
```ts
    const visionClient = getVisionClient();
    const priorVisionResult = selectVisionResult(listing, signals, priorSnap);
    const visionResult = priorVisionResult ?? (await runVision(listing, visionClient));
    // Track whether vision ran fresh (i.e., no cached result was available).
    // B2 and B3 are gated on this: they only add value when vision ran fresh —
    // if images are unchanged, the prior vision-grounded identity and uplift
    // findings remain valid, and re-running would make unnecessary LLM calls.
    const visionWasFresh = priorVisionResult === null;
```

Replace with:
```ts
    const visionClient = getVisionClient();
    const currentScreenshotHash = computeScreenshotHash(listing.screenshotUrls);
    const visionNeeded =
      !priorSnap?.screenshotHash ||
      priorSnap.screenshotHash !== currentScreenshotHash;

    let visionResult: unknown;
    let visionWasFresh: boolean;
    if (visionNeeded) {
      const priorVisionResult = selectVisionResult(listing, signals, priorSnap);
      visionResult = priorVisionResult ?? (await runVision(listing, visionClient));
      // B2 and B3 are gated on this: they only add value when vision ran fresh —
      // if images are unchanged, the prior vision-grounded identity and uplift
      // findings remain valid, and re-running would make unnecessary LLM calls.
      visionWasFresh = priorVisionResult === null;
    } else {
      visionResult = priorSnap?.visionResult ?? null;
      visionWasFresh = false;
    }
```

Find the `persistAudit` call (around line 627) and add `screenshotHash` to its arguments. Find:
```ts
      visionResult, // B1: persist vision result for future reuse
```
Replace with:
```ts
      screenshotHash: currentScreenshotHash,
      visionResult, // B1: persist vision result for future reuse
```

- [ ] **Step 10: Build verification**

Run: `nvm use 24 && cd apps/server && pnpm tsc --noEmit`
Expected: zero TypeScript errors.

- [ ] **Step 11: Run vision + memory tests**

Run: `nvm use 24 && cd apps/server && pnpm test vision/ memory/`
Expected: all passing.

- [ ] **Step 12: Commit**

```bash
git add apps/server/src/vision/screenshot-hash.ts apps/server/src/vision/screenshot-hash.test.ts apps/server/src/domain/snapshot.ts apps/server/src/memory/audit-memory.ts apps/server/src/memory/postgres-storage-client.ts apps/server/src/memory/pg-migrate.ts apps/server/src/mastra/workflows/audit-workflow.ts
git commit -m "feat(p7d): vision gate-on-screenshot-hash; skip B1/B2/B3 when screenshots unchanged"
```

---

## Task 3: CostLedger + Budget Enforcement

**Files:**
- Create: `apps/server/src/cost/ledger.ts`
- Create: `apps/server/src/cost/ledger.test.ts`
- Modify: `apps/server/src/queue/job-store.ts`
- Modify: `apps/server/src/memory/pg-migrate.ts`
- Modify: `apps/server/src/reviews/themes.ts`
- Modify: `apps/server/src/keywords/competitor-mining.ts`
- Modify: `apps/server/src/memory/audit-memory.ts`
- Modify: `apps/server/src/mastra/workflows/audit-workflow.ts`

**Interfaces:**
- Consumes: `getPgSql()` (memory/index), Mastra step `runId` context parameter
- Produces:
  - `CostLedger.record(task, tier, usage)` — accumulates cost entries
  - `CostLedger.checkBudget()` — throws `BudgetExceededError` when `totalCents > limitCents`
  - `CostLedger.toJSON()` — `{ totalCents: number; breakdown: LedgerEntry[] }`
  - `BudgetExceededError` — `extends Error`, has `.spentCents` and `.limitCents`
  - `updateJobCostJson(sql, id, costJson)` — writes `cost_json` to `aso_audit_jobs` by row id
  - `analyzeThemes(reviews, llm, _generateOverride?, _ledger?)` — unchanged for callers without ledger
  - `mineCompetitorReviews(competitors, country, llm, _analyzeOverride?, _fetchReviewsOverride?, _ledger?)` — unchanged for callers without ledger
  - `produceAuditDraft(agent, listing, signals, priorContext, builtPrompt, _ledger?)` — unchanged for callers without ledger

- [ ] **Step 1: Write the failing test — `apps/server/src/cost/ledger.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { CostLedger, BudgetExceededError, CENTS_PER_1K } from './ledger';

describe('CostLedger', () => {
  it('record() accumulates entries and totalCents', () => {
    const ledger = new CostLedger(10_000);
    ledger.record('themes', 'fast', { promptTokens: 1000, completionTokens: 200 });
    const json = ledger.toJSON();
    expect(json.breakdown).toHaveLength(1);
    expect(json.breakdown[0]!.task).toBe('themes');
    expect(json.breakdown[0]!.promptTokens).toBe(1000);
    expect(json.breakdown[0]!.completionTokens).toBe(200);
    expect(json.totalCents).toBeCloseTo(
      (1000 / 1000) * CENTS_PER_1K.fast.prompt +
      (200  / 1000) * CENTS_PER_1K.fast.completion,
      5,
    );
  });

  it('checkBudget() throws BudgetExceededError when over limit', () => {
    const ledger = new CostLedger(1); // 1 cent limit
    ledger.record('scoring', 'capable', { promptTokens: 100_000, completionTokens: 10_000 });
    expect(() => ledger.checkBudget()).toThrow(BudgetExceededError);
  });

  it('checkBudget() does not throw when under limit', () => {
    const ledger = new CostLedger(10_000);
    ledger.record('themes', 'fast', { promptTokens: 100, completionTokens: 50 });
    expect(() => ledger.checkBudget()).not.toThrow();
  });

  it('toJSON() serialises all breakdown entries', () => {
    const ledger = new CostLedger(10_000);
    ledger.record('themes', 'fast', { promptTokens: 500, completionTokens: 100 });
    ledger.record('scoring', 'capable', { promptTokens: 1000, completionTokens: 300 });
    const json = ledger.toJSON();
    expect(json.breakdown).toHaveLength(2);
    expect(json.breakdown[1]!.task).toBe('scoring');
  });

  it('pricing constants smoke-test: fast tier values match documented rates', () => {
    // Canary — fails if someone accidentally changes the pricing constants.
    // Update this test when rates actually change.
    expect(CENTS_PER_1K.fast.prompt).toBe(0.0075);
    expect(CENTS_PER_1K.fast.completion).toBe(0.030);
    expect(CENTS_PER_1K.capable.prompt).toBe(0.125);
    expect(CENTS_PER_1K.capable.completion).toBe(0.375);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nvm use 24 && cd apps/server && pnpm test cost/ledger.test.ts`
Expected: FAIL — `Cannot find module './ledger'`.

- [ ] **Step 3: Implement `apps/server/src/cost/ledger.ts`**

```ts
export type TaskName =
  | 'identity'
  | 'vision'
  | 'themes'
  | 'competitor_mining'
  | 'scoring';

type LedgerEntry = {
  task: TaskName;
  promptTokens: number;
  completionTokens: number;
  estimatedCents: number;
};

export const CENTS_PER_1K: Record<'fast' | 'capable', { prompt: number; completion: number }> = {
  fast:    { prompt: 0.0075, completion: 0.030 },
  capable: { prompt: 0.125,  completion: 0.375 },
};

export class BudgetExceededError extends Error {
  constructor(public spentCents: number, public limitCents: number) {
    super(`Budget exceeded: $${(spentCents / 100).toFixed(2)} spent of $${(limitCents / 100).toFixed(2)} limit`);
    this.name = 'BudgetExceededError';
  }
}

export class CostLedger {
  private entries: LedgerEntry[] = [];

  constructor(private readonly limitCents: number) {}

  record(
    task: TaskName,
    tier: 'fast' | 'capable',
    usage: { promptTokens: number; completionTokens: number },
  ): void {
    const rates = CENTS_PER_1K[tier];
    const estimatedCents =
      (usage.promptTokens     / 1000) * rates.prompt +
      (usage.completionTokens / 1000) * rates.completion;
    this.entries.push({
      task,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      estimatedCents,
    });
  }

  checkBudget(): void {
    const total = this.totalCents();
    if (total > this.limitCents) throw new BudgetExceededError(total, this.limitCents);
  }

  totalCents(): number {
    return this.entries.reduce((sum, e) => sum + e.estimatedCents, 0);
  }

  toJSON(): { totalCents: number; breakdown: LedgerEntry[] } {
    return { totalCents: this.totalCents(), breakdown: this.entries };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `nvm use 24 && cd apps/server && pnpm test cost/ledger.test.ts`
Expected: PASS — 5 passed.

- [ ] **Step 5: Add migration to `apps/server/src/memory/pg-migrate.ts`**

Append after the `screenshot_hash` migration added in Task 2:
```ts
  `ALTER TABLE aso_audit_jobs ADD COLUMN cost_json TEXT`,
```

- [ ] **Step 6: Add `costJson` and `updateJobCostJson` to `apps/server/src/queue/job-store.ts`**

Add `costJson` to the `AuditJob` interface. Find:
```ts
  errorMessage: string | null;
  attempt: number;
```
Replace with:
```ts
  errorMessage: string | null;
  costJson: string | null;
  attempt: number;
```

Add `cost_json` to the `JobRow` interface. Find:
```ts
  error_message: string | null;
  attempt: number;
```
Replace with:
```ts
  error_message: string | null;
  cost_json: string | null;
  attempt: number;
```

Add `costJson` to `rowToJob`. Find:
```ts
    errorMessage: r.error_message,
    attempt: r.attempt,
```
Replace with:
```ts
    errorMessage: r.error_message,
    costJson: r.cost_json,
    attempt: r.attempt,
```

Add `updateJobCostJson` function after `markJobFailed`:
```ts
export async function updateJobCostJson(
  sql: postgres.Sql,
  id: string,
  costJson: string,
): Promise<void> {
  await sql`UPDATE aso_audit_jobs SET cost_json = ${costJson} WHERE id = ${id}`;
}
```

- [ ] **Step 7: Add optional `_ledger` to `analyzeThemes` in `apps/server/src/reviews/themes.ts`**

Add import at top of file:
```ts
import type { CostLedger } from '../cost/ledger';
```

Find the function signature:
```ts
export async function analyzeThemes(
  reviews: Review[],
  llm: LlmProvider,
  _generateOverride?: (prompt: string) => Promise<string>,
): Promise<ThemeAnalysisResult> {
```
Replace with:
```ts
export async function analyzeThemes(
  reviews: Review[],
  llm: LlmProvider,
  _generateOverride?: (prompt: string) => Promise<string>,
  _ledger?: CostLedger,
): Promise<ThemeAnalysisResult> {
```

In the production path (after `themeAgent.generate(prompt, ...)`), find:
```ts
      rawText = typeof result.text === 'string' ? result.text : '';
    } catch {
      return emptyResult(versionDelta, reviews.length);
    }
  }
```
Replace with:
```ts
      rawText = typeof result.text === 'string' ? result.text : '';
      const usage = (result as any).usage as { promptTokens?: number; completionTokens?: number } | undefined;
      if (_ledger && usage?.promptTokens !== undefined) {
        _ledger.record('themes', 'fast', {
          promptTokens: usage.promptTokens ?? 0,
          completionTokens: usage.completionTokens ?? 0,
        });
        _ledger.checkBudget();
      }
    } catch {
      return emptyResult(versionDelta, reviews.length);
    }
  }
```

- [ ] **Step 8: Add optional `_ledger` to `mineCompetitorReviews` in `apps/server/src/keywords/competitor-mining.ts`**

Add import at top of file:
```ts
import type { CostLedger } from '../cost/ledger';
```

Find the function signature:
```ts
export async function mineCompetitorReviews(
  competitors: Competitor[],
  country: string,
  llm: LlmProvider,
  _analyzeOverride?: typeof analyzeThemes,
  _fetchReviewsOverride?: typeof fetchReviews,
): Promise<CompetitorMiningResult | null> {
```
Replace with:
```ts
export async function mineCompetitorReviews(
  competitors: Competitor[],
  country: string,
  llm: LlmProvider,
  _analyzeOverride?: typeof analyzeThemes,
  _fetchReviewsOverride?: typeof fetchReviews,
  _ledger?: CostLedger,
): Promise<CompetitorMiningResult | null> {
```

Find the inner `analyze` call (the one that calls `analyzeThemes`):
```ts
    themeResult = await analyze(
      allLowRatingReviews.map((r) => r.review),
      llm,
    );
```
Replace with:
```ts
    themeResult = await analyze(
      allLowRatingReviews.map((r) => r.review),
      llm,
      undefined,
      _ledger,
    );
```

- [ ] **Step 9: Add optional `_ledger` to `runGeneration` and `produceAuditDraft` in `apps/server/src/memory/audit-memory.ts`**

Add import near the top of the file:
```ts
import type { CostLedger } from '../cost/ledger';
```

Find `runGeneration` (around line 73). The function currently starts with:
```ts
/** Run one plain-text generation, return its text, and emit a provider_call log event. */
```
Followed by the function definition. Find the function signature (it returns a string). Update it to accept an optional ledger. The exact signature isn't shown in the summary, but it likely looks like:
```ts
async function runGeneration(agent: any, prompt: string, signals: any, ...): Promise<string>
```

You need to read the exact signature from the file. Add `_ledger?: CostLedger` as the last optional parameter.

Inside `runGeneration`, after the existing usage extraction (around line 90-103):
```ts
  const usage = (result as any).usage as { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined;
  const inputTokens = usage?.promptTokens ?? 0;
  const outputTokens = usage?.completionTokens ?? 0;
```

After these lines (before the `return text` line), add:
```ts
  if (_ledger && usage?.promptTokens !== undefined) {
    _ledger.record('scoring', 'capable', { promptTokens: inputTokens, completionTokens: outputTokens });
    _ledger.checkBudget();
  }
```

Find `produceAuditDraft` and add `_ledger?: CostLedger` as its last optional parameter. Pass `_ledger` through to the `runGeneration` call(s) inside it.

- [ ] **Step 10: Wire `CostLedger` into `audit-workflow.ts`**

Add imports at the top of `apps/server/src/mastra/workflows/audit-workflow.ts`:
```ts
import { CostLedger, BudgetExceededError } from '../../cost/ledger';
import { getPgSql } from '../../memory';
```

In the `scoreStep.execute` function signature, destructure `runId`:
Find:
```ts
  execute: async ({ inputData, mastra, getStepResult }) => {
```
Replace with:
```ts
  execute: async ({ inputData, mastra, getStepResult, runId }) => {
```

After the existing `const capableLlm = getLlmProvider(); const fastLlm = getLlmProvider('fast');` lines (from Task 1), add:
```ts
    const ledger = new CostLedger(parseInt(process.env.AUDIT_BUDGET_CENTS ?? '500', 10));
```

Pass `ledger` to `analyzeThemes`:
Find (from Task 1):
```ts
      listing.reviews.length > 0 ? await analyzeThemes(listing.reviews, fastLlm) : null
```
Replace with:
```ts
      listing.reviews.length > 0 ? await analyzeThemes(listing.reviews, fastLlm, undefined, ledger) : null
```

Pass `ledger` to `mineCompetitorReviews`:
Find (from Task 1):
```ts
      ? (priorMiningResult ?? await mineCompetitorReviews(listing.competitors, ref.country, fastLlm))
```
Replace with:
```ts
      ? (priorMiningResult ?? await mineCompetitorReviews(listing.competitors, ref.country, fastLlm, undefined, undefined, ledger))
```

Pass `ledger` to `produceAuditDraft`:
Find:
```ts
        draft = await produceAuditDraft(agent, listing, signals, priorContext, builtPrompt);
```
Replace with:
```ts
        draft = await produceAuditDraft(agent, listing, signals, priorContext, builtPrompt, ledger);
```

Persist the ledger at step end. Find the `finally` block (around line 749):
```ts
    } finally {
      getGovernor().endRun();
    }
```
Replace with:
```ts
    } finally {
      getGovernor().endRun();
      const sql = getPgSql();
      if (sql && runId) {
        try {
          await sql`UPDATE aso_audit_jobs SET cost_json = ${JSON.stringify(ledger.toJSON())} WHERE run_id = ${runId}`;
        } catch { /* cost tracking is non-critical — don't fail the audit */ }
      }
    }
```

- [ ] **Step 11: Build verification**

Run: `nvm use 24 && cd apps/server && pnpm tsc --noEmit`
Expected: zero TypeScript errors.

- [ ] **Step 12: Run tests**

Run: `nvm use 24 && cd apps/server && pnpm test cost/ledger reviews/themes keywords/competitor-mining memory/audit-memory`
Expected: all passing.

- [ ] **Step 13: Commit**

```bash
git add apps/server/src/cost/ledger.ts apps/server/src/cost/ledger.test.ts apps/server/src/queue/job-store.ts apps/server/src/memory/pg-migrate.ts apps/server/src/reviews/themes.ts apps/server/src/keywords/competitor-mining.ts apps/server/src/memory/audit-memory.ts apps/server/src/mastra/workflows/audit-workflow.ts
git commit -m "feat(p7d): CostLedger with BudgetExceededError; wire per-task usage tracking into workflow"
```

---

## Task 4: GET /api/cost/summary Route

**Files:**
- Create: `apps/server/src/cost/routes.ts`
- Create: `apps/server/src/cost/routes.test.ts`
- Modify: `apps/server/src/mastra/index.ts`

**Interfaces:**
- Consumes: `getAuthenticatedTenantId` (auth/middleware), `getPgSql` (memory), `registerApiRoute` (@mastra/core/server)
- Produces:
  - `GET /api/cost/summary` → `{ runsLast30Days: number; averageCentsPerRun: number; totalCentsLast30Days: number; breakdown: { task: string; averageCents: number; percentOfTotal: number }[] }`
  - Returns `{ runsLast30Days: 0, averageCentsPerRun: 0, totalCentsLast30Days: 0, breakdown: [] }` when no jobs with `cost_json` exist.

- [ ] **Step 1: Write the failing test — `apps/server/src/cost/routes.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import { runMigrations } from '../memory/pg-migrate';
import { insertJob, markJobDone, updateJobCostJson } from '../queue/job-store';
import { newId } from '../memory/ids';
import { getCostSummary } from './routes';

const TEST_SCHEMA = `test_cost_routes_${Date.now()}`;

let sql: postgres.Sql;

beforeAll(async () => {
  sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  await sql`CREATE SCHEMA IF NOT EXISTS ${sql.unsafe(TEST_SCHEMA)}`;
  await sql`SET search_path TO ${sql.unsafe(TEST_SCHEMA)}`;
  await runMigrations(sql);
});

afterAll(async () => {
  await sql`DROP SCHEMA IF EXISTS ${sql.unsafe(TEST_SCHEMA)} CASCADE`;
  await sql.end();
});

beforeEach(async () => {
  await sql`TRUNCATE aso_audit_jobs CASCADE`;
});

async function seedJob(tenantId: string, costJson: string): Promise<void> {
  const runId = newId('run');
  const job = await insertJob(sql, { runId, tenantId, url: 'https://apps.apple.com/us/app/test/id1' });
  await sql`UPDATE aso_audit_jobs SET status = 'running' WHERE id = ${job.id}`;
  await markJobDone(sql, job.id, '{}');
  await updateJobCostJson(sql, job.id, costJson);
}

describe('getCostSummary', () => {
  it('returns zero summary when no jobs with cost_json exist', async () => {
    const result = await getCostSummary(sql, 'tenant1');
    expect(result.runsLast30Days).toBe(0);
    expect(result.averageCentsPerRun).toBe(0);
    expect(result.totalCentsLast30Days).toBe(0);
    expect(result.breakdown).toEqual([]);
  });

  it('returns correct aggregate over seeded job rows', async () => {
    const cost1 = JSON.stringify({
      totalCents: 10,
      breakdown: [
        { task: 'themes', promptTokens: 100, completionTokens: 50, estimatedCents: 4 },
        { task: 'scoring', promptTokens: 200, completionTokens: 100, estimatedCents: 6 },
      ],
    });
    const cost2 = JSON.stringify({
      totalCents: 20,
      breakdown: [
        { task: 'themes', promptTokens: 200, completionTokens: 80, estimatedCents: 8 },
        { task: 'scoring', promptTokens: 400, completionTokens: 200, estimatedCents: 12 },
      ],
    });
    await seedJob('tenant1', cost1);
    await seedJob('tenant1', cost2);

    const result = await getCostSummary(sql, 'tenant1');
    expect(result.runsLast30Days).toBe(2);
    expect(result.totalCentsLast30Days).toBeCloseTo(30, 5);
    expect(result.averageCentsPerRun).toBeCloseTo(15, 5);
    expect(result.breakdown).toHaveLength(2);
    // Sorted by average cost descending — scoring (avg 9) before themes (avg 6).
    expect(result.breakdown[0]!.task).toBe('scoring');
    expect(result.breakdown[0]!.averageCents).toBeCloseTo(9, 5);
    expect(result.breakdown[1]!.task).toBe('themes');
    expect(result.breakdown[1]!.averageCents).toBeCloseTo(6, 5);
  });

  it('does not include jobs from other tenants', async () => {
    await seedJob('tenant_other', JSON.stringify({ totalCents: 50, breakdown: [] }));
    const result = await getCostSummary(sql, 'tenant1');
    expect(result.runsLast30Days).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nvm use 24 && cd apps/server && pnpm test cost/routes.test.ts`
Expected: FAIL — `Cannot find module './routes'`.

- [ ] **Step 3: Implement `apps/server/src/cost/routes.ts`**

```ts
import { registerApiRoute } from '@mastra/core/server';
import postgres from 'postgres';
import { getAuthenticatedTenantId } from '../auth/middleware';
import { getPgSql } from '../memory';

export interface CostSummary {
  runsLast30Days: number;
  averageCentsPerRun: number;
  totalCentsLast30Days: number;
  breakdown: {
    task: string;
    averageCents: number;
    percentOfTotal: number;
  }[];
}

const EMPTY_SUMMARY: CostSummary = {
  runsLast30Days: 0,
  averageCentsPerRun: 0,
  totalCentsLast30Days: 0,
  breakdown: [],
};

export async function getCostSummary(sql: postgres.Sql, tenantId: string): Promise<CostSummary> {
  const rows = await sql<{ cost_json: string }[]>`
    SELECT cost_json
    FROM aso_audit_jobs
    WHERE tenant_id = ${tenantId}
      AND cost_json IS NOT NULL
      AND completed_at > NOW() - INTERVAL '30 days'
  `;

  if (rows.length === 0) return EMPTY_SUMMARY;

  const parsed = rows.map((r) => {
    try {
      return JSON.parse(r.cost_json) as {
        totalCents: number;
        breakdown: { task: string; estimatedCents: number }[];
      };
    } catch {
      return null;
    }
  }).filter((r): r is NonNullable<typeof r> => r !== null);

  if (parsed.length === 0) return EMPTY_SUMMARY;

  const totalCentsLast30Days = parsed.reduce((s, r) => s + r.totalCents, 0);
  const averageCentsPerRun = totalCentsLast30Days / parsed.length;

  // Aggregate per-task averages across all runs.
  const taskTotals = new Map<string, { sum: number; count: number }>();
  for (const run of parsed) {
    for (const entry of run.breakdown) {
      const existing = taskTotals.get(entry.task) ?? { sum: 0, count: 0 };
      taskTotals.set(entry.task, { sum: existing.sum + entry.estimatedCents, count: existing.count + 1 });
    }
  }

  const breakdown = [...taskTotals.entries()]
    .map(([task, { sum, count }]) => {
      const averageCents = sum / count;
      return {
        task,
        averageCents,
        percentOfTotal: averageCentsPerRun > 0 ? (averageCents / averageCentsPerRun) * 100 : 0,
      };
    })
    .sort((a, b) => b.averageCents - a.averageCents);

  return {
    runsLast30Days: parsed.length,
    averageCentsPerRun,
    totalCentsLast30Days,
    breakdown,
  };
}

export const costRoutes = [
  registerApiRoute('/api/cost/summary', {
    method: 'GET',
    handler: async (c) => {
      const tenantId = await getAuthenticatedTenantId(c);
      if (!tenantId) return c.json({ error: 'Unauthorized' }, 401);
      const sql = getPgSql();
      if (!sql) return c.json({ error: 'Database not configured.' }, 503);
      try {
        const summary = await getCostSummary(sql, tenantId);
        return c.json(summary);
      } catch (e) {
        console.error('[cost/summary] failed:', e);
        return c.json({ error: 'Could not compute cost summary.' }, 500);
      }
    },
  }),
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `nvm use 24 && cd apps/server && pnpm test cost/routes.test.ts`
Expected: PASS — 3 passed.

- [ ] **Step 5: Register `costRoutes` in `apps/server/src/mastra/index.ts`**

Find:
```ts
import { auditRoutes } from './routes';
```
Replace with:
```ts
import { auditRoutes } from './routes';
import { costRoutes } from '../cost/routes';
```

Find:
```ts
    apiRoutes: [...auditRoutes, ...authRoutes, ...healthRoutes, ...ascRoutes, ...trackingRoutes, ...getWebStaticRoutes()],
```
Replace with:
```ts
    apiRoutes: [...auditRoutes, ...authRoutes, ...healthRoutes, ...ascRoutes, ...trackingRoutes, ...costRoutes, ...getWebStaticRoutes()],
```

- [ ] **Step 6: Build verification**

Run: `nvm use 24 && cd apps/server && pnpm tsc --noEmit`
Expected: zero TypeScript errors.

- [ ] **Step 7: Run all cost tests**

Run: `nvm use 24 && cd apps/server && pnpm test cost/`
Expected: all passing.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/cost/routes.ts apps/server/src/cost/routes.test.ts apps/server/src/mastra/index.ts
git commit -m "feat(p7d): GET /api/cost/summary unit-economics route"
```

---

## Self-Review

**1. Spec coverage**

| Spec section | Task |
|---|---|
| §1 Model tiering — `getLlmProvider(tier)` | Task 1 |
| §1 `LLM_MODEL_FAST` env var fallback | Task 1 |
| §1 Tier assignments: geminiClassifier/themes/mining → fast; scoring → capable | Tasks 1 + 3 |
| §2 `computeScreenshotHash` | Task 2 |
| §2 `screenshot_hash` DB column | Task 2 |
| §2 Vision gate — skip B1/B2/B3 when hash unchanged | Task 2 |
| §2 Copy prior `visionResult` when vision skipped | Task 2 |
| §3 `CostLedger` class, `BudgetExceededError` | Task 3 |
| §3 `AUDIT_BUDGET_CENTS` env var, default 500 | Task 3 |
| §3 `cost_json` DB column | Task 3 |
| §3 Wire ledger into analyzeThemes, mineCompetitorReviews, produceAuditDraft | Task 3 |
| §3 Persist `cost_json` at run end via step `runId` | Task 3 |
| §4 `BudgetExceededError` visible in job `errorMessage` | Task 3 (checkBudget throws inside step; propagates to worker → markJobFailed) |
| §5 `GET /api/cost/summary` route | Task 4 |
| §5 `CostSummary` type with per-task breakdown sorted by average cost | Task 4 |
| §5 Zero summary when no completed jobs | Task 4 |
| §6 Tests: ledger, screenshot-hash, workflow integration, cost route | Tasks 2, 3, 4 |
| §6 Real Postgres for DB tests | Tasks 3, 4 |

**2. Placeholder scan:** No TBD or TODO in any step. All code blocks are complete.

**3. Type consistency:**
- `analyzeThemes(reviews, llm, _generateOverride?, _ledger?)` — 4th param matches Task 3 dispatch in audit-workflow (passes `undefined` as 3rd, `ledger` as 4th).
- `mineCompetitorReviews(competitors, country, llm, _analyzeOverride?, _fetchReviewsOverride?, _ledger?)` — matches Task 3 call site.
- `ListingSnapshot.screenshotHash: string | null | undefined` — matches `putSnapshot` write and `#parseSnapshot` read; Zod `.nullable().optional()` covers all three states.
- `CostLedger.toJSON()` returns `{ totalCents, breakdown }` — matches `cost_json` parse shape in `getCostSummary`.
- `updateJobCostJson` writes by `id` (primary key); audit-workflow writes by `run_id` via raw SQL — both correct for their contexts.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-11-p7d-cost-economics.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration. REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**2. Inline Execution** — execute tasks in this session using superpowers:executing-plans, batch execution with checkpoints.

**Which approach?**
