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

// Single-worker assumption: one worker process per deployment, so tenant_id
// filtering is not required here. If a shared worker pool is added, add a
// tenant_id predicate to this query to enforce isolation at the DB layer.
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
): Promise<number> {
  const result = await sql`
    UPDATE aso_audit_jobs
    SET status = 'pending', resume_data_json = ${resumeDataJson}
    WHERE id = ${id} AND status = 'awaiting_confirmation'
  `;
  return result.count;
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
      SET status = 'pending', attempt = 0
      WHERE status = 'running'
        AND claimed_at < NOW() - INTERVAL '15 minutes'
      RETURNING id
    )
    SELECT count(*)::text AS count FROM updated
  `;
  return parseInt(row?.count ?? '0', 10);
}
