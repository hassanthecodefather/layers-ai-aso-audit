import { PinoLogger } from '@mastra/loggers';
import { FileTransport } from '@mastra/loggers/file';
import { mkdirSync, closeSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

const level = process.env.LOG_LEVEL ?? 'info';

function deriveLogPath(dbUrl: string): string {
  const dbFile = dbUrl.startsWith('file:') ? dbUrl.slice(5) : dbUrl;
  return `${dirname(dbFile)}/logs/mastra.log`;
}

const isTest =
  process.env.NODE_ENV === 'test' || process.env.ASO_SKIP_STARTUP === '1';

const DB_URL = process.env.ASO_DB_URL?.trim() || 'file:./aso-audit.db';
const LOG_PATH = process.env.ASO_LOG_PATH?.trim() || deriveLogPath(DB_URL);

// Starts as stdout-only; file transport is attached after the event loop starts
// (setImmediate below) so blocking FS calls (mkdirSync/openSync) never happen at
// module-import time. All named importers access `logger` via live property
// access on the module object, so the reassignment is visible immediately.
export let logger = new PinoLogger({ name: 'aso-audit', level });

if (!isTest) {
  setImmediate(() => {
    try {
      mkdirSync(dirname(LOG_PATH), { recursive: true });
      closeSync(openSync(LOG_PATH, 'a'));
      const fileTransport = new FileTransport({ path: LOG_PATH });
      logger = new PinoLogger({
        name: 'aso-audit',
        level,
        transports: { file: fileTransport },
      });
    } catch {
      // File transport is best-effort; failure must not affect the server.
    }
  });
}
