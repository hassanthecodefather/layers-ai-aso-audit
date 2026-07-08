import type postgres from 'postgres';
import type { Mastra } from '@mastra/core';
import {
  type AuditJob,
  claimNextJob, markJobRunning, markJobSuspended,
  markJobDone, markJobFailed,
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
  try {
    const workflow = mastra.getWorkflow('asoAuditWorkflow');
    const run = await workflow.createRun({ runId: job.runId });

    let result: any;

    if (!job.resumeDataJson) {
      // Fresh run — run start from beginning through to first suspend or completion.
      await markJobRunning(sql, job.id, 'identify-app');
      result = await run.start({
        inputData: {
          url: job.url,
          tenantId: job.tenantId,
          reopenIdentity: job.reopenIdentity,
        },
      });
    } else {
      // If the run already advanced past confirm-app before failing, resumeStream will
      // receive a non-suspended run and may throw or no-op — all attempts will then
      // exhaust and the job lands in 'failed'. This is the trade-off of the current
      // retry model; add step-position tracking to distinguish pre- vs post-resume
      // failures before tightening this.
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
    // Note: 15-minute stale-job threshold is also an implicit per-job runtime ceiling.
    // An audit running longer than 15 min on a second replica will be reclaimed and
    // double-executed. With a single worker this is fine; add a heartbeat or raise
    // the threshold before scaling to multiple replicas.
    const recovered = await recoverStaleJobs(sql).catch((e) => {
      console.error('[worker] recoverStaleJobs failed:', e instanceof Error ? e.message : e);
      return 0;
    });
    if (recovered > 0) {
      console.log(`[worker] recovered ${recovered} stale jobs on startup`);
    }

    while (!stopped) {
      const job = await claimNextJob(sql).catch((e) => {
        console.error('[worker] claimNextJob failed:', e instanceof Error ? e.message : e);
        return null;
      });
      if (job) {
        try {
          await executeJob(job, mastra, sql);
        } catch (err) {
          console.error('[worker] executeJob threw unexpectedly (DB error during error-handling path) — job may be stuck in running', err instanceof Error ? err.message : err);
        }
      } else {
        await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    }
  }

  void loop();
  return () => { stopped = true; };
}
