import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { logger } from '../telemetry';
import { asoAuditor } from './agents/aso-auditor';
import { asoAuditWorkflow } from './workflows/audit-workflow';
import { auditRoutes } from './routes';
import { authRoutes } from '../auth/routes';
import { verifyLlmStartup } from '../llm';
import { runMigrations } from '../memory/migrate';
import { startWorker } from '../queue/worker';

/**
 * The Mastra instance — the composition root.
 *
 * Storage is LibSQL on a local file: workflows that `suspend()` serialise
 * their state here, so the run survives between the `/audit/identify` request
 * (which suspends) and the `/audit/run` request (which resumes it).
 */
const DB_URL = process.env.ASO_DB_URL?.trim() || 'file:./aso-audit.db';

// Only set up file transport outside of tests (tests set ASO_SKIP_STARTUP=1
// or NODE_ENV=test and should not write log files to disk).
const isTest =
  process.env.NODE_ENV === 'test' || process.env.ASO_SKIP_STARTUP === '1';

export const mastra = new Mastra({
  agents: { asoAuditor },
  workflows: { asoAuditWorkflow },
  storage: new LibSQLStore({ id: 'aso-audit', url: DB_URL }),
  logger,
  // NOTE: observability via MastraStorageExporter was removed — it writes AI
  // spans to the same LibSQL file the workflow uses for suspend/resume state and
  // blocks the run on resume ("does not support batch creating metrics"). Studio
  // Traces needs a storage that supports it (e.g. Postgres at P6) or a non-LibSQL
  // exporter; Studio Logs still work via the PinoLogger file transport above.
  server: {
    apiRoutes: [...auditRoutes, ...authRoutes],
  },
});

// One-time startup work: create our `aso_*` tables (idempotent) and confirm
// the pinned Gemini model responds. Both are fire-and-forget and log their
// outcome — neither should crash boot, and we skip them under test so the
// suite stays hermetic (no DB writes, no network).
if (!isTest) {
  const pgUrl = process.env.DATABASE_URL;
  if (pgUrl) {
    import('../memory/pg-migrate').then(({ runPgMigrations }) =>
      import('../memory').then(({ getPgSql }) => {
        const sql = getPgSql();
        if (sql) runPgMigrations(sql).catch((e) =>
          console.error('[memory] Postgres migration failed at startup:', e),
        );
      }),
    ).catch((e) => console.error('[memory] Postgres migration bootstrap failed:', e));
  } else {
    runMigrations(DB_URL).catch((e) =>
      console.error('[memory] migration failed at startup:', e),
    );
  }
  void verifyLlmStartup();

  // Start the durable job worker (Postgres only — no-op without DATABASE_URL).
  if (process.env.DATABASE_URL) {
    import('../memory').then(({ getPgSql }) => {
      const sql = getPgSql();
      if (sql) startWorker(mastra, sql);
    }).catch((e) => console.error('[worker] failed to start:', e));
  }
}
