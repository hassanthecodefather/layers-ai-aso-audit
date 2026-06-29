import { describe, it, expect, beforeAll } from 'vitest';

/**
 * Live workflow smoke (gated on a key): drives the real Mastra run through the
 * widened identity gate — start → suspend at `confirm-app` → resume with an
 * identity decision → success. This is the only check that exercises the A5
 * wiring end-to-end: the new suspend/resume schemas, `getStepResult` in the
 * score step, and the gather input-mapping. Skipped by default (`npm test`
 * loads no key); run with:
 *
 *   dotenv -e ../../.env -- npx vitest run src/mastra/workflow-smoke.test.ts
 */
const HAS_KEY = Boolean(
  process.env.LLM_API_KEY?.trim() ||
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim(),
);
const suite = HAS_KEY ? describe : describe.skip;

suite('Live: ASO audit workflow with the widened identity gate', () => {
  let mastra: any;

  beforeAll(async () => {
    // Isolate both Mastra's store and our aso_ tables to in-memory DBs.
    process.env.ASO_DB_URL = ':memory:';
    ({ mastra } = await import('./index'));
  });

  it('suspends at confirm-app surfacing identity, then resumes to a report', async () => {
    const wf = mastra.getWorkflow('asoAuditWorkflow');
    const run = await wf.createRun();

    // Spotify — a clear identity (no escalation), so the decision is a no-op
    // confirm; the point is to drive the suspend/resume plumbing.
    const started: any = await run.start({
      inputData: { url: 'https://apps.apple.com/us/app/spotify/id324684580' },
    });
    expect(started.status).toBe('suspended');

    // The suspend payload carries summary + the resolved identity (A5).
    const payload =
      started?.steps?.['confirm-app']?.suspendPayload ??
      started?.steps?.['confirm-app']?.payload;
    expect(payload?.summary?.appId).toBe('324684580');
    expect(payload?.identity?.category?.length).toBeGreaterThan(0);

    const result: any = await run.resume({
      step: 'confirm-app',
      resumeData: { confirmed: true, identityDecision: { action: 'confirm' } },
    });

    expect(result.status, JSON.stringify(result?.error ?? result).slice(0, 400)).toBe('success');
    const report =
      result?.result ?? result?.output ?? result?.steps?.['score-listing']?.output;
    expect(report?.overallScore).toBeGreaterThanOrEqual(0);
    expect(report?.overallScore).toBeLessThanOrEqual(100);
  }, 180_000);
});
