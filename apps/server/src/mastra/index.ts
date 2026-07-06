import { mkdirSync, closeSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { PinoLogger } from '@mastra/loggers';
import { FileTransport } from '@mastra/loggers/file';
import { Observability, MastraStorageExporter } from '@mastra/observability';
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

/**
 * Log file path — defaults to a `logs/` sibling of the DB file so it lands
 * on the same Docker volume and survives container rebuilds.
 * Override with ASO_LOG_PATH (e.g. in tests that should not write to disk).
 */
function deriveLogPath(dbUrl: string): string {
  // Strip `file:` prefix, resolve to an absolute-ish path, place logs beside DB.
  const dbFile = dbUrl.startsWith('file:') ? dbUrl.slice(5) : dbUrl;
  return dirname(dbFile) + '/logs/mastra.log';
}

const LOG_PATH = process.env.ASO_LOG_PATH?.trim() || deriveLogPath(DB_URL);

// FileTransport requires the file to exist before construction — create it.
function ensureLogFile(logPath: string): void {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    // Open with 'a' (append) to create-if-absent without truncating.
    closeSync(openSync(logPath, 'a'));
  } catch (e) {
    console.warn('[logger] could not create log file at', logPath, '—', e);
  }
}

// Only set up file transport outside of tests (tests set ASO_SKIP_STARTUP=1
// or NODE_ENV=test and should not write log files to disk).
const isTest =
  process.env.NODE_ENV === 'test' || process.env.ASO_SKIP_STARTUP === '1';

const fileTransport = (() => {
  if (isTest) return undefined;
  ensureLogFile(LOG_PATH);
  try {
    return new FileTransport({ path: LOG_PATH });
  } catch (e) {
    console.warn('[logger] FileTransport unavailable (', LOG_PATH, '):', e);
    return undefined;
  }
})();

export const mastra = new Mastra({
  agents: { asoAuditor },
  workflows: { asoAuditWorkflow },
  storage: new LibSQLStore({ id: 'aso-audit', url: DB_URL }),
  logger: new PinoLogger({
    name: 'aso-audit',
    level: 'info',
    ...(fileTransport ? { transports: { file: fileTransport } } : {}),
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'aso-audit',
        exporters: [new MastraStorageExporter()],
      },
    },
  }),
  server: {
    apiRoutes: auditRoutes,
  },
});

// One-time startup work: create our `aso_*` tables (idempotent) and confirm
// the pinned Gemini model responds. Both are fire-and-forget and log their
// outcome — neither should crash boot, and we skip them under test so the
// suite stays hermetic (no DB writes, no network).
if (!isTest) {
  runMigrations(DB_URL).catch((e) =>
    console.error('[memory] migration failed at startup:', e),
  );
  void verifyLlmStartup();
}
