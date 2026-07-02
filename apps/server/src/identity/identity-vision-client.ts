/**
 * GeminiIdentityVisionClient — vision client for ID-full (Task B2).
 *
 * Follows the same Gemini OpenAI-compatible endpoint pattern as B1's
 * GeminiVisionClient (vision/client.ts), but is scoped to identity concerns:
 * "Does this app's creative match its function, and who is its audience?"
 *
 * StubIdentityVisionClient — for tests; takes a canned result in constructor.
 * getIdentityVisionClient() — factory from env (uses LLM_API_KEY).
 */

import type { CreativeMatchResult, IdentityVisionClient } from './id-full';
import { getGateway } from '../cost/gateway';

// ── Gemini implementation ─────────────────────────────────────────────────────

export class GeminiIdentityVisionClient implements IdentityVisionClient {
  readonly #apiKey: string;
  readonly #modelId: string;
  readonly #endpoint =
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

  constructor(apiKey: string, modelId = 'gemini-2.5-flash') {
    this.#apiKey = apiKey;
    this.#modelId = modelId;
  }

  async analyzeCreativeMatch(
    iconUrl: string | null,
    firstScreenshotUrl: string | null,
    functionCategory: string,
  ): Promise<CreativeMatchResult> {
    const imageParts: Array<{ type: 'image_url'; image_url: { url: string } }> = [];
    if (iconUrl) {
      imageParts.push({ type: 'image_url', image_url: { url: iconUrl } });
    }
    if (firstScreenshotUrl) {
      imageParts.push({ type: 'image_url', image_url: { url: firstScreenshotUrl } });
    }

    const prompt = `Does this app's creative (icon + first screenshot) match the function of a "${functionCategory}" app? What audience segment does it serve?

Return ONLY a JSON object with no prose:
{
  "creativeMatchesFunction": <true|false>,
  "confidence": "observed" | "inferred",
  "resolvedNiche": "<specific niche, or null if not determinable>",
  "nicheBand": "high" | "medium" | "low",
  "audience": {
    "description": "<one-sentence description of the primary audience>",
    "segments": ["<segment 1>", "<segment 2>", "..."]
  }
}

Guidelines:
- creativeMatchesFunction: true if the icon/screenshot clearly depicts or implies the function category
- confidence: "observed" if directly visible, "inferred" if implied
- nicheBand: "high" if the niche is clearly identifiable, "medium" if inferrable, "low" if unclear
- audience.segments: 2-4 specific audience segments (e.g. "EV owners", "Rivian customers")`;

    const body = {
      model: this.#modelId,
      messages: [
        {
          role: 'user',
          content: [
            ...imageParts,
            { type: 'text', text: prompt },
          ],
        },
      ],
      temperature: 0,
      // 800 tokens: the identity JSON is small (~150 tokens), but gemini-2.5-flash
      // thinking tokens eat into the budget before output begins. 400 was too tight.
      max_tokens: 800,
      response_format: { type: 'json_object' },
    };

    const raw = await this.#call(body);
    return this.#parse(raw);
  }

  async #call(body: unknown): Promise<string> {
    const response = await getGateway().fetch(
      this.#endpoint,
      { kind: 'app', upstream: 'vision' },
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `Gemini identity vision API error ${response.status}: ${text.slice(0, 200)}`,
      );
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('Gemini identity vision API returned empty content');
    }
    return content;
  }

  #tryParseJson(raw: string): unknown {
    try { return JSON.parse(raw); } catch { /* fall through */ }
    for (let i = raw.length - 1; i > 0; i--) {
      if (raw[i] === '}') {
        try { return JSON.parse(raw.slice(0, i + 1)); } catch { /* keep scanning */ }
      }
    }
    console.error(`[identity-vision] Gemini returned unparseable JSON (${raw.length} chars); using safe defaults. Preview: ${raw.slice(0, 120)}`);
    return null;
  }

  #parse(raw: string): CreativeMatchResult {
    let parsed: unknown = this.#tryParseJson(raw);

    const p = (parsed ?? {}) as Record<string, unknown>;

    const nicheBandRaw = p['nicheBand'];
    const nicheBand: CreativeMatchResult['nicheBand'] =
      nicheBandRaw === 'high' || nicheBandRaw === 'medium' || nicheBandRaw === 'low'
        ? nicheBandRaw
        : 'medium';

    const confidenceRaw = p['confidence'];
    const confidence: CreativeMatchResult['confidence'] =
      confidenceRaw === 'observed' || confidenceRaw === 'inferred'
        ? confidenceRaw
        : 'inferred';

    const audienceRaw = p['audience'] as Record<string, unknown> | undefined;
    const audience = {
      description:
        typeof audienceRaw?.['description'] === 'string'
          ? audienceRaw['description']
          : 'General users',
      segments: Array.isArray(audienceRaw?.['segments'])
        ? (audienceRaw['segments'] as unknown[]).filter((s): s is string => typeof s === 'string')
        : [],
    };

    return {
      creativeMatchesFunction: Boolean(p['creativeMatchesFunction']),
      confidence,
      resolvedNiche:
        typeof p['resolvedNiche'] === 'string' ? p['resolvedNiche'] : null,
      nicheBand,
      audience,
    };
  }
}

// ── Stub implementation ───────────────────────────────────────────────────────

/**
 * Stub identity vision client for tests.
 * Takes a canned CreativeMatchResult in constructor.
 */
export class StubIdentityVisionClient implements IdentityVisionClient {
  readonly #result: CreativeMatchResult;

  constructor(result: CreativeMatchResult) {
    this.#result = result;
  }

  async analyzeCreativeMatch(
    _iconUrl: string | null,
    _firstScreenshotUrl: string | null,
    _functionCategory: string,
  ): Promise<CreativeMatchResult> {
    return this.#result;
  }
}

// ── No-op implementation ──────────────────────────────────────────────────────

/**
 * No-op identity vision client — returned when no API key is set.
 * Returns a neutral result that keeps all existing tests passing.
 */
export class NoOpIdentityVisionClient implements IdentityVisionClient {
  async analyzeCreativeMatch(
    _iconUrl: string | null,
    _firstScreenshotUrl: string | null,
    _functionCategory: string,
  ): Promise<CreativeMatchResult> {
    // Return conservative values: creativeMatchesFunction=false prevents spurious
    // de-escalation of a real "ask a human" flag when no API key is configured.
    // confidence='inferred' because no pixels were examined.
    return {
      creativeMatchesFunction: false,
      confidence: 'inferred',
      resolvedNiche: null,
      nicheBand: 'medium',
      audience: { description: 'General users', segments: [] },
    };
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Factory: returns a GeminiIdentityVisionClient when LLM_API_KEY (or
 * GOOGLE_GENERATIVE_AI_API_KEY) is set; otherwise returns a NoOpIdentityVisionClient
 * so existing tests continue to pass without touching any real API.
 */
export function getIdentityVisionClient(): IdentityVisionClient {
  const apiKey =
    process.env['LLM_API_KEY'] ?? process.env['GOOGLE_GENERATIVE_AI_API_KEY'];
  if (!apiKey) {
    return new NoOpIdentityVisionClient();
  }
  return new GeminiIdentityVisionClient(apiKey, 'gemini-2.5-flash');
}
