import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { AppListingSchema, AppSummarySchema, toSummary } from '../../domain/listing';
import { AuditReportSchema } from '../../domain/audit';
import { assembleReport } from '../../scoring/aggregate';
import { produceAuditDraft } from '../../scoring/score';
import { buildAuditPrompt } from '../../scoring/prompt';
import { computeSignals } from '../../scoring/signals';
import { RUBRIC } from '../../scoring/rubric';
import { identifyAppTool } from '../tools/identify-app';
import { gatherListingTool } from '../tools/gather-listing';
import { getLlmProvider } from '../../llm';
import { getStorage } from '../../memory';
import { extractIdentitySignals } from '../../identity/signals';
import { resolveAppIdentity, buildFactSheet } from '../tools/resolve-identity';
import { buildPriorContext, persistAudit } from '../../memory/audit-memory';

/** Stable hash of the rubric weight column — the rubric-replay key (§A). */
const RUBRIC_VERSION = createHash('sha256')
  .update(JSON.stringify(RUBRIC.map((d) => [d.id, d.weight])))
  .digest('hex')
  .slice(0, 16);

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
        `Couldn't reach Gemini at ${llm.endpoint}. Check that LLM_API_KEY ` +
          '(a Google AI Studio key, starting with "AIza") is set in .env and ' +
          'that the network is up.',
      );
    }

    const agent = mastra?.getAgent('asoAuditor');
    if (!agent) throw new Error('ASO auditor agent is not registered.');

    const listing = inputData;
    const storage = await getStorage();
    const now = new Date().toISOString();

    // ── ID-lite: resolve identity before scoring (spec ID / §G) ───────────
    // The resolver consumes the already-gathered listing — it never re-fetches.
    const resolved = await resolveAppIdentity(listing);
    const identityFactSheet = buildFactSheet(extractIdentitySignals(listing));

    // ── P1: read prior history, build the memory context for the prompt ───
    const priorSnapR = await storage.latestSnapshot(listing.appId, listing.country);
    const priorLedgerR = await storage.ledger(listing.appId, listing.country);
    const priorContext = buildPriorContext({
      identity: resolved,
      priorSnapshot: priorSnapR.ok ? priorSnapR.value : null,
      ledger: priorLedgerR.ok ? priorLedgerR.value : [],
      identityFactSheet,
    });

    // The agent supplies judgement as a validated draft; weighting and the
    // 0-100 total are pure, deterministic code in `assembleReport`.
    let draft;
    try {
      draft = await produceAuditDraft(agent, listing, priorContext);
    } catch (e) {
      throw new Error(
        `The auditor model (${llm.modelId}) failed: ` +
          `${e instanceof Error ? e.message : String(e)}. ` +
          'A more capable model may be needed.',
      );
    }

    const report = assembleReport(toSummary(listing), draft);

    // ── P1: persist snapshot + identity + ledger; apply memory uplifts ────
    const signals = computeSignals(listing);
    const promptHash = createHash('sha256')
      .update(buildAuditPrompt(listing, signals, priorContext))
      .digest('hex')
      .slice(0, 16);
    const memo = await persistAudit(storage, {
      listing,
      signals,
      report,
      resolved,
      identityFactSheet,
      rubricVersion: RUBRIC_VERSION,
      promptHash,
      modelId: llm.modelId,
      now,
    });

    // Surface what memory observed, honestly, in the report's limitations.
    const notes: string[] = [];
    if (resolved.escalate) {
      notes.push(
        `Identity unconfirmed — the store category ("${listing.primaryGenre ?? 'unknown'}") and the app's apparent function ("${resolved.category}") diverge. Identity-rewriting recommendations were withheld pending human confirmation.`,
      );
    }
    if (memo.applied.length > 0) {
      notes.push(`Applied since last audit: ${memo.applied.map((r) => r.title).join('; ')}.`);
    }
    if (memo.contradictions.length > 0) {
      notes.push(
        `Flagged contradictions with past advice: ${memo.contradictions
          .map((c) => `"${c.candidate}" vs "${c.conflictsWith}"`)
          .join('; ')}.`,
      );
    }
    if (memo.identityVersion > 0 || (priorSnapR.ok && priorSnapR.value)) {
      notes.push(`Change since last audit: ${memo.changeDiff.join(' ')}`);
    }

    return { ...report, limitations: [...report.limitations, ...notes] };
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
