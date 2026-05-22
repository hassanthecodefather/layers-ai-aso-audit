import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { PinoLogger } from '@mastra/loggers';
import { asoAuditor } from './agents/aso-auditor';
import { asoAuditWorkflow } from './workflows/audit-workflow';
import { auditRoutes } from './routes';

/**
 * The Mastra instance — the composition root.
 *
 * Storage is LibSQL on a local file: workflows that `suspend()` serialise
 * their state here, so the run survives between the `/audit/identify` request
 * (which suspends) and the `/audit/run` request (which resumes it).
 */
export const mastra = new Mastra({
  agents: { asoAuditor },
  workflows: { asoAuditWorkflow },
  storage: new LibSQLStore({ id: 'aso-audit', url: 'file:./aso-audit.db' }),
  logger: new PinoLogger({ name: 'aso-audit', level: 'info' }),
  server: {
    apiRoutes: auditRoutes,
  },
});
