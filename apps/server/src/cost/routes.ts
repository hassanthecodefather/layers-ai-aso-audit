import { registerApiRoute } from '@mastra/core/server';
import postgres from 'postgres';
import { getAuthenticatedTenantId } from '../auth/middleware';
import { getPgSql } from '../memory';

export interface CostSummary {
  runsLast30Days: number;
  averageCentsPerRun: number;
  totalCentsLast30Days: number;
  breakdown: {
    task: string;
    averageCents: number;
    percentOfTotal: number;
  }[];
}

const EMPTY_SUMMARY: CostSummary = {
  runsLast30Days: 0,
  averageCentsPerRun: 0,
  totalCentsLast30Days: 0,
  breakdown: [],
};

export async function getCostSummary(sql: postgres.Sql, tenantId: string): Promise<CostSummary> {
  const rows = await sql<{ cost_json: string }[]>`
    SELECT cost_json
    FROM aso_audit_jobs
    WHERE tenant_id = ${tenantId}
      AND cost_json IS NOT NULL
      AND completed_at > NOW() - INTERVAL '30 days'
  `;

  if (rows.length === 0) return EMPTY_SUMMARY;

  const parsed = rows.map((r) => {
    try {
      return JSON.parse(r.cost_json) as {
        totalCents: number;
        breakdown: { task: string; estimatedCents: number }[];
      };
    } catch {
      return null;
    }
  }).filter((r): r is NonNullable<typeof r> => r !== null);

  if (parsed.length === 0) return EMPTY_SUMMARY;

  const totalCentsLast30Days = parsed.reduce((s, r) => s + r.totalCents, 0);
  const averageCentsPerRun = totalCentsLast30Days / parsed.length;

  // Aggregate per-task averages across all runs.
  const taskTotals = new Map<string, { sum: number; count: number }>();
  for (const run of parsed) {
    for (const entry of run.breakdown) {
      const existing = taskTotals.get(entry.task) ?? { sum: 0, count: 0 };
      taskTotals.set(entry.task, { sum: existing.sum + entry.estimatedCents, count: existing.count + 1 });
    }
  }

  const breakdown = [...taskTotals.entries()]
    .map(([task, { sum, count }]) => {
      const averageCents = sum / count;
      return {
        task,
        averageCents,
        percentOfTotal: averageCentsPerRun > 0 ? (averageCents / averageCentsPerRun) * 100 : 0,
      };
    })
    .sort((a, b) => b.averageCents - a.averageCents);

  return {
    runsLast30Days: parsed.length,
    averageCentsPerRun,
    totalCentsLast30Days,
    breakdown,
  };
}

export const costRoutes = [
  registerApiRoute('/api/cost/summary', {
    method: 'GET',
    handler: async (c) => {
      const tenantId = await getAuthenticatedTenantId(c);
      if (!tenantId) return c.json({ error: 'Unauthorized' }, 401);
      const sql = getPgSql();
      if (!sql) return c.json({ error: 'Database not configured.' }, 503);
      try {
        const summary = await getCostSummary(sql, tenantId);
        return c.json(summary);
      } catch (e) {
        console.error('[cost/summary] failed:', e);
        return c.json({ error: 'Could not compute cost summary.' }, 500);
      }
    },
  }),
];
