import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { PinoLogger } from '@mastra/loggers';
import { asoAuditor } from './agents/aso-auditor';
import { asoAuditWorkflow } from './workflows/audit-workflow';
import { auditRoutes } from './routes';
import { verifyLlmStartup } from '../llm';
import { runMigrations } from '../memory/migrate';

/**
 * The Mastra instance — the composition root.
 *
 * Storage is LibSQL on a local file: workflows that `suspend()` serialise
 * their state here, so the run survives between the `/audit/identify` request
 * (which suspends) and the `/audit/run` request (which resumes it).
 */
const DB_URL = process.env.ASO_DB_URL?.trim() || 'file:./aso-audit.db';

export const mastra = new Mastra({
  agents: { asoAuditor },
  workflows: { asoAuditWorkflow },
  storage: new LibSQLStore({ id: 'aso-audit', url: DB_URL }),
  logger: new PinoLogger({ name: 'aso-audit', level: 'info' }),
  server: {
    apiRoutes: auditRoutes,
  },
});

// One-time startup work: create our `aso_*` tables (idempotent) and confirm
// the pinned Gemini model responds. Both are fire-and-forget and log their
// outcome — neither should crash boot, and we skip them under test so the
// suite stays hermetic (no DB writes, no network).
if (process.env.NODE_ENV !== 'test' && process.env.ASO_SKIP_STARTUP !== '1') {
  runMigrations(DB_URL).catch((e) =>
    console.error('[memory] migration failed at startup:', e),
  );
  void verifyLlmStartup();
}
