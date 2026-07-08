import { describe, it, expect, vi, beforeEach } from 'vitest';
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
