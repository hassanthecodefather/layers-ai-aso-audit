import { validateEnv } from '../env';
import { Mastra } from '@mastra/core';
import { PostgresStore } from '@mastra/pg';
import { logger } from '../telemetry';
import { asoAuditor } from './agents/aso-auditor';
import { asoAuditWorkflow } from './workflows/audit-workflow';
import { auditRoutes } from './routes';
import { costRoutes } from '../cost/routes';
import { authRoutes } from '../auth/routes';
import { healthRoutes } from './health-routes';
import { ascRoutes } from '../asc/routes';
import { trackingRoutes } from '../tracking/routes';
import { verifyLlmStartup } from '../llm';
import { startWorker, type WorkerHandle } from '../queue/worker';
import { getWebStaticRoutes } from './web-static';
import { startTrackingScheduler } from '../tracking/scheduler';
import { startMeasurementScheduler } from '../measurement/scheduler';
import { listingUpdateRoutes } from './listing-update-routes';
import { listingMonitorRoutes } from './listing-monitor-routes';

const isTest =
  process.env.NODE_ENV === 'test' || process.env.ASO_SKIP_STARTUP === '1';

if (!isTest) validateEnv();

const pgUrl = process.env.DATABASE_URL;

export const mastra = new Mastra({
  agents: { asoAuditor },
  workflows: { asoAuditWorkflow },
  ...(pgUrl ? { storage: new PostgresStore({ id: 'aso-audit', connectionString: pgUrl }) } : {}),
  logger,
  server: {
    apiRoutes: [...auditRoutes, ...authRoutes, ...healthRoutes, ...ascRoutes, ...trackingRoutes, ...costRoutes, ...listingUpdateRoutes, ...listingMonitorRoutes, ...getWebStaticRoutes()],
  },
});

if (!isTest) {
  if (pgUrl) {
    import('../memory/pg-migrate').then(({ runPgMigrations }) =>
      import('../memory').then(({ getPgSql }) => {
        const sql = getPgSql();
        if (sql) {
          runPgMigrations(sql)
            .then(() => {
              const worker = startWorker(mastra, sql);
              const tracker = startTrackingScheduler(mastra, sql);
              const measurer = startMeasurementScheduler(mastra, sql);
              registerShutdown(worker, tracker, measurer, sql);
            })
            .catch((e) => {
              console.error('[memory] Postgres migration failed at startup:', e);
            });
        }
      }),
    ).catch((e) => console.error('[memory] Postgres migration bootstrap failed:', e));
  } else {
    console.warn('[memory] DATABASE_URL not set — Mastra storage and job queue unavailable');
  }
  void verifyLlmStartup();
}

const DRAIN_TIMEOUT_MS = 30_000;

function registerShutdown(
  worker: WorkerHandle,
  tracker: import('../tracking/scheduler').SchedulerHandle,
  measurer: import('../measurement/scheduler').SchedulerHandle,
  sql: import('postgres').Sql,
): void {
  async function shutdown(signal: string): Promise<void> {
    console.log(`[shutdown] ${signal} received — stopping worker, tracker, and measurer...`);
    worker.stop();
    tracker.stop();
    measurer.stop();

    const drained = await Promise.race([
      worker.drain(),
      new Promise<void>((r) => setTimeout(r, DRAIN_TIMEOUT_MS)),
    ]);
    void drained;

    console.log('[shutdown] worker idle, closing DB...');
    await sql.end({ timeout: 5 }).catch(() => {});
    console.log('[shutdown] done');
    process.exit(0);
  }

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT',  () => void shutdown('SIGINT'));
}
