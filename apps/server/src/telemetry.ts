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

// Create the logger without a file transport initially — avoids blocking the
// event loop with mkdirSync/openSync at module import time.
export const logger = new PinoLogger({
  name: 'aso-audit',
  level,
});

// After the event loop is running, lazily attach the file transport.
// setImmediate defers until after all synchronous module initialisation is done.
if (!isTest) {
  setImmediate(() => {
    try {
      mkdirSync(dirname(LOG_PATH), { recursive: true });
      closeSync(openSync(LOG_PATH, 'a'));
      const fileTransport = new FileTransport({ path: LOG_PATH });
      // @ts-expect-error — PinoLogger does not expose an addTransport public API;
      // we reach into the underlying pino instance to attach the file destination
      // after the fact. This is a safe workaround until @mastra/loggers exposes
      // a runtime addTransport method.
      if (typeof (logger as any).addTransport === 'function') {
        (logger as any).addTransport('file', fileTransport);
      }
    } catch {
      // File transport is best-effort; failure must not affect the server.
    }
  });
}
