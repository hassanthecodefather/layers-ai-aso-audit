/**
 * VisionClient interface + implementations:
 *  - GeminiVisionClient: calls Gemini's OpenAI-compatible multimodal endpoint
 *  - StubVisionClient: deterministic stub for tests (tracks callCount)
 *  - NoOpVisionClient: returns empty/minimal results when no API key is set
 */

export interface ScreenshotAnalysisInput {
  screenshotUrls: string[];
  competitorFirstFrameUrls: string[]; // top 3 competitor icons/first screenshots
}

export interface IconAnalysisInput {
  iconUrl: string;
  competitorIconUrls: string[]; // for pHash comparison
}

export interface ScreenshotRawResult {
  critiques: Array<{
    slot: number;
    valuePropClarity: string;
    readability: string;
    cohesion: string;
  }>;
  competitorComparison: string;
  suggestedCoarseScore: 0 | 5 | 10;
}

export interface IconRawResult {
  pHashDistance: number;
  confusable: string;
  categoryCohesion: string;
}

export interface ScreenshotSetRawResult {
  roles: Array<{ slot: number; roleTag: string; valueProp: string }>;
  hasDuplicateMessages: boolean;
  duplicateSlots: number[];
  isPanoramicSet: boolean;
  treatmentCount: number;
  /** 1-indexed; null if already in slots 1-3 or if panoramic */
  strongestSlotForPromotion: number | null;
}

export interface VisionClient {
  /** True for real API clients (Gemini); false for stubs/no-op. Used in analyze.ts to label confidence correctly. */
  readonly isLive: boolean;
  analyzeScreenshots(input: ScreenshotAnalysisInput): Promise<ScreenshotRawResult>;
  analyzeIcon(input: IconAnalysisInput): Promise<IconRawResult>;
  analyzeScreenshotSet(urls: string[]): Promise<ScreenshotSetRawResult>;
}

/**
 * Gemini Vision Client — calls Gemini's OpenAI-compatible endpoint with
 * image_url content parts.
 *
 * Endpoint: https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
 * Temperature: 0 (A6 determinism)
 * Response format: JSON object
 */
export class GeminiVisionClient implements VisionClient {
  readonly isLive = true;
  readonly #apiKey: string;
  readonly #modelId: string;
  readonly #endpoint = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

  constructor(apiKey: string, modelId = 'gemini-2.5-flash') {
    this.#apiKey = apiKey;
    this.#modelId = modelId;
  }

  async analyzeScreenshots(input: ScreenshotAnalysisInput): Promise<ScreenshotRawResult> {
    // Fetch images ourselves: Apple's CDN blocks Gemini's servers, so sending
    // URLs directly results in empty critiques. Base64 data URLs bypass this.
    const imageParts = await Promise.all(
      input.screenshotUrls.map(async (url) => ({
        type: 'image_url' as const,
        image_url: { url: await this.#fetchAsDataUrl(url) },
      })),
    );

    const prompt = `Analyze these App Store screenshots for ASO quality. Return JSON only — no prose.
IMPORTANT: Keep each critique field to ONE short phrase (max 10 words). Brevity is required.
{
  "critiques": [{ "slot": 1, "valuePropClarity": "one phrase", "readability": "one phrase", "cohesion": "one phrase" }, ...],
  "competitorComparison": "one sentence",
  "suggestedCoarseScore": 0|5|10
}

Scoring: 0=poor, 5=acceptable, 10=excellent. Be conservative; reserve 10 for genuinely excellent.`;

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
      // 8000 tokens: Gemini 2.5 Flash uses thinking tokens before output begins,
      // leaving fewer than expected for JSON. 8000 ensures the full critiques
      // array fits even with thinking budget consumed.
      max_tokens: 8000,
      response_format: { type: 'json_object' },
    };

    const raw = await this.#call(body);
    const parsed = this.#parseJson(raw) as {
      critiques?: Array<{ slot: number; valuePropClarity: string; readability: string; cohesion: string }>;
      competitorComparison?: string;
      suggestedCoarseScore?: number;
    };

    const score = parsed.suggestedCoarseScore;
    const coarseScore: 0 | 5 | 10 =
      score === 0 ? 0 : score === 5 ? 5 : score === 10 ? 10 : 5;

    return {
      critiques: parsed.critiques ?? [],
      competitorComparison: parsed.competitorComparison ?? '',
      suggestedCoarseScore: coarseScore,
    };
  }

  async analyzeScreenshotSet(urls: string[]): Promise<ScreenshotSetRawResult> {
    const imageParts = await Promise.all(
      urls.map(async (url) => ({
        type: 'image_url' as const,
        image_url: { url: await this.#fetchAsDataUrl(url) },
      })),
    );

    const prompt = `Analyze these App Store screenshots as a complete set. Return JSON:
{
  "roles": [{ "slot": 1, "roleTag": "hero|feature-X|social-proof|cta", "valueProp": "..." }, ...],
  "hasDuplicateMessages": true|false,
  "duplicateSlots": [1, 2],
  "isPanoramicSet": true|false,
  "treatmentCount": <number of distinct creative treatments>,
  "strongestSlotForPromotion": <1-indexed slot or null>
}

Panoramic detection: Do these screenshots form a continuous panoramic strip (where the right edge of one panel seamlessly connects to the left edge of the next)? If so, set isPanoramicSet=true. Reordering panoramic panels would break the visual continuity, so set strongestSlotForPromotion=null for panoramic sets.

PPO treatment count: How many distinct creative treatments (different hero images, headlines, background colours) are present?

If hasDuplicateMessages is true, list which slot numbers repeat the same message in duplicateSlots.

strongestSlotForPromotion: Which slot (1-indexed) would benefit most from being promoted into the first 3 search-visible positions? Set to null if already in slots 1-3 or if panoramic.`;

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
      max_tokens: 1500,
      response_format: { type: 'json_object' },
    };

    const raw = await this.#call(body);
    const parsed = this.#parseJson(raw) as {
      roles?: Array<{ slot: number; roleTag: string; valueProp: string }>;
      hasDuplicateMessages?: boolean;
      duplicateSlots?: number[];
      isPanoramicSet?: boolean;
      treatmentCount?: number;
      strongestSlotForPromotion?: number | null;
    };

    return {
      roles: parsed.roles ?? [],
      hasDuplicateMessages: parsed.hasDuplicateMessages ?? false,
      duplicateSlots: parsed.duplicateSlots ?? [],
      isPanoramicSet: parsed.isPanoramicSet ?? false,
      treatmentCount: typeof parsed.treatmentCount === 'number' ? parsed.treatmentCount : 1,
      strongestSlotForPromotion: parsed.strongestSlotForPromotion ?? null,
    };
  }

  async analyzeIcon(input: IconAnalysisInput): Promise<IconRawResult> {
    const allIconUrls = [input.iconUrl, ...input.competitorIconUrls];
    const imageParts = await Promise.all(
      allIconUrls.map(async (url) => ({
        type: 'image_url' as const,
        image_url: { url: await this.#fetchAsDataUrl(url) },
      })),
    );

    const prompt = `The first image is the app icon. The remaining images (if any) are competitor icons.
Analyze the app icon for ASO quality. Return JSON:
{
  "pHashDistance": <number 0-64, 0=identical to competitor>,
  "confusable": "<whether this icon could be confused with a competitor>",
  "categoryCohesion": "<whether the icon fits the app category>"
}`;

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
      max_tokens: 400,
      response_format: { type: 'json_object' },
    };

    const raw = await this.#call(body);
    const parsed = this.#parseJson(raw) as {
      pHashDistance?: number;
      confusable?: string;
      categoryCohesion?: string;
    };

    return {
      pHashDistance: typeof parsed.pHashDistance === 'number' ? parsed.pHashDistance : 32,
      confusable: parsed.confusable ?? 'Unknown',
      categoryCohesion: parsed.categoryCohesion ?? 'Unknown',
    };
  }

  /** Fetch a remote image and return it as a base64 data URL. */
  async #fetchAsDataUrl(url: string): Promise<string> {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ASO-Audit/1.0)' },
      });
      if (!res.ok) {
        console.warn(`[vision] failed to fetch image ${url} (${res.status}); Gemini will receive original URL`);
        return url;
      }
      const contentType = res.headers.get('content-type') ?? 'image/jpeg';
      const buffer = await res.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      return `data:${contentType};base64,${base64}`;
    } catch (err) {
      console.warn(`[vision] network error fetching image ${url}: ${String(err)}; Gemini will receive original URL`);
      return url;
    }
  }

  async #call(body: unknown): Promise<string> {
    const response = await fetch(this.#endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.#apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `Gemini vision API error ${response.status}: ${text.slice(0, 200)}`,
      );
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('Gemini vision API returned empty content');
    }
    return content;
  }

  #parseJson(raw: string): unknown {
    // Direct parse first (fast path).
    try {
      return JSON.parse(raw);
    } catch {
      // Gemini sometimes truncates mid-JSON when the response hits a token limit.
      // Try to recover the largest valid object prefix before giving up.
      for (let i = raw.length - 1; i > 0; i--) {
        if (raw[i] === '}') {
          try { return JSON.parse(raw.slice(0, i + 1)); } catch { /* keep scanning */ }
        }
      }
      // Log and return empty object so the caller's ?? defaults kick in
      // rather than crashing the whole audit step.
      console.error(`[vision] Gemini returned unparseable JSON (${raw.length} chars); falling back to empty result. Preview: ${raw.slice(0, 120)}`);
      return {};
    }
  }
}

/**
 * Stub vision client for tests. Returns canned results and tracks callCount.
 */
export class StubVisionClient implements VisionClient {
  readonly isLive = true;
  callCount = 0;
  readonly #screenshots: ScreenshotRawResult;
  readonly #icon: IconRawResult;
  readonly #screenshotSet: ScreenshotSetRawResult;

  constructor(
    screenshots: ScreenshotRawResult,
    icon: IconRawResult,
    screenshotSet?: ScreenshotSetRawResult,
  ) {
    this.#screenshots = screenshots;
    this.#icon = icon;
    this.#screenshotSet = screenshotSet ?? {
      roles: [],
      hasDuplicateMessages: false,
      duplicateSlots: [],
      isPanoramicSet: false,
      treatmentCount: 1,
      strongestSlotForPromotion: null,
    };
  }

  async analyzeScreenshots(_input: ScreenshotAnalysisInput): Promise<ScreenshotRawResult> {
    this.callCount++;
    return this.#screenshots;
  }

  async analyzeIcon(_input: IconAnalysisInput): Promise<IconRawResult> {
    this.callCount++;
    return this.#icon;
  }

  async analyzeScreenshotSet(_urls: string[]): Promise<ScreenshotSetRawResult> {
    this.callCount++;
    return this.#screenshotSet;
  }
}

/**
 * No-op vision client — returned by getVisionClient() when no API key is set.
 * Returns minimal results that keep all existing tests passing.
 */
export class NoOpVisionClient implements VisionClient {
  readonly isLive = false;
  async analyzeScreenshots(_input: ScreenshotAnalysisInput): Promise<ScreenshotRawResult> {
    return {
      critiques: [],
      competitorComparison: '',
      // Placeholder midpoint (scale: 0 | 5 | 10) — neither good nor bad; used
      // when no API key is configured so tests pass without a real vision call.
      suggestedCoarseScore: 5,
    };
  }

  async analyzeIcon(_input: IconAnalysisInput): Promise<IconRawResult> {
    return {
      // Placeholder midpoint (scale: 0–64 Hamming distance) — 32 represents
      // "no comparison done"; used when no API key is configured.
      pHashDistance: 32,
      confusable: 'Unknown — vision not available',
      categoryCohesion: 'Unknown — vision not available',
    };
  }

  async analyzeScreenshotSet(_urls: string[]): Promise<ScreenshotSetRawResult> {
    return {
      roles: [],
      hasDuplicateMessages: false,
      duplicateSlots: [],
      isPanoramicSet: false,
      treatmentCount: 1,
      strongestSlotForPromotion: null,
    };
  }
}

/**
 * Factory: returns a GeminiVisionClient when LLM_API_KEY (or
 * GOOGLE_GENERATIVE_AI_API_KEY) is set; otherwise returns a NoOpVisionClient
 * so existing tests continue to pass without touching any real API.
 */
export function getVisionClient(): VisionClient {
  const apiKey =
    process.env['LLM_API_KEY'] ?? process.env['GOOGLE_GENERATIVE_AI_API_KEY'];
  if (!apiKey) {
    return new NoOpVisionClient();
  }
  return new GeminiVisionClient(apiKey, 'gemini-2.5-flash');
}
