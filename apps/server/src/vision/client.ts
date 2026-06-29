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

export interface VisionClient {
  analyzeScreenshots(input: ScreenshotAnalysisInput): Promise<ScreenshotRawResult>;
  analyzeIcon(input: IconAnalysisInput): Promise<IconRawResult>;
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
  readonly #apiKey: string;
  readonly #modelId: string;
  readonly #endpoint = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

  constructor(apiKey: string, modelId = 'gemini-2.5-flash') {
    this.#apiKey = apiKey;
    this.#modelId = modelId;
  }

  async analyzeScreenshots(input: ScreenshotAnalysisInput): Promise<ScreenshotRawResult> {
    const imageParts = input.screenshotUrls.map((url) => ({
      type: 'image_url' as const,
      image_url: { url },
    }));

    const prompt = `Analyze these App Store screenshots for ASO quality. Return JSON:
{
  "critiques": [{ "slot": 1, "valuePropClarity": "...", "readability": "...", "cohesion": "..." }, ...],
  "competitorComparison": "...",
  "suggestedCoarseScore": 0|5|10
}

Scoring guide:
- 0: Major issues (no value prop, unreadable text, incoherent design)
- 5: Acceptable (clear enough, minor issues)
- 10: Excellent (compelling value prop in first frame, legible text, cohesive design)

Be conservative. Only score 10 if genuinely excellent across all 4 rubric checks.`;

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
      max_tokens: 800,
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

  async analyzeIcon(input: IconAnalysisInput): Promise<IconRawResult> {
    const allIconUrls = [input.iconUrl, ...input.competitorIconUrls];
    const imageParts = allIconUrls.map((url) => ({
      type: 'image_url' as const,
      image_url: { url },
    }));

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
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`Gemini vision API returned invalid JSON: ${raw.slice(0, 200)}`);
    }
  }
}

/**
 * Stub vision client for tests. Returns canned results and tracks callCount.
 */
export class StubVisionClient implements VisionClient {
  callCount = 0;
  readonly #screenshots: ScreenshotRawResult;
  readonly #icon: IconRawResult;

  constructor(screenshots: ScreenshotRawResult, icon: IconRawResult) {
    this.#screenshots = screenshots;
    this.#icon = icon;
  }

  async analyzeScreenshots(_input: ScreenshotAnalysisInput): Promise<ScreenshotRawResult> {
    this.callCount++;
    return this.#screenshots;
  }

  async analyzeIcon(_input: IconAnalysisInput): Promise<IconRawResult> {
    this.callCount++;
    return this.#icon;
  }
}

/**
 * No-op vision client — returned by getVisionClient() when no API key is set.
 * Returns minimal results that keep all existing tests passing.
 */
export class NoOpVisionClient implements VisionClient {
  async analyzeScreenshots(_input: ScreenshotAnalysisInput): Promise<ScreenshotRawResult> {
    return {
      critiques: [],
      competitorComparison: '',
      suggestedCoarseScore: 5,
    };
  }

  async analyzeIcon(_input: IconAnalysisInput): Promise<IconRawResult> {
    return {
      pHashDistance: 32,
      confusable: 'Unknown — vision not available',
      categoryCohesion: 'Unknown — vision not available',
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
