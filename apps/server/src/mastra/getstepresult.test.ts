import { describe, it, expect } from 'vitest';
import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';

/**
 * Guards the load-bearing assumption behind A5's human-confirmed override
 * (audit-workflow.ts): the `score-listing` step reads the operator's decision
 * captured at the suspended `confirm-app` step via `getStepResult`. That only
 * works if Mastra (a) persists a *resumed* step's return value, and (b) keeps
 * it readable from a later step even though an intervening step (`gather`)
 * declares a narrower input that strips the extra field.
 *
 * This hermetic mini-workflow mirrors that exact shape — gate(suspend) →
 * narrow(passthrough) → sink(reads gate's result) — with no LLM or network. If
 * Mastra ever changes this contract, the real workflow would silently drop the
 * human decision; this test fails loudly instead.
 */
describe('Mastra getStepResult across suspend/resume + an intervening narrow step', () => {
  const gate = createStep({
    id: 'gate',
    inputSchema: z.object({ value: z.string() }),
    outputSchema: z.object({ value: z.string(), decision: z.string().nullable() }),
    suspendSchema: z.object({ value: z.string() }),
    resumeSchema: z.object({ confirmed: z.boolean(), decision: z.string().nullish() }),
    execute: async ({ inputData, resumeData, suspend }) => {
      if (!resumeData) return suspend({ value: inputData.value });
      return { value: inputData.value, decision: resumeData.decision ?? null };
    },
  });

  // Mirrors gather-listing: declares only { value }, so Mastra strips `decision`
  // from gate's output when chaining into this step.
  const narrow = createStep({
    id: 'narrow',
    inputSchema: z.object({ value: z.string() }),
    outputSchema: z.object({ value: z.string() }),
    execute: async ({ inputData }) => ({ value: inputData.value }),
  });

  // Mirrors score-listing: reaches back to the gate step's full output.
  const sink = createStep({
    id: 'sink',
    inputSchema: z.object({ value: z.string() }),
    outputSchema: z.object({ seenDecision: z.string().nullable() }),
    execute: async ({ getStepResult }) => {
      const gateResult = getStepResult(gate) as { decision: string | null } | undefined;
      return { seenDecision: gateResult?.decision ?? null };
    },
  });

  const wf = createWorkflow({
    id: 'getstepresult-probe',
    inputSchema: z.object({ value: z.string() }),
    outputSchema: z.object({ seenDecision: z.string().nullable() }),
  })
    .then(gate)
    .then(narrow)
    .then(sink)
    .commit();

  const mastra = new Mastra({
    workflows: { wf },
    storage: new LibSQLStore({ id: 'probe', url: ':memory:' }),
  });

  it('surfaces a resumed step decision to a later step', async () => {
    const run = await mastra.getWorkflow('wf').createRun();
    const started: any = await run.start({ inputData: { value: 'hello' } });
    expect(started.status).toBe('suspended');

    const result: any = await run.resume({
      step: 'gate',
      resumeData: { confirmed: true, decision: 'human-corrected' },
    });

    expect(result.status, JSON.stringify(result?.error ?? result).slice(0, 300)).toBe('success');
    const out = result?.result ?? result?.output ?? result?.steps?.sink?.output;
    // The decision captured at the suspended gate survived resume + the narrow
    // step and was readable in sink — exactly what A5 depends on.
    expect(out?.seenDecision).toBe('human-corrected');
  });
});
