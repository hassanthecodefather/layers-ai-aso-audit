import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import { runPgMigrations } from '../memory/pg-migrate';
import { insertJob, markJobDone, updateJobCostJson } from '../queue/job-store';
import { newId } from '../memory/ids';
import { getCostSummary } from './routes';

const TEST_URL = process.env.DATABASE_TEST_URL ?? 'postgresql://aso:aso@localhost:5432/aso_audit_test';
const TEST_SCHEMA = `test_cost_routes_${Date.now()}`;

let sql: postgres.Sql;

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 1 });
  await sql`CREATE SCHEMA IF NOT EXISTS ${sql.unsafe(TEST_SCHEMA)}`;
  await sql`SET search_path TO ${sql.unsafe(TEST_SCHEMA)}`;
  await runPgMigrations(sql);
});

afterAll(async () => {
  await sql`DROP SCHEMA IF EXISTS ${sql.unsafe(TEST_SCHEMA)} CASCADE`;
  await sql.end();
});

beforeEach(async () => {
  await sql`TRUNCATE aso_audit_jobs CASCADE`;
});

async function seedJob(tenantId: string, costJson: string): Promise<void> {
  const runId = newId('run');
  const job = await insertJob(sql, { runId, tenantId, url: 'https://apps.apple.com/us/app/test/id1' });
  await sql`UPDATE aso_audit_jobs SET status = 'running' WHERE id = ${job.id}`;
  await markJobDone(sql, job.id, '{}');
  await updateJobCostJson(sql, job.id, costJson);
}

describe('getCostSummary', () => {
  it('returns zero summary when no jobs with cost_json exist', async () => {
    const result = await getCostSummary(sql, 'tenant1');
    expect(result.runsLast30Days).toBe(0);
    expect(result.averageCentsPerRun).toBe(0);
    expect(result.totalCentsLast30Days).toBe(0);
    expect(result.breakdown).toEqual([]);
  });

  it('returns correct aggregate over seeded job rows', async () => {
    const cost1 = JSON.stringify({
      totalCents: 10,
      breakdown: [
        { task: 'themes', promptTokens: 100, completionTokens: 50, estimatedCents: 4 },
        { task: 'scoring', promptTokens: 200, completionTokens: 100, estimatedCents: 6 },
      ],
    });
    const cost2 = JSON.stringify({
      totalCents: 20,
      breakdown: [
        { task: 'themes', promptTokens: 200, completionTokens: 80, estimatedCents: 8 },
        { task: 'scoring', promptTokens: 400, completionTokens: 200, estimatedCents: 12 },
      ],
    });
    await seedJob('tenant1', cost1);
    await seedJob('tenant1', cost2);

    const result = await getCostSummary(sql, 'tenant1');
    expect(result.runsLast30Days).toBe(2);
    expect(result.totalCentsLast30Days).toBeCloseTo(30, 5);
    expect(result.averageCentsPerRun).toBeCloseTo(15, 5);
    expect(result.breakdown).toHaveLength(2);
    // Sorted by average cost descending — scoring (avg 9) before themes (avg 6).
    expect(result.breakdown[0]!.task).toBe('scoring');
    expect(result.breakdown[0]!.averageCents).toBeCloseTo(9, 5);
    expect(result.breakdown[1]!.task).toBe('themes');
    expect(result.breakdown[1]!.averageCents).toBeCloseTo(6, 5);
  });

  it('does not include jobs from other tenants', async () => {
    await seedJob('tenant_other', JSON.stringify({ totalCents: 50, breakdown: [] }));
    const result = await getCostSummary(sql, 'tenant1');
    expect(result.runsLast30Days).toBe(0);
  });
});
