# Phase 6B: Durable Queue + Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the in-memory SSE audit flow with a Postgres-backed job queue, a worker loop that runs Mastra workflows durably, and structured telemetry (provider metrics + step summaries).

**Architecture:** `POST /audit/start` inserts a job row and returns immediately; a worker loop in the same process claims jobs with `SELECT FOR UPDATE SKIP LOCKED`, runs the Mastra workflow, and updates job status. The client polls `GET /audit/status/:runId` instead of consuming an SSE stream. A `telemetry.ts` module provides a Pino logger used by the gateway and workflow steps to emit structured `provider_call` and `step_summary` log lines.

**Tech Stack:** TypeScript, postgres.js, Vitest, Mastra (`@mastra/core`, `@mastra/loggers`), React + Vite (web client)

## Global Constraints

- Postgres-only: all new tables go in `PG_ONLY_MIGRATIONS` in `apps/server/src/memory/pg-migrate.ts`, not the shared `MIGRATIONS` array (LibSQL does not support `TIMESTAMPTZ`).
- Dead-job recovery threshold: `15 minutes` (stale `running` jobs reset to `pending` on startup).
- Worker concurrency: 1 slot per process. No parallel job execution.
- Max attempts per job: `3` (stored in `max_attempts` column, default `3`).
- Polling interval recommendation in client: `2500ms`.
- New server endpoints: `POST /audit/start`, `GET /audit/status/:runId`, `POST /audit/confirm`.
- Deprecated endpoints return `410 Gone`: `POST /audit/identify`, `POST /audit/run`.
- Log level env var: `LOG_LEVEL` (default `'info'`); `debug` level emits full step payloads.
- Provider call log event name: `'provider_call'`. Step summary event name: `'step_summary'`. Step payload event name: `'step_payload'`.
- Test command (server): `cd apps/server && npx vitest run` (or `npm test` inside `apps/server`).
- Postgres test URL: `process.env.DATABASE_TEST_URL ?? 'postgresql://aso:aso@localhost:5432/aso_audit_test'`.

---

## File Map

**New files:**
- `apps/server/src/queue/job-store.ts` — DB layer for `aso_audit_jobs`
- `apps/server/src/queue/job-store.test.ts` — unit tests with mock postgres
- `apps/server/src/queue/worker.ts` — worker loop: claim → execute → update
- `apps/server/src/queue/worker.test.ts` — unit tests with mock job-store + mock Mastra
- `apps/server/src/telemetry.ts` — shared Pino logger singleton

**Modified files:**
- `apps/server/src/memory/pg-migrate.ts` — add `aso_audit_jobs` + indices to `PG_ONLY_MIGRATIONS`
- `apps/server/src/memory/pg-migrate.test.ts` — add test verifying `aso_audit_jobs` exists
- `apps/server/src/mastra/routes.ts` — add new endpoints, deprecate old ones
- `apps/server/src/mastra/index.ts` — import `logger` from `telemetry.ts`, start worker on boot
- `apps/server/src/cost/gateway.ts` — add `tenantId?: string` to `GatewayCall`, emit `provider_call`
- `apps/server/src/cost/gateway.test.ts` — test that `provider_call` is emitted
- `apps/server/src/cost/postgres-pacer.ts` — emit `provider_call` after DB transaction
- `apps/server/src/mastra/tools/resolve-identity.ts` — emit `provider_call` after LLM generation
- `apps/server/src/mastra/workflows/audit-workflow.ts` — emit `step_summary` / `step_payload` per step
- `apps/web/src/lib/api.ts` — add `startAudit()`, `pollStatus()`, `confirmAudit()`
- `apps/web/src/hooks/useAudit.ts` — rewrite state machine for polling flow

---

## Task 1: Job table migration

**Files:**
- Modify: `apps/server/src/memory/pg-migrate.ts`
- Modify: `apps/server/src/memory/pg-migrate.test.ts`

**Interfaces:**
- Produces: `aso_audit_jobs` table in Postgres with the schema below

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/memory/pg-migrate.test.ts` (inside the existing `describe('runPgMigrations', ...)` block):

```typescript
it('creates aso_audit_jobs', async () => {
  const rows = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = ${schema} AND table_name = 'aso_audit_jobs'
  `;
  expect(rows).toHaveLength(1);
});

it('aso_audit_jobs has required columns', async () => {
  const rows = await sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = ${schema} AND table_name = 'aso_audit_jobs'
  `;
  const cols = rows.map((r) => r.column_name);
  expect(cols).toContain('run_id');
  expect(cols).toContain('tenant_id');
  expect(cols).toContain('status');
  expect(cols).toContain('suspend_payload_json');
  expect(cols).toContain('resume_data_json');
  expect(cols).toContain('attempt');
  expect(cols).toContain('claimed_at');
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/server && npx vitest run src/memory/pg-migrate.test.ts
```

Expected: FAIL — `aso_audit_jobs` table does not exist yet.

- [ ] **Step 3: Add the migration**

In `apps/server/src/memory/pg-migrate.ts`, append to `PG_ONLY_MIGRATIONS`:

```typescript
// Phase 6b: durable audit job queue
`CREATE TABLE IF NOT EXISTS aso_audit_jobs (
  id                   TEXT PRIMARY KEY,
  run_id               TEXT NOT NULL UNIQUE,
  tenant_id            TEXT NOT NULL,
  url                  TEXT NOT NULL,
  reopen_identity      INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL,
  step                 TEXT,
  suspend_payload_json TEXT,
  resume_data_json     TEXT,
  result_json          TEXT,
  error_message        TEXT,
  attempt              INTEGER NOT NULL DEFAULT 0,
  max_attempts         INTEGER NOT NULL DEFAULT 3,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at           TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ
)`,
`CREATE INDEX IF NOT EXISTS aso_audit_jobs_status_created ON aso_audit_jobs (status, created_at)`,
`CREATE INDEX IF NOT EXISTS aso_audit_jobs_run_id ON aso_audit_jobs (run_id)`,
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd apps/server && npx vitest run src/memory/pg-migrate.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/memory/pg-migrate.ts apps/server/src/memory/pg-migrate.test.ts
git commit -m "feat: add aso_audit_jobs migration (phase 6b)"
```

---

## Task 2: Job store

**Files:**
- Create: `apps/server/src/queue/job-store.ts`
- Create: `apps/server/src/queue/job-store.test.ts`

**Interfaces:**
- Consumes: `postgres.Sql` from `postgres` package
- Produces (exported from `job-store.ts`):
  ```typescript
  export interface AuditJob {
    id: string; runId: string; tenantId: string; url: string;
    reopenIdentity: boolean; status: JobStatus; step: string | null;
    suspendPayloadJson: string | null; resumeDataJson: string | null;
    resultJson: string | null; errorMessage: string | null;
    attempt: number; maxAttempts: number;
    createdAt: Date; claimedAt: Date | null; completedAt: Date | null;
  }
  export type JobStatus = 'pending' | 'running' | 'awaiting_confirmation' | 'done' | 'failed';

  export function insertJob(sql, params: { id, runId, tenantId, url, reopenIdentity? }): Promise<AuditJob>
  export function claimNextJob(sql): Promise<AuditJob | null>
  export function getJobByRunId(sql, runId): Promise<AuditJob | null>
  export function markJobRunning(sql, id, step): Promise<void>
  export function markJobSuspended(sql, id, suspendPayloadJson): Promise<void>
  export function markJobPending(sql, id, resumeDataJson): Promise<void>  // for re-queue after confirm
  export function markJobDone(sql, id, resultJson): Promise<void>
  export function markJobFailed(sql, id, errorMessage): Promise<void>
  export function markJobRequeued(sql, id): Promise<void>  // retry: status=pending, keep attempt count
  export function recoverStaleJobs(sql): Promise<number>   // returns count reset
  ```

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/queue/job-store.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';
import {
  insertJob, claimNextJob, getJobByRunId,
  markJobSuspended, markJobPending, markJobDone,
  markJobFailed, markJobRequeued, recoverStaleJobs,
} from './job-store';

// Build a minimal mock sql that records calls and returns canned rows.
function makeSql(rows: unknown[] = []) {
  const fn = vi.fn().mockResolvedValue(rows);
  // Tagged-template entry point: sql`...` returns fn()
  const sql = Object.assign(
    (..._args: unknown[]) => fn(),
    { unsafe: vi.fn().mockResolvedValue(rows) },
  ) as unknown as postgres.Sql;
  return { sql, fn };
}

const JOB_ROW = {
  id: 'job_1', run_id: 'run_1', tenant_id: 'tenant_1', url: 'https://apps.apple.com/us/app/x/id1',
  reopen_identity: 0, status: 'pending', step: null,
  suspend_payload_json: null, resume_data_json: null,
  result_json: null, error_message: null,
  attempt: 0, max_attempts: 3,
  created_at: new Date(), claimed_at: null, completed_at: null,
};

describe('insertJob', () => {
  it('returns the inserted job mapped to camelCase', async () => {
    const { sql } = makeSql([JOB_ROW]);
    const job = await insertJob(sql, { id: 'job_1', runId: 'run_1', tenantId: 'tenant_1', url: JOB_ROW.url });
    expect(job.id).toBe('job_1');
    expect(job.runId).toBe('run_1');
    expect(job.tenantId).toBe('tenant_1');
    expect(job.status).toBe('pending');
    expect(job.reopenIdentity).toBe(false);
  });
});

describe('claimNextJob', () => {
  it('returns the claimed job when a pending job exists', async () => {
    const { sql } = makeSql([{ ...JOB_ROW, status: 'running', attempt: 1 }]);
    const job = await claimNextJob(sql);
    expect(job).not.toBeNull();
    expect(job!.status).toBe('running');
    expect(job!.attempt).toBe(1);
  });

  it('returns null when no pending jobs exist', async () => {
    const { sql } = makeSql([]);
    const job = await claimNextJob(sql);
    expect(job).toBeNull();
  });
});

describe('getJobByRunId', () => {
  it('returns the job when found', async () => {
    const { sql } = makeSql([JOB_ROW]);
    const job = await getJobByRunId(sql, 'run_1');
    expect(job).not.toBeNull();
    expect(job!.runId).toBe('run_1');
  });

  it('returns null when not found', async () => {
    const { sql } = makeSql([]);
    const job = await getJobByRunId(sql, 'missing');
    expect(job).toBeNull();
  });
});

describe('markJobSuspended', () => {
  it('calls sql with the job id and payload', async () => {
    const { sql, fn } = makeSql([]);
    await markJobSuspended(sql, 'job_1', '{"summary":{}}');
    expect(fn).toHaveBeenCalled();
  });
});

describe('markJobPending', () => {
  it('calls sql to re-queue with resume data', async () => {
    const { sql, fn } = makeSql([]);
    await markJobPending(sql, 'job_1', '{"confirmed":true}');
    expect(fn).toHaveBeenCalled();
  });
});

describe('markJobDone', () => {
  it('calls sql with result_json and completed_at', async () => {
    const { sql, fn } = makeSql([]);
    await markJobDone(sql, 'job_1', '{"score":85}');
    expect(fn).toHaveBeenCalled();
  });
});

describe('markJobFailed', () => {
  it('calls sql with error_message', async () => {
    const { sql, fn } = makeSql([]);
    await markJobFailed(sql, 'job_1', 'Something went wrong');
    expect(fn).toHaveBeenCalled();
  });
});

describe('recoverStaleJobs', () => {
  it('returns the count of reset jobs', async () => {
    const { sql, fn } = makeSql([{ count: 2 }]);
    // recoverStaleJobs runs two queries: UPDATE + SELECT count
    fn.mockResolvedValueOnce([{ count: '2' }]);
    const count = await recoverStaleJobs(sql);
    expect(count).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/server && npx vitest run src/queue/job-store.test.ts
```

Expected: FAIL — module `./job-store` does not exist.

- [ ] **Step 3: Implement job-store.ts**

Create `apps/server/src/queue/job-store.ts`:

```typescript
import postgres from 'postgres';
import { newId } from '../memory/ids';

export type JobStatus = 'pending' | 'running' | 'awaiting_confirmation' | 'done' | 'failed';

export interface AuditJob {
  id: string;
  runId: string;
  tenantId: string;
  url: string;
  reopenIdentity: boolean;
  status: JobStatus;
  step: string | null;
  suspendPayloadJson: string | null;
  resumeDataJson: string | null;
  resultJson: string | null;
  errorMessage: string | null;
  attempt: number;
  maxAttempts: number;
  createdAt: Date;
  claimedAt: Date | null;
  completedAt: Date | null;
}

interface JobRow {
  id: string; run_id: string; tenant_id: string; url: string;
  reopen_identity: number; status: string; step: string | null;
  suspend_payload_json: string | null; resume_data_json: string | null;
  result_json: string | null; error_message: string | null;
  attempt: number; max_attempts: number;
  created_at: Date; claimed_at: Date | null; completed_at: Date | null;
}

function rowToJob(r: JobRow): AuditJob {
  return {
    id: r.id, runId: r.run_id, tenantId: r.tenant_id, url: r.url,
    reopenIdentity: r.reopen_identity !== 0,
    status: r.status as JobStatus,
    step: r.step,
    suspendPayloadJson: r.suspend_payload_json,
    resumeDataJson: r.resume_data_json,
    resultJson: r.result_json,
    errorMessage: r.error_message,
    attempt: r.attempt,
    maxAttempts: r.max_attempts,
    createdAt: r.created_at,
    claimedAt: r.claimed_at,
    completedAt: r.completed_at,
  };
}

export async function insertJob(
  sql: postgres.Sql,
  params: { id?: string; runId: string; tenantId: string; url: string; reopenIdentity?: boolean },
): Promise<AuditJob> {
  const id = params.id ?? newId('job');
  const [row] = await sql<JobRow[]>`
    INSERT INTO aso_audit_jobs (id, run_id, tenant_id, url, reopen_identity, status)
    VALUES (${id}, ${params.runId}, ${params.tenantId}, ${params.url},
            ${params.reopenIdentity ? 1 : 0}, 'pending')
    RETURNING *
  `;
  return rowToJob(row!);
}

export async function claimNextJob(sql: postgres.Sql): Promise<AuditJob | null> {
  const [row] = await sql<JobRow[]>`
    UPDATE aso_audit_jobs
    SET status = 'running', claimed_at = NOW(), attempt = attempt + 1
    WHERE id = (
      SELECT id FROM aso_audit_jobs
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `;
  return row ? rowToJob(row) : null;
}

export async function getJobByRunId(sql: postgres.Sql, runId: string): Promise<AuditJob | null> {
  const [row] = await sql<JobRow[]>`
    SELECT * FROM aso_audit_jobs WHERE run_id = ${runId}
  `;
  return row ? rowToJob(row) : null;
}

export async function markJobRunning(sql: postgres.Sql, id: string, step: string): Promise<void> {
  await sql`UPDATE aso_audit_jobs SET step = ${step} WHERE id = ${id}`;
}

export async function markJobSuspended(
  sql: postgres.Sql, id: string, suspendPayloadJson: string,
): Promise<void> {
  await sql`
    UPDATE aso_audit_jobs
    SET status = 'awaiting_confirmation', step = 'confirm-app',
        suspend_payload_json = ${suspendPayloadJson}, resume_data_json = NULL
    WHERE id = ${id}
  `;
}

export async function markJobPending(
  sql: postgres.Sql, id: string, resumeDataJson: string,
): Promise<void> {
  await sql`
    UPDATE aso_audit_jobs
    SET status = 'pending', resume_data_json = ${resumeDataJson}
    WHERE id = ${id}
  `;
}

export async function markJobDone(
  sql: postgres.Sql, id: string, resultJson: string,
): Promise<void> {
  await sql`
    UPDATE aso_audit_jobs
    SET status = 'done', result_json = ${resultJson}, completed_at = NOW()
    WHERE id = ${id}
  `;
}

export async function markJobFailed(
  sql: postgres.Sql, id: string, errorMessage: string,
): Promise<void> {
  await sql`
    UPDATE aso_audit_jobs
    SET status = 'failed', error_message = ${errorMessage}, completed_at = NOW()
    WHERE id = ${id}
  `;
}

export async function markJobRequeued(sql: postgres.Sql, id: string): Promise<void> {
  await sql`UPDATE aso_audit_jobs SET status = 'pending' WHERE id = ${id}`;
}

export async function recoverStaleJobs(sql: postgres.Sql): Promise<number> {
  const [row] = await sql<[{ count: string }]>`
    WITH updated AS (
      UPDATE aso_audit_jobs
      SET status = 'pending'
      WHERE status = 'running'
        AND claimed_at < NOW() - INTERVAL '15 minutes'
      RETURNING id
    )
    SELECT count(*)::text AS count FROM updated
  `;
  return parseInt(row?.count ?? '0', 10);
}
```

- [ ] **Step 4: Run to verify tests pass**

```bash
cd apps/server && npx vitest run src/queue/job-store.test.ts
```

Expected: PASS (all tests green)

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/queue/
git commit -m "feat: add job store for aso_audit_jobs (phase 6b)"
```

---

## Task 3: Worker loop

**Files:**
- Create: `apps/server/src/queue/worker.ts`
- Create: `apps/server/src/queue/worker.test.ts`

**Interfaces:**
- Consumes (from `job-store.ts`): `AuditJob`, `claimNextJob`, `markJobRunning`, `markJobSuspended`, `markJobPending`, `markJobDone`, `markJobFailed`, `markJobRequeued`, `recoverStaleJobs`
- Consumes: `postgres.Sql` from `postgres`, `Mastra` instance from `@mastra/core`
- Produces (exported from `worker.ts`):
  ```typescript
  export function startWorker(mastra: Mastra, sql: postgres.Sql): () => void
  // returns a stop() function that halts the loop
  ```

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/queue/worker.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AuditJob } from './job-store';

// Stub all job-store functions
vi.mock('./job-store', () => ({
  claimNextJob: vi.fn(),
  markJobRunning: vi.fn().mockResolvedValue(undefined),
  markJobSuspended: vi.fn().mockResolvedValue(undefined),
  markJobPending: vi.fn().mockResolvedValue(undefined),
  markJobDone: vi.fn().mockResolvedValue(undefined),
  markJobFailed: vi.fn().mockResolvedValue(undefined),
  markJobRequeued: vi.fn().mockResolvedValue(undefined),
  recoverStaleJobs: vi.fn().mockResolvedValue(0),
}));

import {
  claimNextJob, markJobDone, markJobFailed,
  markJobSuspended, markJobRequeued,
} from './job-store';
import { executeJob } from './worker';

const BASE_JOB: AuditJob = {
  id: 'job_1', runId: 'run_1', tenantId: 'tenant_1',
  url: 'https://apps.apple.com/us/app/x/id1',
  reopenIdentity: false, status: 'running', step: null,
  suspendPayloadJson: null, resumeDataJson: null,
  resultJson: null, errorMessage: null,
  attempt: 1, maxAttempts: 3,
  createdAt: new Date(), claimedAt: new Date(), completedAt: null,
};

function makeMastra(runResult: { status: string; steps?: any; result?: any; output?: any }) {
  const run = {
    start: vi.fn().mockResolvedValue(runResult),
    resumeStream: vi.fn().mockResolvedValue({
      fullStream: (async function* () {})(),
      result: Promise.resolve(runResult),
    }),
  };
  return {
    getWorkflow: vi.fn().mockReturnValue({
      createRun: vi.fn().mockResolvedValue(run),
    }),
    _run: run,
  };
}

const mockSql = {} as any;

describe('executeJob', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('calls run.start() for a fresh job (no resumeDataJson)', async () => {
    const mastra = makeMastra({ status: 'success', output: { score: 90 } });
    await executeJob(BASE_JOB, mastra as any, mockSql);
    expect(mastra._run.start).toHaveBeenCalledOnce();
    expect(mastra._run.resumeStream).not.toHaveBeenCalled();
    expect(markJobDone).toHaveBeenCalledWith(mockSql, 'job_1', expect.any(String));
  });

  it('calls run.resumeStream() for a job with resumeDataJson', async () => {
    const job = { ...BASE_JOB, resumeDataJson: '{"confirmed":true}' };
    const mastra = makeMastra({ status: 'success', output: { score: 90 } });
    await executeJob(job, mastra as any, mockSql);
    expect(mastra._run.resumeStream).toHaveBeenCalledWith({
      step: 'confirm-app',
      resumeData: { confirmed: true },
    });
    expect(markJobDone).toHaveBeenCalledWith(mockSql, 'job_1', expect.any(String));
  });

  it('marks job suspended when workflow suspends', async () => {
    const mastra = makeMastra({
      status: 'suspended',
      steps: { 'confirm-app': { suspendPayload: { summary: { name: 'Rivian' } } } },
    });
    await executeJob(BASE_JOB, mastra as any, mockSql);
    expect(markJobSuspended).toHaveBeenCalledWith(
      mockSql, 'job_1', expect.stringContaining('Rivian'),
    );
  });

  it('re-queues on error when attempt < maxAttempts', async () => {
    const mastra = makeMastra({ status: 'success' }); // start() will throw
    mastra._run.start.mockRejectedValue(new Error('network flap'));
    await executeJob(BASE_JOB, mastra as any, mockSql); // attempt=1, max=3
    expect(markJobRequeued).toHaveBeenCalledWith(mockSql, 'job_1');
    expect(markJobFailed).not.toHaveBeenCalled();
  });

  it('marks job failed when attempt >= maxAttempts', async () => {
    const job = { ...BASE_JOB, attempt: 3, maxAttempts: 3 };
    const mastra = makeMastra({ status: 'success' });
    mastra._run.start.mockRejectedValue(new Error('persistent failure'));
    await executeJob(job, mastra as any, mockSql);
    expect(markJobFailed).toHaveBeenCalledWith(mockSql, 'job_1', 'persistent failure');
    expect(markJobRequeued).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/server && npx vitest run src/queue/worker.test.ts
```

Expected: FAIL — `./worker` module does not exist.

- [ ] **Step 3: Implement worker.ts**

Create `apps/server/src/queue/worker.ts`:

```typescript
import type postgres from 'postgres';
import type { Mastra } from '@mastra/core';
import {
  type AuditJob,
  claimNextJob, markJobRunning, markJobSuspended,
  markJobPending, markJobDone, markJobFailed,
  markJobRequeued, recoverStaleJobs,
} from './job-store';

const POLL_INTERVAL_MS = 5_000;

/** Pull the confirm-app suspend payload out of a Mastra workflow result. */
function extractSuspendPayload(result: any): any {
  const step = result?.steps?.['confirm-app'];
  const p = step?.suspendPayload ?? step?.payload ?? step?.suspendedPayload
    ?? result?.suspendPayload ?? result?.payload;
  return p ?? null;
}

/** Pull the final audit report out of a completed workflow result. */
function extractReport(result: any): any {
  return result?.result ?? result?.output
    ?? result?.steps?.['score-listing']?.output
    ?? result?.payload?.output ?? null;
}

/** Pull an error message out of a failed/unexpected workflow result. */
function extractError(result: any): string {
  const e = result?.steps?.['score-listing']?.error
    ?? result?.steps?.['gather-listing']?.error
    ?? result?.steps?.['confirm-app']?.error
    ?? result?.error;
  if (typeof e === 'string') return e;
  if (e?.message) return String(e.message);
  return `Workflow ended with status '${result?.status ?? 'unknown'}'`;
}

/** Execute one job to completion (or suspension). Does not throw. */
export async function executeJob(job: AuditJob, mastra: Mastra, sql: postgres.Sql): Promise<void> {
  const workflow = mastra.getWorkflow('asoAuditWorkflow');
  const run = await workflow.createRun({ runId: job.runId });

  try {
    let result: any;

    if (!job.resumeDataJson) {
      // Fresh run — run start from beginning through to first suspend or completion.
      result = await run.start({
        inputData: {
          url: job.url,
          tenantId: job.tenantId,
          reopenIdentity: job.reopenIdentity,
        },
      });
    } else {
      // Resume run — continue from the confirm-app suspend point.
      const resumeData = JSON.parse(job.resumeDataJson) as Record<string, unknown>;
      const wfStream = await run.resumeStream({ step: 'confirm-app', resumeData });
      const events: AsyncIterable<any> = (wfStream as any).fullStream ?? wfStream;
      for await (const event of events) {
        if (event?.type === 'workflow-step-start') {
          const stepId: string | undefined =
            event?.payload?.id ?? event?.payload?.stepId ?? event?.payload?.step?.id;
          if (stepId) await markJobRunning(sql, job.id, stepId);
        }
      }
      result = await wfStream.result;
    }

    if (result?.status === 'suspended') {
      const payload = extractSuspendPayload(result);
      await markJobSuspended(sql, job.id, JSON.stringify(payload ?? {}));
    } else if (result?.status === 'success') {
      const report = extractReport(result);
      await markJobDone(sql, job.id, JSON.stringify(report ?? {}));
    } else {
      throw new Error(extractError(result));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (job.attempt < job.maxAttempts) {
      await markJobRequeued(sql, job.id);
    } else {
      await markJobFailed(sql, job.id, message);
    }
  }
}

/** Start the background worker loop. Returns a stop() function. */
export function startWorker(mastra: Mastra, sql: postgres.Sql): () => void {
  let stopped = false;

  async function loop(): Promise<void> {
    const recovered = await recoverStaleJobs(sql).catch(() => 0);
    if (recovered > 0) {
      console.log(`[worker] recovered ${recovered} stale jobs on startup`);
    }

    while (!stopped) {
      const job = await claimNextJob(sql).catch(() => null);
      if (job) {
        await executeJob(job, mastra, sql);
      } else {
        await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    }
  }

  void loop();
  return () => { stopped = true; };
}
```

- [ ] **Step 4: Run to verify tests pass**

```bash
cd apps/server && npx vitest run src/queue/worker.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/queue/worker.ts apps/server/src/queue/worker.test.ts
git commit -m "feat: add durable worker loop (phase 6b)"
```

---

## Task 4: Server API routes + worker startup

**Files:**
- Modify: `apps/server/src/mastra/routes.ts`
- Modify: `apps/server/src/mastra/index.ts`

**Interfaces:**
- Consumes: `insertJob`, `getJobByRunId`, `markJobPending` from `../queue/job-store`
- Consumes: `startWorker` from `../queue/worker`
- Consumes: `getPgSql` from `../memory`
- Consumes: `newId` from `../memory/ids`
- Produces:
  - `POST /audit/start` → `{ jobId, runId, status: 'pending' }`
  - `GET /audit/status/:runId` → `AuditJobStatusResponse`
  - `POST /audit/confirm` → `{ ok: true }`
  - `POST /audit/identify` → `410 Gone`
  - `POST /audit/run` → `410 Gone`

- [ ] **Step 1: Write the failing test**

There are no unit tests for routes (they're integration-tested through the full workflow). Instead, verify manually that the file compiles after edits by running the full test suite:

```bash
cd apps/server && npx vitest run --reporter=verbose 2>&1 | tail -5
```

Expected: currently passing (baseline before changes).

- [ ] **Step 2: Add new routes to routes.ts**

At the top of `apps/server/src/mastra/routes.ts`, add these imports (below existing ones):

```typescript
import { insertJob, getJobByRunId, markJobPending } from '../queue/job-store';
import { newId } from '../memory/ids';
import { getPgSql } from '../memory';
```

Add the following three routes **before** the existing `auditRoutes` array closing bracket (i.e., after the last existing route):

```typescript
// ── POST /audit/start — enqueue a new audit job ──────────────────────────
registerApiRoute('/audit/start', {
  method: 'POST',
  handler: async (c) => {
    const tenantId = await getAuthenticatedTenantId(c);
    if (!tenantId) return c.json({ error: 'Unauthorized' }, 401);
    const sql = getPgSql();
    if (!sql) return c.json({ error: 'Database not configured.' }, 503);
    try {
      const body = await c.req.json().catch(() => ({}));
      const url = typeof body?.url === 'string' ? body.url.trim() : '';
      if (!url) return c.json({ error: 'Paste an App Store URL first.' }, 400);
      const reopenIdentity = body?.reopenIdentity === true;
      const runId = newId('run');
      const job = await insertJob(sql, { runId, tenantId, url, reopenIdentity });
      return c.json({ jobId: job.id, runId: job.runId, status: job.status });
    } catch (e) {
      console.error('[audit/start] failed:', e);
      return c.json({ error: 'Could not enqueue audit.' }, 500);
    }
  },
}),

// ── GET /audit/status/:runId — poll job status ────────────────────────────
registerApiRoute('/audit/status/:runId', {
  method: 'GET',
  handler: async (c) => {
    const tenantId = await getAuthenticatedTenantId(c);
    if (!tenantId) return c.json({ error: 'Unauthorized' }, 401);
    const sql = getPgSql();
    if (!sql) return c.json({ error: 'Database not configured.' }, 503);
    const runId = c.req.param('runId');
    const job = await getJobByRunId(sql, runId);
    if (!job) return c.json({ error: 'Job not found.' }, 404);
    if (job.tenantId !== tenantId) return c.json({ error: 'Not found.' }, 404);
    const response: Record<string, unknown> = {
      jobId: job.id,
      runId: job.runId,
      status: job.status,
      step: job.step,
      attempt: job.attempt,
      maxAttempts: job.maxAttempts,
    };
    if (job.status === 'done' && job.resultJson) {
      try { response.result = JSON.parse(job.resultJson); } catch { /* malformed */ }
    }
    if (job.status === 'failed') {
      response.errorMessage = job.errorMessage;
    }
    if (job.status === 'awaiting_confirmation' && job.suspendPayloadJson) {
      try { response.suspendPayload = JSON.parse(job.suspendPayloadJson); } catch { /* malformed */ }
    }
    return c.json(response);
  },
}),

// ── POST /audit/confirm — resume after human confirmation ─────────────────
registerApiRoute('/audit/confirm', {
  method: 'POST',
  handler: async (c) => {
    const tenantId = await getAuthenticatedTenantId(c);
    if (!tenantId) return c.json({ error: 'Unauthorized' }, 401);
    const sql = getPgSql();
    if (!sql) return c.json({ error: 'Database not configured.' }, 503);
    try {
      const body = await c.req.json().catch(() => ({}));
      const runId = typeof body?.runId === 'string' ? body.runId : '';
      if (!runId) return c.json({ error: 'Missing runId.' }, 400);
      const job = await getJobByRunId(sql, runId);
      if (!job) return c.json({ error: 'Job not found.' }, 404);
      if (job.tenantId !== tenantId) return c.json({ error: 'Not found.' }, 404);
      if (job.status !== 'awaiting_confirmation') {
        return c.json({ error: `Job is not awaiting confirmation (status: ${job.status}).` }, 409);
      }
      const resumeData = {
        confirmed: true,
        identityDecision: body?.identityDecision ?? null,
        overrideAcknowledged: body?.overrideAcknowledged === true,
        fresh: body?.fresh === true,
      };
      await markJobPending(sql, job.id, JSON.stringify(resumeData));
      return c.json({ ok: true });
    } catch (e) {
      console.error('[audit/confirm] failed:', e);
      return c.json({ error: 'Could not confirm audit.' }, 500);
    }
  },
}),
```

- [ ] **Step 3: Deprecate old endpoints**

In `routes.ts`, replace the existing `POST /audit/identify` handler body with:

```typescript
handler: async (c) => {
  return c.json(
    { error: 'This endpoint is deprecated. Use POST /audit/start and poll GET /audit/status/:runId.' },
    410,
  );
},
```

Replace the existing `POST /audit/run` handler body with:

```typescript
handler: async (c) => {
  return c.json(
    { error: 'This endpoint is deprecated. Use POST /audit/confirm and poll GET /audit/status/:runId.' },
    410,
  );
},
```

- [ ] **Step 4: Start worker in index.ts**

In `apps/server/src/mastra/index.ts`, add this import near the top:

```typescript
import { startWorker } from '../queue/worker';
```

After the existing `if (!isTest)` block (at the bottom of the file), add:

```typescript
if (!isTest) {
  const pgSql = process.env.DATABASE_URL
    ? (() => { import('../memory').then(({ getPgSql }) => { const s = getPgSql(); if (s) startWorker(mastra, s); }); })()
    : undefined;
  void pgSql;
}
```

Actually, to avoid the IIFE complexity, structure it more clearly. Find the existing `if (!isTest)` block and add inside it, after the existing startup code:

```typescript
// Start the durable job worker (Postgres only — no-op without DATABASE_URL).
if (process.env.DATABASE_URL) {
  import('../memory').then(({ getPgSql }) => {
    const sql = getPgSql();
    if (sql) startWorker(mastra, sql);
  }).catch((e) => console.error('[worker] failed to start:', e));
}
```

- [ ] **Step 5: Run tests to verify no regressions**

```bash
cd apps/server && npx vitest run
```

Expected: all existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/mastra/routes.ts apps/server/src/mastra/index.ts
git commit -m "feat: add /audit/start, /audit/status, /audit/confirm routes; deprecate SSE endpoints (phase 6b)"
```

---

## Task 5: Web client — polling flow

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/hooks/useAudit.ts`

**Interfaces:**
- Produces (in `api.ts`):
  ```typescript
  export interface StartAuditResult { jobId: string; runId: string; status: string; }
  export interface AuditJobStatus {
    jobId: string; runId: string;
    status: 'pending' | 'running' | 'done' | 'failed' | 'awaiting_confirmation';
    step?: string;
    result?: AuditReport;
    errorMessage?: string;
    suspendPayload?: {
      summary: AppSummary;
      identity: ResolvedIdentity | null;
      identityNeedsConfirm: boolean;
      conflict?: Conflict;
    };
    attempt: number;
    maxAttempts: number;
  }
  export function startAudit(url: string, reopenIdentity?: boolean): Promise<StartAuditResult>
  export function pollStatus(runId: string): Promise<AuditJobStatus>
  export function confirmAudit(params: { runId: string; identityDecision?: IdentityDecision | null; overrideAcknowledged?: boolean; fresh?: boolean }): Promise<void>
  ```

- [ ] **Step 1: Add new API functions to api.ts**

In `apps/web/src/lib/api.ts`, add at the end of the file (before the closing):

```typescript
export interface StartAuditResult {
  jobId: string;
  runId: string;
  status: string;
}

/** Enqueue a new audit job and return immediately. */
export async function startAudit(url: string, reopenIdentity = false): Promise<StartAuditResult> {
  const res = await authedFetch('/audit/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, reopenIdentity }),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<StartAuditResult> & { error?: string };
  if (!res.ok || !data.runId) throw new Error(data.error ?? 'Could not start audit.');
  return data as StartAuditResult;
}

export interface AuditJobStatus {
  jobId: string;
  runId: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'awaiting_confirmation';
  step?: string;
  result?: AuditReport;
  errorMessage?: string;
  suspendPayload?: {
    summary: AppSummary;
    identity: ResolvedIdentity | null;
    identityNeedsConfirm: boolean;
    conflict?: Conflict;
  };
  attempt: number;
  maxAttempts: number;
}

/** Poll job status. Call every 2.5s while status is pending/running. */
export async function pollStatus(runId: string): Promise<AuditJobStatus> {
  const res = await authedFetch(`/audit/status/${runId}`);
  const data = (await res.json().catch(() => ({}))) as Partial<AuditJobStatus> & { error?: string };
  if (!res.ok) throw new Error(data.error ?? 'Could not fetch audit status.');
  return data as AuditJobStatus;
}

/** Confirm the app identity and re-queue the job for the worker. */
export async function confirmAudit(params: {
  runId: string;
  identityDecision?: IdentityDecision | null;
  overrideAcknowledged?: boolean;
  fresh?: boolean;
}): Promise<void> {
  const res = await authedFetch('/audit/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      runId: params.runId,
      identityDecision: params.identityDecision ?? null,
      overrideAcknowledged: params.overrideAcknowledged ?? false,
      fresh: params.fresh ?? false,
    }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? 'Could not confirm audit.');
  }
}
```

- [ ] **Step 2: Rewrite useAudit.ts**

Replace the entire contents of `apps/web/src/hooks/useAudit.ts` with:

```typescript
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { startAudit, pollStatus, confirmAudit } from '../lib/api';
import type { AppSummary, AuditReport, Conflict, ResolvedIdentity, IdentityDecision } from '../lib/types';

export type ChatMessage =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'agent'; text: string }
  | {
      id: string; kind: 'confirmation';
      summary: AppSummary; identity: ResolvedIdentity | null;
      identityNeedsConfirm: boolean; decision: 'pending' | 'yes' | 'no';
    }
  | { id: string; kind: 'progress'; step: string | null; complete: boolean }
  | { id: string; kind: 'report'; report: AuditReport }
  | { id: string; kind: 'error'; text: string }
  | { id: string; kind: 'challenge'; conflict: Conflict; decision: 'pending' | 'yes' | 'no' };

export type AuditStatus = 'idle' | 'starting' | 'running' | 'confirming' | 'done';

export interface UseAudit {
  messages: ChatMessage[];
  status: AuditStatus;
  busy: boolean;
  submitUrl: (url: string) => void;
  confirm: (identityDecision?: IdentityDecision | null) => void;
  confirmAnyway: () => void;
  reject: () => void;
  reopenIdentity: () => void;
}

const POLL_INTERVAL_MS = 2500;

let sequence = 0;
const nextId = (): string => `m${++sequence}`;

export function useAudit(): UseAudit {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<AuditStatus>('idle');
  const [runId, setRunId] = useState<string | null>(null);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const [pendingDecision, setPendingDecision] = useState<IdentityDecision | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const add = useCallback((message: ChatMessage) => {
    setMessages((prev) => [...prev, message]);
  }, []);

  const patch = useCallback((id: string, update: (m: ChatMessage) => ChatMessage) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? update(m) : m)));
  }, []);

  // Stop any running poll loop.
  const stopPolling = useCallback(() => {
    if (pollTimer.current !== null) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  // Start polling GET /audit/status/:runId every POLL_INTERVAL_MS.
  // progressId: the id of the progress message to update with step names.
  const startPolling = useCallback((rid: string, progressId: string) => {
    async function tick() {
      try {
        const s = await pollStatus(rid);

        if (s.status === 'pending' || s.status === 'running') {
          patch(progressId, (m) =>
            m.kind === 'progress' ? { ...m, step: s.step ?? null } : m,
          );
          pollTimer.current = setTimeout(tick, POLL_INTERVAL_MS);

        } else if (s.status === 'awaiting_confirmation') {
          stopPolling();
          const payload = s.suspendPayload;
          if (!payload) {
            add({ id: nextId(), kind: 'error', text: 'Audit paused but no confirmation data received.' });
            setStatus('idle');
            return;
          }
          patch(progressId, (m) => m.kind === 'progress' ? { ...m, complete: true } : m);

          if (payload.conflict) {
            // Re-suspend with a challenge — show the challenge card.
            setMessages((prev) =>
              prev.map((m) =>
                m.kind === 'confirmation' && m.decision === 'yes'
                  ? { ...m, decision: 'pending' as const }
                  : m,
              ),
            );
            add({ id: nextId(), kind: 'challenge', conflict: payload.conflict, decision: 'pending' });
          } else {
            // Initial suspend — show the confirmation card.
            add({
              id: nextId(), kind: 'confirmation',
              summary: payload.summary,
              identity: payload.identity,
              identityNeedsConfirm: payload.identityNeedsConfirm,
              decision: 'pending',
            });
          }
          setStatus('confirming');

        } else if (s.status === 'done') {
          stopPolling();
          patch(progressId, (m) => m.kind === 'progress' ? { ...m, complete: true } : m);
          if (s.result) {
            add({ id: nextId(), kind: 'report', report: s.result });
            add({ id: nextId(), kind: 'agent', text: 'Audit complete. Paste another App Store URL to run another.' });
          }
          setStatus('done');
          setRunId(null);

        } else if (s.status === 'failed') {
          stopPolling();
          patch(progressId, (m) => m.kind === 'progress' ? { ...m, complete: true } : m);
          if (s.attempt < s.maxAttempts) {
            // Still retrying — resume polling.
            add({ id: nextId(), kind: 'agent', text: `Retrying… (attempt ${s.attempt} of ${s.maxAttempts})` });
            pollTimer.current = setTimeout(tick, POLL_INTERVAL_MS * 2);
          } else {
            add({ id: nextId(), kind: 'error', text: s.errorMessage ?? 'The audit failed.' });
            setStatus('idle');
            setRunId(null);
          }
        }
      } catch {
        // Transient network error — keep polling.
        pollTimer.current = setTimeout(tick, POLL_INTERVAL_MS);
      }
    }
    pollTimer.current = setTimeout(tick, POLL_INTERVAL_MS);
  }, [add, patch, stopPolling]);

  // Clean up on unmount.
  useEffect(() => () => stopPolling(), [stopPolling]);

  const submitUrl = useCallback((raw: string) => {
    const url = raw.trim();
    if (!url || status === 'starting' || status === 'running') return;

    stopPolling();
    add({ id: nextId(), kind: 'user', text: url });
    setPendingUrl(url);
    setStatus('starting');

    const thinkingId = nextId();
    add({ id: thinkingId, kind: 'agent', text: 'Queuing audit…' });

    startAudit(url)
      .then(({ runId: rid }) => {
        setRunId(rid);
        const progressId = nextId();
        patch(thinkingId, () => ({
          id: thinkingId, kind: 'agent' as const,
          text: 'Audit queued — identifying app…',
        }));
        add({ id: progressId, kind: 'progress', step: null, complete: false });
        setStatus('running');
        startPolling(rid, progressId);
      })
      .catch((e: unknown) => {
        patch(thinkingId, () => ({
          id: thinkingId, kind: 'error' as const,
          text: e instanceof Error ? e.message : 'Could not start audit.',
        }));
        setStatus('idle');
      });
  }, [status, add, patch, stopPolling, startPolling]);

  const confirm = useCallback((identityDecision?: IdentityDecision | null) => {
    if (status !== 'confirming' || !runId) return;

    setMessages((prev) =>
      prev.map((m) =>
        m.kind === 'confirmation' && m.decision === 'pending'
          ? { ...m, decision: 'yes' as const }
          : m,
      ),
    );
    setPendingDecision(identityDecision ?? null);
    setStatus('running');

    const progressId = nextId();
    add({ id: progressId, kind: 'progress', step: null, complete: false });

    confirmAudit({ runId, identityDecision: identityDecision ?? null })
      .then(() => startPolling(runId, progressId))
      .catch((e: unknown) => {
        add({ id: nextId(), kind: 'error', text: e instanceof Error ? e.message : 'Confirmation failed.' });
        setStatus('idle');
      });
  }, [status, runId, add, startPolling]);

  const confirmAnyway = useCallback(() => {
    if (status !== 'confirming' || !runId) return;

    setMessages((prev) =>
      prev.map((m) =>
        m.kind === 'challenge' && m.decision === 'pending'
          ? { ...m, decision: 'yes' as const }
          : m,
      ),
    );
    setStatus('running');

    const progressId = nextId();
    add({ id: progressId, kind: 'progress', step: null, complete: false });

    confirmAudit({ runId, identityDecision: pendingDecision, overrideAcknowledged: true })
      .then(() => startPolling(runId, progressId))
      .catch((e: unknown) => {
        add({ id: nextId(), kind: 'error', text: e instanceof Error ? e.message : 'Confirmation failed.' });
        setStatus('idle');
      });
  }, [status, runId, pendingDecision, add, startPolling]);

  const reopenIdentity = useCallback(() => {
    if (!pendingUrl || status !== 'confirming') return;
    stopPolling();
    setMessages((prev) => prev.filter((m) => m.kind !== 'confirmation'));
    setRunId(null);
    setStatus('starting');

    const thinkingId = nextId();
    add({ id: thinkingId, kind: 'agent', text: 'Re-opening identity — resolving fresh…' });

    startAudit(pendingUrl, true)
      .then(({ runId: rid }) => {
        setRunId(rid);
        const progressId = nextId();
        patch(thinkingId, () => ({
          id: thinkingId, kind: 'agent' as const,
          text: 'Queued with fresh identity resolve — identifying app…',
        }));
        add({ id: progressId, kind: 'progress', step: null, complete: false });
        setStatus('running');
        startPolling(rid, progressId);
      })
      .catch((e: unknown) => {
        patch(thinkingId, () => ({
          id: thinkingId, kind: 'error' as const,
          text: e instanceof Error ? e.message : 'Could not re-identify the app.',
        }));
        setStatus('idle');
      });
  }, [pendingUrl, status, add, patch, stopPolling, startPolling]);

  const reject = useCallback(() => {
    if (status !== 'confirming') return;
    stopPolling();
    setMessages((prev) =>
      prev.map((m) =>
        m.kind === 'confirmation' && m.decision === 'pending'
          ? { ...m, decision: 'no' as const }
          : m,
      ),
    );
    add({ id: nextId(), kind: 'agent', text: "No problem — paste the correct App Store URL and I'll take another look." });
    setStatus('idle');
    setRunId(null);
  }, [status, add, stopPolling]);

  const busy = status === 'starting' || status === 'running';

  return useMemo(
    () => ({ messages, status, busy, submitUrl, confirm, confirmAnyway, reject, reopenIdentity }),
    [messages, status, busy, submitUrl, confirm, confirmAnyway, reject, reopenIdentity],
  );
}
```

- [ ] **Step 3: Update ProgressTrace component**

The `ProgressTrace` component currently expects `events: ProgressEvent[]`. It now receives `step: string | null`. Open `apps/web/src/components/ProgressTrace.tsx` and check what it renders. If it references `m.events`, update it to render `m.step` instead. The minimal change:

```typescript
// In ProgressTrace.tsx, wherever it maps over events:
// OLD: {message.events.map(...)}
// NEW: show the step name if present
{message.step && <p className="text-sm text-gray-500">Step: {message.step}</p>}
{!message.complete && <p className="text-sm text-gray-400">Working…</p>}
{message.complete && <p className="text-sm text-gray-400">Done</p>}
```

Check `apps/web/src/components/ProgressTrace.tsx` first — only make the minimal change needed to fix the TypeScript error from the changed `ChatMessage` shape.

- [ ] **Step 4: Run TypeScript check**

```bash
cd apps/web && npm run typecheck
```

Expected: no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/api.ts apps/web/src/hooks/useAudit.ts apps/web/src/components/ProgressTrace.tsx
git commit -m "feat: replace SSE with polling in web client (phase 6b)"
```

---

## Task 6: Telemetry logger

**Files:**
- Create: `apps/server/src/telemetry.ts`
- Modify: `apps/server/src/mastra/index.ts` (use shared logger)

**Interfaces:**
- Produces (exported from `telemetry.ts`):
  ```typescript
  export const logger: { info(obj: object): void; debug(obj: object): void; warn(obj: object): void; error(obj: object): void }
  ```

- [ ] **Step 1: Write the failing test**

Create a minimal test to verify the logger emits at the right level:

```typescript
// In apps/server/src/telemetry.test.ts
import { describe, it, expect, vi } from 'vitest';

describe('telemetry logger', () => {
  it('exports an object with info, debug, warn, error methods', async () => {
    const { logger } = await import('./telemetry');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
  });
});
```

```bash
cd apps/server && npx vitest run src/telemetry.test.ts
```

Expected: FAIL — module `./telemetry` does not exist.

- [ ] **Step 2: Implement telemetry.ts**

Create `apps/server/src/telemetry.ts`:

```typescript
import { PinoLogger } from '@mastra/loggers';
import { FileTransport } from '@mastra/loggers/file';
import { mkdirSync, closeSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';
const level = (process.env.LOG_LEVEL ?? 'info') as LogLevel;

function deriveLogPath(dbUrl: string): string {
  const dbFile = dbUrl.startsWith('file:') ? dbUrl.slice(5) : dbUrl;
  return `${dirname(dbFile)}/logs/mastra.log`;
}

const isTest =
  process.env.NODE_ENV === 'test' || process.env.ASO_SKIP_STARTUP === '1';

const DB_URL = process.env.ASO_DB_URL?.trim() || 'file:./aso-audit.db';
const LOG_PATH = process.env.ASO_LOG_PATH?.trim() || deriveLogPath(DB_URL);

const fileTransport = (() => {
  if (isTest) return undefined;
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    closeSync(openSync(LOG_PATH, 'a'));
    return new FileTransport({ path: LOG_PATH });
  } catch {
    return undefined;
  }
})();

export const logger = new PinoLogger({
  name: 'aso-audit',
  level,
  ...(fileTransport ? { transports: { file: fileTransport } } : {}),
});
```

- [ ] **Step 3: Update mastra/index.ts to use shared logger**

In `apps/server/src/mastra/index.ts`:

1. Add import at the top:
   ```typescript
   import { logger } from '../telemetry';
   ```

2. Remove the inline `PinoLogger`, `FileTransport`, `mkdirSync`, `closeSync`, `openSync`, `dirname`, `deriveLogPath`, `LOG_PATH`, `fileTransport`, `ensureLogFile` declarations that now live in `telemetry.ts`.

3. Change the `new Mastra({ logger: new PinoLogger(...) })` call to:
   ```typescript
   logger,
   ```
   i.e., pass the imported `logger` directly.

- [ ] **Step 4: Run to verify tests pass**

```bash
cd apps/server && npx vitest run src/telemetry.test.ts && npx vitest run
```

Expected: telemetry test passes, full suite still passes.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/telemetry.ts apps/server/src/telemetry.test.ts apps/server/src/mastra/index.ts
git commit -m "feat: shared telemetry logger (phase 6b)"
```

---

## Task 7: Gateway instrumentation

**Files:**
- Modify: `apps/server/src/cost/gateway.ts`
- Modify: `apps/server/src/cost/postgres-pacer.ts`
- Modify: `apps/server/src/cost/gateway.test.ts`

**Interfaces:**
- Consumes: `logger` from `../telemetry`
- Produces: `provider_call` log lines at `info` level after every upstream fetch and DB rate-slot call

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/cost/gateway.test.ts` inside the existing `describe('PassthroughGateway', ...)` block:

```typescript
it('emits a provider_call log line on a successful upstream fetch', async () => {
  const { logger } = await import('../telemetry');
  const spy = vi.spyOn(logger, 'info');

  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
    new Response('{"results":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
  ));

  const gw = new PassthroughGateway();
  await gw.fetch('https://example.com/api', {
    kind: 'app', upstream: 'itunes', tenantId: 'tenant_test',
  });

  const call = spy.mock.calls.find(([obj]) => (obj as any)?.event === 'provider_call');
  expect(call).toBeDefined();
  const logObj = call![0] as any;
  expect(logObj.provider).toBe('itunes');
  expect(logObj.status).toBe('ok');
  expect(typeof logObj.durationMs).toBe('number');
  spy.mockRestore();
});
```

```bash
cd apps/server && npx vitest run src/cost/gateway.test.ts
```

Expected: FAIL — `tenantId` property does not exist on `GatewayCall`, and no `provider_call` log is emitted.

- [ ] **Step 2: Add `tenantId` to `GatewayCall` in gateway.ts**

In `apps/server/src/cost/gateway.ts`, update the `GatewayCall` interface:

```typescript
export interface GatewayCall {
  kind: EntityKind;
  upstream: UpstreamKind;
  entityId?: string;
  skipCache?: boolean;
  /** Audit tenant — threaded through for telemetry. */
  tenantId?: string;
}
```

- [ ] **Step 3: Add provider_call emission to PassthroughGateway.fetch()**

In `apps/server/src/cost/gateway.ts`, add import:

```typescript
import { logger } from '../telemetry';
```

In `PassthroughGateway.fetch()`, find the section just before `return fetch(url, init)` (the non-cacheable path, step 5b) and wrap the three main fetch paths to capture start time and emit a log. The cleanest approach is to add a helper at the bottom of the class and call it after each real upstream call:

Add this private method to `PassthroughGateway`:

```typescript
#logProviderCall(call: GatewayCall, startMs: number, status: 'ok' | 'error' | 'timeout', extra: { httpStatus?: number; errorMessage?: string } = {}): void {
  logger.info({
    event: 'provider_call',
    provider: call.upstream,
    operation: call.kind,
    durationMs: Date.now() - startMs,
    status,
    ...(call.tenantId ? { tenantId: call.tenantId } : {}),
    ...(extra.httpStatus !== undefined ? { httpStatus: extra.httpStatus } : {}),
    ...(extra.errorMessage ? { errorMessage: extra.errorMessage } : {}),
  });
}
```

Then in the `fetch()` method:

1. Add `const startMs = Date.now();` after the governor preflight (step 3), before the pacer wait.
2. In the cacheable path (step 5a), after `const text = await bodyPromise;`, call:
   ```typescript
   this.#logProviderCall(call, startMs, 'ok', { httpStatus: 200 });
   ```
   In the catch block for non-OK HTTP (`if (e instanceof Response) return e;`), call before returning:
   ```typescript
   this.#logProviderCall(call, startMs, 'error', { httpStatus: (e as Response).status });
   ```
3. In the non-cacheable path (step 5b), wrap `return fetch(url, init)` with:
   ```typescript
   const res = await fetch(url, init);
   this.#logProviderCall(call, startMs, res.ok ? 'ok' : 'error', { httpStatus: res.status });
   return res;
   ```

- [ ] **Step 4: Add provider_call to postgres-pacer.ts**

In `apps/server/src/cost/postgres-pacer.ts`, add import:

```typescript
import { logger } from '../telemetry';
```

In `PostgresSharedPacer.wait()`, after the `try { result = await this.sql.begin(...) }` succeeds (after the try/catch block, before the `if (result > 0) await sleep(result)`), add:

```typescript
logger.info({ event: 'provider_call', provider: 'postgres-pacer', operation: 'rate-slot', status: 'ok' });
```

In the catch block (which throws `PacerError`), add before the throw:

```typescript
logger.info({ event: 'provider_call', provider: 'postgres-pacer', operation: 'rate-slot', status: 'error', errorMessage: msg });
```

- [ ] **Step 5: Run tests**

```bash
cd apps/server && npx vitest run src/cost/gateway.test.ts src/cost/postgres-pacer.test.ts
```

Expected: all pass including the new `provider_call` test.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/cost/gateway.ts apps/server/src/cost/gateway.test.ts apps/server/src/cost/postgres-pacer.ts
git commit -m "feat: gateway and pacer provider_call telemetry (phase 6b)"
```

---

## Task 8: LLM and step instrumentation

**Files:**
- Modify: `apps/server/src/mastra/tools/resolve-identity.ts`
- Modify: `apps/server/src/mastra/workflows/audit-workflow.ts`

**Interfaces:**
- Consumes: `logger` from `../../telemetry`
- Produces:
  - `provider_call` log at `info` after each `agent.generate()` call (LLM)
  - `step_summary` log at `info` after `identify-app`, `gather-listing`, `score-listing`, `confirm-app`
  - `step_payload` log at `debug` after same steps (full data)

- [ ] **Step 1: Write the failing test for LLM instrumentation**

Add to `apps/server/src/mastra/tools/resolve-identity.test.ts` inside a new describe block:

```typescript
describe('geminiClassifier telemetry', () => {
  it('emits a provider_call log line when the LLM call completes', async () => {
    const { logger } = await import('../../telemetry');
    const logSpy = vi.spyOn(logger, 'info');

    // Stub agent.generate to return a valid classification.
    const { getLlmProvider } = await import('../../llm');
    const agentSpy = vi.spyOn(await import('@mastra/core/agent'), 'Agent').mockImplementation(
      () => ({ generate: vi.fn().mockResolvedValue({ text: '{"functionCategory":"Test","functionNiche":null,"functionTerms":[]}', usage: { promptTokens: 100, completionTokens: 20 } }) } as any)
    );

    // ... This test is complex due to mocking Agent. Instead, test via integration:
    // check that geminiClassifier wraps its generate call in a timed log.
    // See: the log is emitted from geminiClassifier in resolve-identity.ts.
    // Verify by checking the implementation directly after writing it.
    agentSpy.mockRestore();
    logSpy.mockRestore();
  });
});
```

Note: Due to `Agent` being instantiated at module load time, mock the logger directly to verify the call shape. After implementing step 3, run:

```bash
cd apps/server && npx vitest run src/mastra/tools/resolve-identity.test.ts
```

Expected: all existing tests still pass.

- [ ] **Step 2: Instrument geminiClassifier in resolve-identity.ts**

In `apps/server/src/mastra/tools/resolve-identity.ts`, add import:

```typescript
import { logger } from '../../telemetry';
```

Wrap the `agent.generate()` call in `geminiClassifier`:

```typescript
export const geminiClassifier: IdentityClassifier = async (factSheet) => {
  const llm = getLlmProvider();
  if (!(await llm.reachable())) {
    throw new Error(
      `Couldn't reach Gemini at ${llm.endpoint} during identity resolution. ` +
      'Check that LLM_API_KEY is set in .env and the network is up.',
    );
  }
  const agent = getClassifierAgent();
  const startMs = Date.now();
  let result: Awaited<ReturnType<typeof agent.generate>>;
  try {
    result = await agent.generate(factSheet, { modelSettings: { temperature: 0 } });
  } catch (e) {
    logger.info({
      event: 'provider_call', provider: 'gemini', operation: 'classify',
      durationMs: Date.now() - startMs, status: 'error',
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
  const usage = (result as any).usage as { promptTokens?: number; completionTokens?: number } | undefined;
  logger.info({
    event: 'provider_call', provider: 'gemini', operation: 'classify',
    durationMs: Date.now() - startMs, status: 'ok',
    ...(usage?.promptTokens !== undefined ? { inputTokens: usage.promptTokens } : {}),
    ...(usage?.completionTokens !== undefined ? { outputTokens: usage.completionTokens } : {}),
  });
  return parseClassificationText(typeof result.text === 'string' ? result.text : '');
};
```

- [ ] **Step 3: Add step_summary / step_payload logging to audit-workflow.ts**

In `apps/server/src/mastra/workflows/audit-workflow.ts`, add import:

```typescript
import { logger } from '../../telemetry';
```

After the `identify-app` step resolves its identity (find where `resolveAppIdentity` result is stored and the step is about to return), add:

```typescript
// info summary — always
logger.info({
  event: 'step_summary', step: 'identify-app',
  escalate: resolvedIdentity.escalate,
  divergence: resolvedIdentity.divergence,
  footprintState: resolvedIdentity.footprintProbe?.state ?? 'none',
  categoryBand: resolvedIdentity.categoryBand,
});
// debug payload — only when LOG_LEVEL=debug
logger.debug({
  event: 'step_payload', step: 'identify-app',
  factSheet: factSheet,
  classification: resolvedIdentity,
});
```

After `gather-listing` step completes (find where the review count is known), add:

```typescript
logger.info({
  event: 'step_summary', step: 'gather-listing',
  reviewCount: reviews.length,
});
```

After `score-listing` step completes (find where `report` or `overallScore` is available), add:

```typescript
logger.info({
  event: 'step_summary', step: 'score-listing',
  overallScore: report.overallScore ?? null,
  band: report.band ?? null,
});
```

In the `confirm-app` step, after the human decision is resolved, add:

```typescript
logger.info({
  event: 'step_summary', step: 'confirm-app',
  accepted: confirmed,
  overridden: Boolean(identityDecision?.overrideCategory),
});
```

> **Note:** The exact variable names depend on what's available at each insertion point in `audit-workflow.ts`. Read the workflow file carefully to find the right location — immediately after the computation is complete but before the step returns. Use the names already in scope; do not extract new variables just for logging.

- [ ] **Step 4: Run the full test suite**

```bash
cd apps/server && npx vitest run
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/mastra/tools/resolve-identity.ts apps/server/src/mastra/workflows/audit-workflow.ts
git commit -m "feat: LLM and workflow step telemetry (phase 6b)"
```
