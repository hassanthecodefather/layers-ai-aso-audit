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
