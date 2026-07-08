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

const fileTransport = (() => {
  if (isTest) return undefined;
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    closeSync(openSync(LOG_PATH, 'a'));
    return new FileTransport({ path: LOG_PATH });
  } catch {
    return undefined;
  }
})();

export const logger = new PinoLogger({
  name: 'aso-audit',
  level,
  ...(fileTransport ? { transports: { file: fileTransport } } : {}),
});
