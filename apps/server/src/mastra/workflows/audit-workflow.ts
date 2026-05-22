import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { AppListingSchema, AppSummarySchema, toSummary } from '../../domain/listing';
import { AuditReportSchema } from '../../domain/audit';
import { assembleReport } from '../../scoring/aggregate';
import { produceAuditDraft } from '../../scoring/score';
import { identifyAppTool } from '../tools/identify-app';
import { gatherListingTool } from '../tools/gather-listing';
import { getLlmProvider } from '../../llm';

/**
 * The ASO audit workflow.
 *
 * The orchestration backbone, and the deliberate architectural call: the
 * sequence is fixed, so it is a workflow — not left to an agent's reasoning.
 * Four steps, one human gate:
 *
 *   identify-app ─▶ confirm-app ──suspend──▶ [user confirms] ─▶ gather-listing ─▶ score-listing
 *
 * The two data tools are composed directly as steps via `createStep(tool)`.
 * `confirm-app` suspends: the run serialises to LibSQL and waits for the
 * "Is this the app you meant?" answer. The LLM is confined to `score-listing`.
 */

// ── Step 1: resolve the URL to surface metadata (the identify-app tool) ────
const identifyStep = createStep(identifyAppTool);

// ── Step 2: suspend for human confirmation ─────────────────────────────────
const confirmStep = createStep({
  id: 'confirm-app',
  inputSchema: AppSummarySchema,
  outputSchema: z.object({ appId: z.string(), country: z.string() }),
  suspendSchema: z.object({ summary: AppSummarySchema }),
  resumeSchema: z.object({ confirmed: z.boolean() }),
  execute: async ({ inputData, resumeData, suspend }) => {
    // First pass: hand the resolved summary back for confirmation.
    if (!resumeData) {
      return suspend({ summary: inputData });
    }
    // Resumed with a "no" — the UI normally starts a fresh run instead of
    // resuming, but guard the path anyway.
    if (!resumeData.confirmed) {
      throw new Error('Audit cancelled — the identified app was rejected.');
    }
    // Resumed with a "yes": carry the app reference forward.
    return { appId: inputData.appId, country: inputData.country };
  },
});

// ── Step 3: gather the full listing (the gather-listing tool) ──────────────
const gatherStep = createStep(gatherListingTool);

// ── Step 4: score the listing with the auditor agent, assemble the report ──
const scoreStep = createStep({
  id: 'score-listing',
  inputSchema: AppListingSchema,
  outputSchema: AuditReportSchema,
  execute: async ({ inputData, mastra }) => {
    const llm = getLlmProvider();
    if (!(await llm.reachable())) {
      throw new Error(
        `Couldn't reach the LLM at ${llm.endpoint}. For a local Ollama ` +
          `server, start it and run \`ollama pull ${llm.modelId}\`; for ` +
          'Ollama Cloud, check LLM_API_KEY in .env.',
      );
    }

    const agent = mastra?.getAgent('asoAuditor');
    if (!agent) throw new Error('ASO auditor agent is not registered.');

    // The agent supplies judgement as a validated draft; weighting and the
    // 0-100 total are pure, deterministic code in `assembleReport`.
    let draft;
    try {
      draft = await produceAuditDraft(agent, inputData);
    } catch (e) {
      throw new Error(
        `The auditor model (${llm.modelId}) failed: ` +
          `${e instanceof Error ? e.message : String(e)}. ` +
          'A more capable model may be needed.',
      );
    }

    return assembleReport(toSummary(inputData), draft);
  },
});

export const asoAuditWorkflow = createWorkflow({
  id: 'aso-audit',
  inputSchema: z.object({ url: z.string() }),
  outputSchema: AuditReportSchema,
})
  .then(identifyStep)
  .then(confirmStep)
  .then(gatherStep)
  .then(scoreStep)
  .commit();
