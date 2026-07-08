import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import type { AppListing } from '../../domain/listing';
import type { IdentityVersion } from '../../domain/identity';
import { extractIdentitySignals, type RawIdentitySignals } from '../../identity/signals';
import {
  resolveIdentity,
  type IdentityClassification,
  type ResolvedIdentity,
} from '../../identity/resolve';
import { getWebSearch, type WebSearchProbe } from '../../sources/websearch/websearch';
import { getLlmProvider } from '../../llm';
import { extractJsonObject } from '../../scoring/extract';
import { newId } from '../../memory/ids';
import { logger } from '../../telemetry';

/**
 * ID-lite resolution (spec ID, Build Appendix §G). Composes the three pieces:
 *   1. deterministic signal extraction (pure, `identity/signals.ts`),
 *   2. a function classification from the model over the fact sheet, and
 *   3. the pure tally → band → escalation resolver (`identity/resolve.ts`).
 *
 * The model only *interprets* a grounded fact sheet into "what the app does";
 * it never sets the band — that is the pure resolver's job, so the §F
 * acceptance test stays deterministic.
 */

/** A function that turns the identity fact sheet into a function classification. */
export type IdentityClassifier = (
  factSheet: string,
) => Promise<IdentityClassification>;

const ClassificationSchema = z.object({
  functionCategory: z.string().min(1),
  functionNiche: z.string().nullable(),
  functionTerms: z.array(z.string()).default([]),
});

const CLASSIFIER_INSTRUCTIONS = `You are an app-identity classifier. Given signals about an iOS app, determine what the app actually DOES — its function — independent of its declared App Store category.

When web evidence is provided before the fact sheet, treat it as independent third-party context about what the app does. Weight it alongside the store signals — it can resolve ambiguity the metadata alone cannot.

Reply with ONLY a JSON object, no prose:
{
  "functionCategory": "<the app's true function as a short category phrase, e.g. 'Electric vehicle companion'>",
  "functionNiche": "<the specific niche, or null if you cannot tell without seeing the screenshots>",
  "functionTerms": ["<3-6 lowercase vocabulary words a user of THIS function would use in a review>"]
}

Ground your answer in the signals, not world knowledge alone. World knowledge is a hint that must be corroborated by a cited signal.`;

/** Build the identity fact sheet handed to the classifier (and, later, the scorer). */
export function buildFactSheet(s: RawIdentitySignals): string {
  const reviewExcerpt = s.reviewCorpus.slice(0, 1500);
  return [
    `Developer: ${s.developer}`,
    `Bundle id org segment: ${s.bundleOrg ?? '(vanity / none)'}`,
    `Marketing domain: ${s.marketingDomain ?? '(none provided)'}`,
    `Declared store category: ${s.storeCategory}`,
    `Store genres: ${s.storeGenres.join(', ') || '(none)'}`,
    `Review sample size: ${s.reviewCount}`,
    `Review vocabulary (excerpt): ${reviewExcerpt || '(no reviews)'}`,
  ].join('\n');
}

const SNIPPET_SOURCES_MAX = 3;

/** Prepend a web-evidence block to the fact sheet when snippets are available. */
export function buildClassifierInput(factSheet: string, probe: WebSearchProbe | undefined): string {
  if (!probe || probe.state !== 'corroborated') return factSheet;
  const snippets = probe.sources
    .filter(s => s.snippet.trim().length > 0)
    .slice(0, SNIPPET_SOURCES_MAX);
  if (snippets.length === 0) return factSheet;
  const block = snippets
    .map((s, i) => {
      let host: string;
      try { host = new URL(s.url).hostname; } catch { host = s.url; }
      return `[${i + 1}] "${s.title}" (${host}):\n${s.snippet}`;
    })
    .join('\n\n');
  return `Web evidence (independent off-store sources):\n${block}\n\n---\n\n${factSheet}`;
}

let classifierAgent: Agent | null = null;
function getClassifierAgent(): Agent {
  if (!classifierAgent) {
    classifierAgent = new Agent({
      id: 'identity-classifier',
      name: 'Identity Classifier',
      instructions: CLASSIFIER_INSTRUCTIONS,
      model: getLlmProvider().model(),
    });
  }
  return classifierAgent;
}

/** The "couldn't classify" fallback — a provisional, low-corroboration identity. */
const UNKNOWN_CLASSIFICATION: IdentityClassification = {
  functionCategory: 'Unknown',
  functionNiche: null,
  functionTerms: [],
};

/**
 * Parse a model response into a classification, failing safe on ANY malformed
 * output. `extractJsonObject` only brace-matches, so the substring can still be
 * invalid JSON (trailing commas, single quotes, unquoted keys) — the parse must
 * be guarded or the whole identify step throws instead of degrading gracefully.
 */
export function parseClassificationText(text: string): IdentityClassification {
  const json = extractJsonObject(text);
  if (!json) {
    console.warn('[identity-classifier] no JSON object found in response — falling back to UNKNOWN');
    return UNKNOWN_CLASSIFICATION;
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (e) {
    console.warn('[identity-classifier] JSON.parse failed:', e, '— raw excerpt:', json.slice(0, 200));
    return UNKNOWN_CLASSIFICATION;
  }
  const parsed = ClassificationSchema.safeParse(value);
  if (!parsed.success) {
    console.warn('[identity-classifier] schema validation failed:', parsed.error.message);
    return UNKNOWN_CLASSIFICATION;
  }
  return parsed.data;
}

/** The production classifier: one Gemini generation over the fact sheet. */
export const geminiClassifier: IdentityClassifier = async (factSheet) => {
  const llm = getLlmProvider();
  if (!(await llm.reachable())) {
    throw new Error(
      `Couldn't reach Gemini at ${llm.endpoint} during identity resolution. ` +
      'Check that LLM_API_KEY is set in .env and the network is up.',
    );
  }
  const agent = getClassifierAgent();
  const startMs = Date.now();
  let result: Awaited<ReturnType<typeof agent.generate>>;
  try {
    result = await agent.generate(factSheet, { modelSettings: { temperature: 0 } });
  } catch (e) {
    logger.info({
      event: 'provider_call', provider: 'gemini', operation: 'classify',
      durationMs: Date.now() - startMs, status: 'error',
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
  const usage = (result as any).usage as { promptTokens?: number; completionTokens?: number } | undefined;
  logger.info({
    event: 'provider_call', provider: 'gemini', operation: 'classify',
    durationMs: Date.now() - startMs, status: 'ok',
    ...(usage?.promptTokens !== undefined ? { inputTokens: usage.promptTokens } : {}),
    ...(usage?.completionTokens !== undefined ? { outputTokens: usage.completionTokens } : {}),
  });
  return parseClassificationText(typeof result.text === 'string' ? result.text : '');
};

/** Resolve ID-lite identity for a listing (signals + classify + tally→band). */
export async function resolveAppIdentity(
  listing: AppListing,
  classify: IdentityClassifier = geminiClassifier,
  opts: { fetchedAt?: string } = {},
): Promise<ResolvedIdentity> {
  const signals = extractIdentitySignals(listing);
  const factSheet = buildFactSheet(signals);
  // Probe first so the classifier receives web evidence as grounding context
  // in its first (and only) generation — snippets resolve category ambiguity
  // that metadata alone cannot.
  const probeResult = await getWebSearch().probe(factSheet);
  const footprintProbe = probeResult.ok ? probeResult.value : undefined;
  const classifierInput = buildClassifierInput(factSheet, footprintProbe);
  const classification = await classify(classifierInput);
  return resolveIdentity(signals, classification, { fetchedAt: opts.fetchedAt, footprintProbe });
}

/** Stamp a resolved identity into an append-ready `IdentityVersion` row (stage=lite). */
export function toIdentityVersion(
  appId: string,
  country: string,
  resolved: ResolvedIdentity,
  opts: { version: number; createdAt: string; source?: IdentityVersion['source'] },
): IdentityVersion {
  return {
    id: newId('idv'),
    appId,
    country,
    version: opts.version,
    stage: 'lite',
    category: resolved.category,
    categoryBand: resolved.categoryBand,
    niche: resolved.niche,
    nicheBand: resolved.nicheBand,
    audience: null,
    tally: resolved.tally,
    divergence: resolved.divergence,
    escalate: resolved.escalate,
    // The resolution itself carries the tier (`human_confirmed` after an
    // override); an explicit opts.source still wins if a caller forces it.
    source: opts.source ?? resolved.source ?? 'resolved',
    overrodeEvidence: resolved.overrodeEvidence ?? null,
    createdAt: opts.createdAt,
  };
}
