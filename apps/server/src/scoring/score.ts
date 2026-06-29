import type { Agent } from '@mastra/core/agent';
import { AuditDraftSchema, type AuditDraft } from '../domain/audit';
import type { AppListing } from '../domain/listing';
import { computeSignals, type ListingSignals } from './signals';
import { buildAuditPrompt, buildRepairPrompt } from './prompt';
import { extractJsonObject } from './extract';
import { normalizeRecommendations } from './candidates';

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

/** Run one plain-text generation and return its text. */
async function generate(agent: Agent, prompt: string): Promise<string> {
  const result = await agent.generate(prompt, { modelSettings: { temperature: 0 } });
  return typeof result.text === 'string' ? result.text : '';
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
  prebuiltPrompt?: string,   // B4: pass the prompt built for hashing
): Promise<AuditDraft> {
  const prompt = prebuiltPrompt ?? buildAuditPrompt(listing, signals, priorContext);

  let attempt = parseDraft(await generate(agent, prompt));
  if (attempt.draft) return normalizeRecommendations(attempt.draft, signals);

  // One repair pass — feed the model its own output and the exact errors.
  attempt = parseDraft(
    await generate(agent, buildRepairPrompt(attempt.raw, attempt.error)),
  );
  if (attempt.draft) return normalizeRecommendations(attempt.draft, signals);

  throw new Error(
    `the model's output did not match the audit schema (${attempt.error})`,
  );
}
