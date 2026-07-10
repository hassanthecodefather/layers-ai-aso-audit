import { registerApiRoute } from '@mastra/core/server';
import { getPgSql } from '../memory';

export const healthRoutes = [
  registerApiRoute('/health', {
    method: 'GET',
    handler: async (c) => {
      const sql = getPgSql();
      if (sql) {
        try {
          await sql`SELECT 1`;
        } catch {
          return c.json({ status: 'degraded', reason: 'database unreachable' }, 503);
        }
      }
      return c.json({ status: 'ok' });
    },
  }),
];
