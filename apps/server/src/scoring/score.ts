import type { Agent } from '@mastra/core/agent';
import { AuditDraftSchema, type AuditDraft } from '../domain/audit';
import { INTENT_TAGS } from '../domain/recommendation';
import type { AppListing } from '../domain/listing';
import { computeSignals, type ListingSignals } from './signals';
import { buildAuditPrompt, buildRepairPrompt } from './prompt';
import { extractJsonObject } from './extract';
import { normalizeRecommendations } from './candidates';
import type { VisionResult } from '../vision/types';
import { getGovernor } from '../cost/governor';
import type { CostLedger } from '../cost/ledger';
import { logger } from '../telemetry';
import { currentTenantId } from '../context/tenant';

/**
 * The structured-output strategy: generate → validate → repair.
 *
 * Rather than trust a provider's `response_format` to enforce the schema
 * (not every model honours it), we own it: ask for the JSON, extract and
 * validate it, and on a schema miss make exactly one repair call with the
 * validation errors fed back. Provider-agnostic and robust — and the LLM
 * still only supplies judgement; weighting stays in `aggregate.ts`.
 */

interface ParseAttempt {
  draft?: AuditDraft;
  error: string;
  /** The extracted JSON (or raw text) — fed back into a repair prompt. */
  raw: string;
}

const VALID_INTENTS = new Set<string>(INTENT_TAGS);

/**
 * Strip recommendations with invalid/unknown intents before schema validation.
 * The model occasionally returns intent: 'none' for non-actionable placeholders;
 * removing them is safer than failing the entire audit.
 */
function sanitizeRecs(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.recommendations)) return;
  v.recommendations = v.recommendations.filter(
    (r: unknown) => typeof r === 'object' && r !== null && VALID_INTENTS.has((r as Record<string, unknown>).intent as string),
  );
}

/** Extract, JSON-parse and schema-validate one model response. */
function parseDraft(text: string): ParseAttempt {
  const json = extractJsonObject(text);
  if (!json) {
    return { error: 'no JSON object found in the response', raw: text };
  }

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (e) {
    return { error: `invalid JSON (${(e as Error).message})`, raw: json };
  }

  sanitizeRecs(value);
  const result = AuditDraftSchema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .slice(0, 8)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { error: detail, raw: json };
  }
  return { draft: result.data, error: '', raw: json };
}

/** Run one plain-text generation, return its text, and emit a provider_call log event. */
async function generate(agent: Agent, prompt: string, operation: 'audit' | 'audit-repair' = 'audit', _ledger?: CostLedger): Promise<string> {
  const startMs = Date.now();
  let result: Awaited<ReturnType<typeof agent.generate>>;
  try {
    result = await agent.generate(prompt, { modelSettings: { temperature: 0 } });
  } catch (e) {
    const tenantId = currentTenantId();
    logger.info('provider_call gemini', {
      event: 'provider_call', provider: 'gemini', operation,
      durationMs: Date.now() - startMs, status: 'error',
      errorMessage: e instanceof Error ? e.message : String(e),
      ...(tenantId ? { tenantId } : {}),
    });
    throw e;
  }
  const text = typeof result.text === 'string' ? result.text : '';
  const usage = (result as any).usage as { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined;
  const inputTokens = usage?.promptTokens ?? 0;
  const outputTokens = usage?.completionTokens ?? 0;
  if (_ledger && usage?.promptTokens !== undefined) {
    _ledger.record('scoring', 'capable', { promptTokens: inputTokens, completionTokens: outputTokens });
    _ledger.checkBudget();
  }
  // totalTokens from usage when present; otherwise approximate from char count (÷4).
  const totalTokens = usage?.totalTokens ?? Math.round((prompt.length + text.length) / 4);
  // Blended Gemini Flash rate: ~$0.15/1M tokens.
  const estimatedCostUsd = (totalTokens / 1_000_000) * 0.15;
  getGovernor().recordEstimate(totalTokens, estimatedCostUsd);
  const tenantId = currentTenantId();
  logger.info('provider_call gemini', {
    event: 'provider_call', provider: 'gemini', operation,
    durationMs: Date.now() - startMs, status: 'ok',
    ...(usage?.promptTokens !== undefined ? { inputTokens } : {}),
    ...(usage?.completionTokens !== undefined ? { outputTokens } : {}),
    estimatedCostUsd,
    ...(tenantId ? { tenantId } : {}),
  });
  return text;
}

/**
 * Produce a validated, normalized `AuditDraft` for a listing.
 *
 * `signals` is accepted explicitly so the caller can pass the same instance
 * used for hashing / persistence — avoids recomputing and guarantees the
 * normalization sees the same snapshot the prompt was built from.
 *
 * After generation: `normalizeRecommendations` remaps dimensions to their
 * canonical values and enforces structural existence gates in code, so no
 * rec_key component is a free model choice.
 */
export async function produceAuditDraft(
  agent: Agent,
  listing: AppListing,
  signals: ListingSignals,
  priorContext?: string,
  prebuiltPrompt?: string,     // B4: pass the prompt built for hashing
  visionResult?: VisionResult, // fallback only — prebuiltPrompt already includes vision
  _ledger?: CostLedger,
): Promise<AuditDraft> {
  const prompt = prebuiltPrompt ?? buildAuditPrompt(listing, signals, priorContext, visionResult);

  let attempt = parseDraft(await generate(agent, prompt, 'audit', _ledger));
  if (attempt.draft) return normalizeRecommendations(attempt.draft, signals);

  // One repair pass — feed the model its own output and the exact errors.
  attempt = parseDraft(
    await generate(agent, buildRepairPrompt(attempt.raw, attempt.error), 'audit-repair', _ledger),
  );
  if (attempt.draft) return normalizeRecommendations(attempt.draft, signals);

  throw new Error(
    `the model's output did not match the audit schema (${attempt.error})`,
  );
}
