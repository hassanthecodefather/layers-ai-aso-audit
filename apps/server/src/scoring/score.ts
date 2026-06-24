import type { Agent } from '@mastra/core/agent';
import { AuditDraftSchema, type AuditDraft } from '../domain/audit';
import type { AppListing } from '../domain/listing';
import { computeSignals } from './signals';
import { buildAuditPrompt, buildRepairPrompt } from './prompt';
import { extractJsonObject } from './extract';

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
  const result = await agent.generate(prompt);
  return typeof result.text === 'string' ? result.text : '';
}

/**
 * Produce a validated `AuditDraft` for a listing — generating, validating,
 * and repairing once if the first response doesn't fit the schema.
 */
export async function produceAuditDraft(
  agent: Agent,
  listing: AppListing,
  priorContext?: string,
): Promise<AuditDraft> {
  const prompt = buildAuditPrompt(listing, computeSignals(listing), priorContext);

  let attempt = parseDraft(await generate(agent, prompt));
  if (attempt.draft) return attempt.draft;

  // One repair pass — feed the model its own output and the exact errors.
  attempt = parseDraft(
    await generate(agent, buildRepairPrompt(attempt.raw, attempt.error)),
  );
  if (attempt.draft) return attempt.draft;

  throw new Error(
    `the model's output did not match the audit schema (${attempt.error})`,
  );
}
