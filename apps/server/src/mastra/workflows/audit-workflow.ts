import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { AppListingSchema, AppSummarySchema, toSummary } from '../../domain/listing';
import { AuditReportSchema } from '../../domain/audit';
import { parseAppStoreUrl } from '../../domain/app-url';
import { assembleReport } from '../../scoring/aggregate';
import { produceAuditDraft } from '../../scoring/score';
import { buildAuditPrompt } from '../../scoring/prompt';
import { computeSignals } from '../../scoring/signals';
import { allDimensionHashes } from '../../scoring/dimension-scorer';
import { RUBRIC_VERSION } from '../../scoring/version';
import { gatherListingTool } from '../tools/gather-listing';
import { fetchITunesCore, type ITunesCore } from '../../sources/itunes';
import { getLlmProvider } from '../../llm';
import { getStorage } from '../../memory';
import { extractIdentitySignals } from '../../identity/signals';
import { buildFactSheet, geminiClassifier } from '../tools/resolve-identity';
import { ResolvedIdentitySchema } from '../../identity/resolve';
import {
  resolveWithHistory,
  applyHumanDecision,
  IdentityDecisionSchema,
} from '../../identity/human-confirm';
import { buildPriorContext, persistAudit } from '../../memory/audit-memory';
import { getVisionClient, runVision, selectVisionResult } from '../../vision';

/**
 * The ASO audit workflow.
 *
 * The orchestration backbone, and the deliberate architectural call: the
 * sequence is fixed, so it is a workflow — not left to an agent's reasoning.
 * Four steps, one human gate:
 *
 *   identify-app ─▶ confirm-app ──suspend──▶ [confirms app + identity] ─▶ gather-listing ─▶ score-listing
 *
 * `identify-app` resolves both the surface metadata *and* the ID-lite identity
 * (spec ID / §G), so the single `confirm-app` suspend can ask one widened
 * question — "is this the app, and is this what it is?" — before any expensive
 * work. The LLM is confined to identity classification and `score-listing`.
 */

const SummaryAndIdentitySchema = z.object({
  summary: AppSummarySchema,
  identity: ResolvedIdentitySchema,
  /** True only when the resolved identity escalates (cross-domain / low). */
  identityNeedsConfirm: z.boolean(),
});

/** Build the confirmation-card summary from the iTunes core (no second fetch). */
function coreToSummary(core: ITunesCore) {
  return {
    appId: core.appId,
    country: core.country,
    url: core.url,
    name: core.name,
    developer: core.developer,
    iconUrl: core.iconUrl,
    primaryGenre: core.primaryGenre,
    averageRating: core.averageRating,
    ratingCount: core.ratingCount,
  };
}

/** A minimal listing carrying just the day-one ID-lite signals from the core. */
function coreToIdentityListing(core: ITunesCore) {
  return AppListingSchema.parse({
    appId: core.appId,
    country: core.country,
    url: core.url,
    name: core.name,
    developer: core.developer,
    bundleId: core.bundleId,
    sellerUrl: core.sellerUrl,
    iconUrl: core.iconUrl,
    primaryGenre: core.primaryGenre,
    genres: core.genres,
    price: core.price,
    formattedPrice: core.formattedPrice,
    subtitle: null,
    promotionalText: null,
    description: core.description,
    releaseNotes: core.releaseNotes,
    version: core.version,
    screenshotUrls: core.screenshotUrls,
    ipadScreenshotUrls: core.ipadScreenshotUrls,
    hasPreviewVideo: false,
    averageRating: core.averageRating,
    ratingCount: core.ratingCount,
    currentVersionRating: core.currentVersionRating,
    currentVersionRatingCount: core.currentVersionRatingCount,
    contentRating: core.contentRating,
    releaseDate: core.releaseDate,
    currentVersionReleaseDate: core.currentVersionReleaseDate,
    reviews: [],
    competitors: [],
    provenance: { itunes: true, crawler: false, reviews: false, competitors: false },
  });
}

// ── Step 1: resolve surface metadata AND the ID-lite identity ──────────────
const identifyStep = createStep({
  id: 'identify-app',
  inputSchema: z.object({ url: z.string() }),
  outputSchema: SummaryAndIdentitySchema,
  execute: async ({ inputData }) => {
    const ref = parseAppStoreUrl(inputData.url);
    if (!ref.ok) throw new Error(ref.error);
    const core = await fetchITunesCore(ref.value);
    if (!core.ok) throw new Error(core.error);

    // Resolve ID-lite from the day-one signals (developer, bundle-id,
    // marketing-domain). A prior human-confirmed identity is respected and
    // re-asked only if its signals materially changed and the answer flips.
    const storage = await getStorage();
    const priorR = await storage.latestIdentity(core.value.appId, core.value.country);
    const prior = priorR.ok ? priorR.value : null;
    const identity = await resolveWithHistory(
      coreToIdentityListing(core.value),
      geminiClassifier,
      prior,
    );

    return {
      summary: coreToSummary(core.value),
      identity,
      identityNeedsConfirm: identity.escalate,
    };
  },
});

// ── Step 2: suspend for human confirmation (app + identity, widened) ───────
const confirmStep = createStep({
  id: 'confirm-app',
  inputSchema: SummaryAndIdentitySchema,
  outputSchema: z.object({
    appId: z.string(),
    country: z.string(),
    identityDecision: IdentityDecisionSchema.nullable(),
  }),
  suspendSchema: SummaryAndIdentitySchema,
  resumeSchema: z.object({
    confirmed: z.boolean(),
    // Present only when the operator confirms/corrects/picks the identity.
    identityDecision: IdentityDecisionSchema.nullish(),
  }),
  execute: async ({ inputData, resumeData, suspend }) => {
    // First pass: hand back the summary AND the resolved identity. When
    // `identityNeedsConfirm` is true the UI widens the prompt to "here's what
    // we think your app is — confirm, correct, or pick a candidate."
    if (!resumeData) {
      return suspend(inputData);
    }
    if (!resumeData.confirmed) {
      throw new Error('Audit cancelled — the identified app was rejected.');
    }
    return {
      appId: inputData.summary.appId,
      country: inputData.summary.country,
      identityDecision: resumeData.identityDecision ?? null,
    };
  },
});

// ── Step 3: gather the full listing (the gather-listing tool) ──────────────
const gatherStep = createStep(gatherListingTool);

// ── Step 4: score the listing with the auditor agent, assemble the report ──
const scoreStep = createStep({
  id: 'score-listing',
  inputSchema: AppListingSchema,
  outputSchema: AuditReportSchema,
  execute: async ({ inputData, mastra, getStepResult }) => {
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

    // ── Identity comes from `identify-app` (resolved once); apply the human
    //    decision captured at `confirm-app`, if any (spec ID human override).
    const identified = getStepResult(identifyStep) as
      | z.infer<typeof SummaryAndIdentitySchema>
      | undefined;
    const confirmed = getStepResult(confirmStep) as
      | { identityDecision: z.infer<typeof IdentityDecisionSchema> | null }
      | undefined;

    let resolved =
      identified?.identity ??
      // Defensive fallback: if the step result is somehow missing, resolve now.
      (await resolveWithHistory(listing, geminiClassifier, null));
    if (confirmed?.identityDecision) {
      resolved = applyHumanDecision(resolved, confirmed.identityDecision);
    }

    const identityFactSheet = buildFactSheet(extractIdentitySignals(listing));

    // ── P1: read prior history for reconciliation (NOT injected into generation) ─
    // Generation is a pure function of (listing + identity); the ledger is read
    // after generation, in the memory reconciliation layer (persistAudit). Injecting
    // the ledger into the prompt caused the model to diversify away from past recs,
    // growing the ledger every run instead of stabilising it.
    const priorSnapR = await storage.latestSnapshot(listing.appId, listing.country);
    const priorLedgerR = await storage.ledger(listing.appId, listing.country);
    const priorContext = buildPriorContext({
      identity: resolved,
      priorSnapshot: priorSnapR.ok ? priorSnapR.value : null,
      identityFactSheet,
    });

    // Signals computed once — passed to generation (for prompt + normalization)
    // and reused for hashing / persistence below.
    const signals = computeSignals(listing);

    // ── A6: reuse-not-recompute ──────────────────────────────────────────────
    // Hash the exact prompt string BEFORE calling the LLM. If the prior
    // snapshot was produced from the identical prompt (same listing + signals +
    // identity), calling the model again can only introduce noise — skip it and
    // return the cached report. This eliminates the 46→30 score swing on
    // re-audits of unchanged listings and avoids unnecessary Gemini cost.
    const promptHash = createHash('sha256')
      .update(buildAuditPrompt(listing, signals, priorContext))
      .digest('hex')
      .slice(0, 16);

    const priorSnap = priorSnapR.ok ? priorSnapR.value : null;

    // ── B1: vision analysis (before draft generation, so vision scores are
    //    available for assembleReport). getVisionClient() returns a no-op stub
    //    when no API key is set — existing hermetic tests are unaffected.
    // selectVisionResult checks if screenshot/icon URLs match the prior snapshot
    // and returns the cached result if so (zero additional LLM calls).
    const visionClient = getVisionClient();
    const visionResult =
      selectVisionResult(listing, signals, priorSnap) ??
      (await runVision(listing, visionClient));
    // `rubricVersion` is the scoring fingerprint — rubric weights + SCORER_VERSION
    // (scoring/version.ts) — so a weight retune OR a scorer-code bump changes it and
    // invalidates this whole-snapshot cache even when the listing/identity match.
    const listingUnchanged =
      priorSnap !== null &&
      priorSnap.promptHash === promptHash &&
      priorSnap.rubricVersion === RUBRIC_VERSION;

    let report;
    let usedModelId: string;

    if (listingUnchanged) {
      // Nothing changed — reuse the cached report verbatim; no LLM call.
      report = priorSnap!.report;
      usedModelId = priorSnap!.modelId;
    } else {
      // The agent supplies judgement as a validated draft; weighting and the
      // 0-100 total are pure, deterministic code in `assembleReport`.
      let draft;
      try {
        draft = await produceAuditDraft(agent, listing, signals, priorContext);
      } catch (e) {
        throw new Error(
          `The auditor model (${llm.modelId}) failed: ` +
            `${e instanceof Error ? e.message : String(e)}. ` +
            'A more capable model may be needed.',
        );
      }

      // ── A6: per-dimension reuse ─────────────────────────────────────────────
      // For each dimension whose inputs haven't changed since the prior run,
      // splice in the prior score + prose instead of keeping the model's fresh
      // (potentially noisy) output. Only dimensions with changed inputs get new
      // model scores — this eliminates variance for the unchanged parts.
      if (priorSnap) {
        const priorSignals = computeSignals(priorSnap.listing);
        const currentHashes = allDimensionHashes(listing, signals);
        const priorHashes = allDimensionHashes(priorSnap.listing, priorSignals);
        const priorById = new Map(priorSnap.report.dimensions.map((d) => [d.id, d]));

        draft = {
          ...draft,
          dimensions: draft.dimensions.map((d) => {
            if (currentHashes[d.id] === priorHashes[d.id]) {
              const cached = priorById.get(d.id);
              if (cached) {
                return {
                  id: d.id,
                  score: cached.score,
                  confidence: cached.confidence,
                  findings: cached.findings,
                  evidence: cached.evidence,
                };
              }
            }
            return d;
          }),
        };
      }

      report = assembleReport(toSummary(listing), draft, signals, visionResult);
      usedModelId = llm.modelId;
    }

    // ── P1: persist snapshot + identity + ledger; apply memory uplifts ────
    const memo = await persistAudit(storage, {
      listing,
      signals,
      report,
      resolved,
      identityFactSheet,
      rubricVersion: RUBRIC_VERSION,
      promptHash,
      modelId: usedModelId,
      now,
      visionResult, // B1: persist vision result for future reuse
    });

    // Surface what memory observed, honestly, in the report's limitations.
    const notes: string[] = [];
    if (resolved.escalate) {
      notes.push(
        `Identity unconfirmed — the store category ("${listing.primaryGenre ?? 'unknown'}") and the app's apparent function ("${resolved.category}") diverge, and no human confirmation was given. Identity-rewriting recommendations were withheld.`,
      );
    } else if (resolved.source === 'human_confirmed') {
      notes.push(`Identity human-confirmed as "${resolved.category}".`);
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
    if (listingUnchanged) {
      notes.push('Listing unchanged since last audit — scores and recommendations returned from cache (no LLM call).');
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
