# P7-D: Cost Economics — Design Spec

> **Sub-spec D of P7 · Connected & Always-On**
> Sub-specs: A (ASC auth + read client ✅) → B (continuous tracking ✅) → C (measurement windows ✅) → **D (this)**

---

## Goal

Make cost a first-class concern at 5K-user scale. Three levers: route cheap tasks to a cheaper model, skip vision when nothing changed, and wire real token counts into an enforceable per-run budget. Converts the existing advisory dollar cap into a hard pre-flight gate and produces a unit-economics model — average cost per audit, broken down by task.

---

## Architecture overview

```
audit-workflow.ts
  └─ getLlmProvider(tier) — 'fast' for extraction, 'capable' for judgment
  └─ computeScreenshotHash() — compare to last snapshot before firing vision
  └─ CostLedger — accumulates tokens per task, checkBudget() before each call

apps/server/src/cost/
  ledger.ts        — CostLedger class, BudgetExceededError, pricing constants
  gateway.ts       — unchanged (HTTP gateway, not modified in P7-D)

apps/server/src/mastra/
  llm.ts           — getLlmProvider(tier?) updated to accept tier
  workflows/audit-workflow.ts — vision gate + ledger threading + tier assignments

aso_audit_jobs.cost_json   — persisted ledger at run end
GET /api/cost/summary      — unit-economics report from stored cost_json blobs
```

---

## Section 1: Model tiering

### `getLlmProvider(tier)` update

```ts
// apps/server/src/mastra/llm.ts (or wherever getLlmProvider lives)

// Before
function getLlmProvider(): LlmProvider

// After
function getLlmProvider(tier: 'fast' | 'capable' = 'capable'): LlmProvider
```

### New env vars (added to `env.ts`)

| Var | Required | Default | Description |
|-----|----------|---------|-------------|
| `LLM_MODEL` | Yes | existing | Capable tier — judgment calls |
| `LLM_MODEL_FAST` | No | `LLM_MODEL` | Fast tier — extraction/classification. Falls back to `LLM_MODEL` so existing deployments are unaffected |

### Call site tier assignments

| Workflow step | Tier | Reason |
|---------------|------|--------|
| `geminiClassifier()` — identity classification | `fast` | Rule-based signal extraction |
| `analyzeThemes()` — review theme extraction | `fast` | Classification, not judgment |
| `mineCompetitorReviews()` — competitor review mining | `fast` | Extraction task |
| Vision calls B1, B2, B3 | `fast` | Already uses `reasoning_effort: 'none'`; stays on flash |
| `produceAuditDraft()` — final scoring via `asoAuditor` | `capable` | Quality judgment, user-facing output |

No new infrastructure — just adding a `tier` argument to existing `getLlmProvider()` call sites in the workflow. Deployments with only `LLM_MODEL` set fall back cleanly.

---

## Section 2: Vision gate-on-change

### New DB column

Added to `aso_listing_snapshots` via migration in `pg-migrate.ts`:

```sql
ALTER TABLE aso_listing_snapshots ADD COLUMN screenshot_hash TEXT;
```

### Hash computation

New pure function in `apps/server/src/vision/screenshot-hash.ts`:

```ts
import { createHash } from 'node:crypto';

export function computeScreenshotHash(screenshotUrls: string[]): string | null {
  if (!screenshotUrls.length) return null;
  return createHash('sha256')
    .update([...screenshotUrls].sort().join('|'))
    .digest('hex');
}
```

- Sorts URLs before hashing — order changes in the iTunes response don't trigger a false positive.
- Returns `null` when no screenshots — treated as "always run vision" (no baseline to compare against).
- Stored in `aso_listing_snapshots.screenshot_hash` at snapshot write time.

### Gate logic in `score-listing` step

At the start of `score-listing`, before any vision call:

```ts
const lastSnapshot = await storage.getLatestSnapshot(tenantId, appId, country);
const currentHash = computeScreenshotHash(listing.screenshotUrls);

const visionNeeded =
  !lastSnapshot?.screenshotHash ||       // no prior hash — first audit
  lastSnapshot.screenshotHash !== currentHash;  // hash changed
```

If `visionNeeded` is `false`:
- B1, B2, B3 vision steps are **skipped entirely**
- The previous `visionResult` from `lastSnapshot` is copied into the new snapshot row as-is
- `CostLedger` records 0 tokens for `vision`

If `visionNeeded` is `true`: vision runs as normal.

### Expected savings

5 vision calls skipped when screenshots and icon are unchanged. At 5K users with daily re-audits, vision is the dominant cost driver — gating it on change is the single highest-leverage cost reduction.

---

## Section 3: Token accounting — `CostLedger`

### `apps/server/src/cost/ledger.ts`

```ts
import { createHash } from 'node:crypto';

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

// Hardcoded pricing constants — update when provider rates change.
// Gemini Flash and Pro pricing (per 1K tokens, in US cents).
const CENTS_PER_1K: Record<'fast' | 'capable', { prompt: number; completion: number }> = {
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
    this.entries.push({ task, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, estimatedCents });
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

### Wiring into `audit-workflow.ts`

1. Create ledger at run start:
   ```ts
   const ledger = new CostLedger(parseInt(process.env.AUDIT_BUDGET_CENTS ?? '500', 10));
   ```

2. After each LLM call, record usage and check budget:
   ```ts
   const response = await llm.generate(prompt);
   ledger.record('scoring', 'capable', response.usage);
   ledger.checkBudget();
   ```

3. At run end (success or failure), persist ledger to job row:
   ```ts
   await sql`UPDATE aso_audit_jobs SET cost_json = ${JSON.stringify(ledger.toJSON())} WHERE id = ${jobId}`;
   ```

4. `BudgetExceededError` is caught at the workflow top level — job marked `failed`, error message stored in `aso_audit_jobs.error_message`.

### New env var

| Var | Required | Default | Description |
|-----|----------|---------|-------------|
| `AUDIT_BUDGET_CENTS` | No | `500` | Per-run hard budget cap in US cents ($5.00). Replaces the advisory `$5/day` dollar cap with an enforceable per-run limit. |

### New DB column

```sql
ALTER TABLE aso_audit_jobs ADD COLUMN cost_json TEXT;
```

Added to `pg-migrate.ts`. Nullable — rows from before P7-D have `NULL`.

---

## Section 4: Alerting

When `checkBudget()` throws `BudgetExceededError`:

1. **Job error** — `aso_audit_jobs.error_message` stores the human-readable message (`"Budget exceeded: $X.XX spent of $Y.YY limit"`). Visible in the existing `GET /audit/status/:runId` response — no UI changes needed.

2. **Server log** — `console.warn('[cost] budget exceeded', { tenantId, runId, totalCents, limitCents })` — picked up by existing log aggregator.

No new UI components. The existing audit failed state already renders `errorMessage`.

---

## Section 5: Unit economics — `GET /api/cost/summary`

New route registered in `trackingRoutes` or a new `costRoutes` array, added to `apiRoutes` in `mastra/index.ts`.

### Route

```
GET /api/cost/summary
```

Auth: `getAuthenticatedTenantId` (same pattern as all other routes).

### Response type

```ts
type CostSummary = {
  runsLast30Days: number;
  averageCentsPerRun: number;
  totalCentsLast30Days: number;
  breakdown: {
    task: string;
    averageCents: number;
    percentOfTotal: number;
  }[];
};
```

### Implementation

Queries `aso_audit_jobs` where `tenant_id = $1`, `cost_json IS NOT NULL`, and `completed_at > NOW() - INTERVAL '30 days'`. Parses each `cost_json` blob and aggregates:
- `runsLast30Days` — row count
- `averageCentsPerRun` — mean of `totalCents`
- `totalCentsLast30Days` — sum of `totalCents`
- `breakdown` — per-task averages across all runs, sorted by average cost descending

No new table — all data already in `aso_audit_jobs.cost_json`.

---

## Section 6: Testing

| Test | What |
|------|------|
| `cost/ledger.test.ts` | `record()` accumulates tokens correctly; `checkBudget()` throws `BudgetExceededError` when limit exceeded; `checkBudget()` passes when under limit; `toJSON()` serialises breakdown; pricing constants smoke-test (asserts values match documented rates — canary for rate changes) |
| `vision/screenshot-hash.test.ts` | Same URLs in different order produce the same hash; different URL set produces different hash; empty array returns `null`; single URL change produces different hash |
| `mastra/workflows/audit-workflow.test.ts` | Vision steps skipped when `screenshotHash` matches last snapshot; vision steps run when hash differs; `visionResult` from last snapshot copied when vision skipped; `cost_json` written to job row at run end; `BudgetExceededError` marks job as `failed` with correct `errorMessage` |
| `cost/routes.test.ts` | `GET /api/cost/summary` returns correct aggregate over seeded job rows; returns zero summary when no completed runs with `cost_json`; 401 without auth |

All DB tests use real Postgres with unique schema, same pattern as the rest of the codebase.

---

## New migrations (both added to `PG_ONLY_MIGRATIONS` in `pg-migrate.ts`)

```sql
ALTER TABLE aso_listing_snapshots ADD COLUMN screenshot_hash TEXT;
ALTER TABLE aso_audit_jobs        ADD COLUMN cost_json TEXT;
```

---

## New env vars

| Var | Required | Default | Description |
|-----|----------|---------|-------------|
| `LLM_MODEL_FAST` | No | `LLM_MODEL` | Fast tier model for extraction/classification tasks |
| `AUDIT_BUDGET_CENTS` | No | `500` | Per-run hard budget cap in US cents |

---

## What this sub-spec deliberately excludes

- Per-day or per-tenant aggregate budget enforcement (per-run cap is sufficient for P7)
- Real-time cost dashboard UI (unit economics available via `GET /api/cost/summary`; no chart)
- Automatic model fallback (if capable tier is unavailable, fail clearly — no silent downgrade)
- Cost tracking for non-LLM calls (iTunes, ASC, crawler) — metered-call count already handled by governor
- Dynamic pricing updates (constants are hardcoded; update when rates change)
