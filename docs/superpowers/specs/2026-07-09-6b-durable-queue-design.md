# Phase 6B: Durable Queue + Horizontal Workers Design

## Context

Phase 6A wired up Postgres, auth, and the shared rate limiter. Phase 6B makes audits durable: a job survives a container restart, retries on transient failure, and scales horizontally when needed.

---

## Section 1: Architecture

### Coordination layer over Mastra

Mastra stays as the workflow execution engine. We add an `aso_audit_jobs` Postgres table as a coordination layer on top of it — tracking job lifecycle independently of Mastra's internal LibSQL state.

```
POST /audit/start
      │
      ▼
aso_audit_jobs (pending)
      │
      ▼
Worker loop (SELECT FOR UPDATE SKIP LOCKED)
      │
      ▼
mastra.getWorkflow('aso-audit').createRun().start()
      │
      ├─ suspended ──► aso_audit_jobs (awaiting_confirmation)
      │                       │
      │               POST /audit/confirm
      │                       │
      │               run.resume() + job → running
      │
      ├─ done ────────► aso_audit_jobs (done)
      │
      └─ error ────────► retry or failed
```

**Key decisions:**

- Mastra stays on LibSQL (on a persistent Docker volume — survives restarts for single-instance deployment)
- No `@mastra/pg` upgrade needed for 6b (`@mastra/pg` requires `@mastra/core >= 1.50.0`; current project is on `1.36.0`). Deferred to path-to-A (multi-instance) phase.
- Worker loop runs in the same process as the web server (no separate service)
- SSE replaced by polling (`GET /audit/status/:runId`)

### Deployment path

- **Now (option C):** Single container, worker loop in-process, Mastra LibSQL on persistent volume
- **Later (option A):** Multiple containers, each runs its own worker loop; `SELECT FOR UPDATE SKIP LOCKED` prevents double-claiming; `@mastra/pg` upgrade unlocks shared Mastra state

---

## Section 2: Job table + state machine

### Schema

```sql
CREATE TABLE aso_audit_jobs (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL UNIQUE,
  tenant_id      TEXT NOT NULL,
  url            TEXT NOT NULL,
  reopen_identity INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL,
  step           TEXT,
  result_json    TEXT,
  error_message  TEXT,
  attempt        INTEGER NOT NULL DEFAULT 0,
  max_attempts   INTEGER NOT NULL DEFAULT 3,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at     TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ
);

CREATE INDEX ON aso_audit_jobs (status, created_at);
CREATE INDEX ON aso_audit_jobs (run_id);
```

### State machine

```
pending
  └─► running
        ├─► done
        ├─► failed            (attempt >= max_attempts)
        └─► awaiting_confirmation
              └─► running     (after POST /audit/confirm)
                    ├─► done
                    └─► failed
```

Transitions:

| From | To | Trigger |
|------|----|---------|
| — | `pending` | `POST /audit/start` inserts row |
| `pending` | `running` | Worker claims via `SELECT FOR UPDATE SKIP LOCKED` |
| `running` | `awaiting_confirmation` | Mastra workflow suspends at confirmation gate |
| `awaiting_confirmation` | `running` | `POST /audit/confirm` calls `run.resume()` |
| `running` | `done` | Mastra workflow completes successfully |
| `running` | `pending` | Transient error, `attempt < max_attempts` |
| `running` | `failed` | Error, `attempt >= max_attempts` |

### Dead-job recovery

On startup, before the worker loop begins:

```sql
UPDATE aso_audit_jobs
SET status = 'pending'
WHERE status = 'running'
  AND claimed_at < NOW() - INTERVAL '15 minutes'
```

`awaiting_confirmation` jobs are never auto-reset — they wait for human action.

---

## Section 3: Worker loop

The worker starts on app boot alongside the Mastra server. It runs in the same Node process.

```
on startup:
  1. run dead-job recovery (reset orphaned running jobs)
  2. start workerLoop()

workerLoop():
  loop forever:
    job = claimNextJob()
    if job:
      executeJob(job)   ← awaited; one job per slot
    else:
      sleep 5s
```

### Claiming a job

```sql
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
```

`SKIP LOCKED` makes this safe for multiple concurrent workers (including multi-instance option A later) — two workers never claim the same job.

### Executing a job

```
executeJob(job):
  try:
    run = mastra.getWorkflow('aso-audit').createRun({ runId: job.run_id })

    updateJobStep(job.id, 'identify-app')
    result = await run.start({ inputData: { url, tenantId, reopenIdentity } })

    if result.status === 'suspended':
      updateJobStatus(job.id, 'awaiting_confirmation', step: 'confirm-app')
      return   ← worker moves on; this job waits for human

    updateJobStatus(job.id, 'done', result_json: result.output)

  catch error:
    if job.attempt < job.max_attempts:
      updateJobStatus(job.id, 'pending')   ← re-queued
    else:
      updateJobStatus(job.id, 'failed', error_message: error.message)
```

### Concurrency

One slot per process is correct for 6b — audits are Gemini-bound (sequential LLM calls), not CPU-bound. Two instances (path to A) gives two parallel audits naturally. A `WORKER_CONCURRENCY` env var can open more slots later without changing the architecture.

---

## Section 4: API changes

### `POST /audit/start`

Replaces the current fire-and-forget. Returns immediately after inserting the job row.

```
Request:  { url, tenantId, reopenIdentity? }
Response: { jobId, runId, status: 'pending' }
```

Internally:
1. Generate `jobId` (`job_<nanoid>`) and `runId`
2. Insert row into `aso_audit_jobs` with `status = 'pending'`
3. Return — the worker picks it up asynchronously

### `GET /audit/status/:runId`

New polling endpoint. Client polls every 2–3 seconds.

```
Response:
{
  jobId,
  runId,
  status: 'pending' | 'running' | 'done' | 'failed' | 'awaiting_confirmation',
  step?: string,           // current step name while running
  result?: AuditResult,    // present when status = 'done'
  errorMessage?: string,   // present when status = 'failed'
  attempt: number,
  maxAttempts: number
}
```

### `POST /audit/confirm`

Shape unchanged. Internal change: transitions job row `awaiting_confirmation → running` in addition to calling `run.resume()`.

```
Request:  { runId, identity }   (unchanged)
Response: { ok: true }          (unchanged)
```

### SSE endpoint (`GET /audit/stream/:runId`)

Deprecated. Returns `410 Gone`. Removed from the client in Section 5.

---

## Section 5: Web client changes

### Starting an audit

```
1. POST /audit/start  →  { jobId, runId }
2. Store runId in component state
3. Start polling GET /audit/status/:runId every 2.5s
```

### Polling loop

```
while polling:
  response = GET /audit/status/:runId

  if status === 'pending' or 'running':
    update progress indicator (show step name if present)
    continue polling

  if status === 'awaiting_confirmation':
    stop polling
    show confirmation card

  if status === 'done':
    stop polling
    render audit result

  if status === 'failed':
    stop polling
    if attempt < maxAttempts:
      show "Retrying... (attempt N of M)"
    else:
      show error message

  on network error:
    keep polling (transient — don't abort the audit)
```

### Confirmation card

Today triggered by an SSE event. After this change, triggered by `status === 'awaiting_confirmation'` from the poll response. The card itself and the `POST /audit/confirm` call are unchanged.

### Progress display

Replace SSE-driven step updates with the `step` field from the poll response. Updated each time the worker writes a new step to the job row.

### Cleanup

Remove `EventSource` / SSE connection management code entirely.
