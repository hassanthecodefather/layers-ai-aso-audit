import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ChatModel, LlmProvider, ModelCheck } from './provider';

export interface GoogleConfig {
  /** OpenAI-compatible base URL for Gemini. */
  baseUrl: string;
  model: string;
  /** Required — a Google AI Studio API key (starts with "AIza"). */
  apiKey: string;
}

/**
 * Google Gemini, via its OpenAI-compatible endpoint
 * (`https://generativelanguage.googleapis.com/v1beta/openai`).
 *
 * Gemini speaks the OpenAI protocol, so the `@ai-sdk/openai-compatible` client
 * the project already uses serves it directly — no extra dependency, and the
 * model type stays identical to every other provider's, avoiding the
 * `LanguageModelV2` version-skew noted in `provider.ts`.
 */
export class GoogleProvider implements LlmProvider {
  readonly id = 'google';
  readonly modelId: string;
  readonly endpoint: string;
  readonly #apiKey: string;

  constructor(config: GoogleConfig) {
    this.endpoint = config.baseUrl.replace(/\/+$/, '');
    this.modelId = config.model;
    this.#apiKey = config.apiKey;
  }

  model(): ChatModel {
    const provider = createOpenAICompatible({
      name: 'google',
      baseURL: this.endpoint,
      apiKey: this.#apiKey,
    });
    return provider(this.modelId);
  }

  async reachable(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${this.endpoint}/models`, {
        signal: controller.signal,
        headers: { Authorization: `Bearer ${this.#apiKey}` },
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Prove the pinned model answers by asking it for a single token over the
   * OpenAI-compatible `/chat/completions` route. A direct `fetch` (rather than
   * the AI SDK) keeps this dependency-free and identical in style to
   * `reachable()`, and pins the check to `this.modelId` specifically — a
   * reachable endpoint with a mistyped model id still fails here, which is the
   * whole point.
   */
  async verifyModel(): Promise<ModelCheck> {
    if (!this.#apiKey) {
      return { ok: false, detail: 'No Gemini API key configured (LLM_API_KEY).' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(`${this.endpoint}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.modelId,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return {
          ok: false,
          detail: `Gemini model "${this.modelId}" returned ${res.status} ${
            res.statusText
          }${body ? `: ${body.slice(0, 200)}` : ''}`,
        };
      }
      return { ok: true, detail: `Gemini model "${this.modelId}" responded.` };
    } catch (e) {
      return {
        ok: false,
        detail: `Couldn't reach Gemini model "${this.modelId}" at ${
          this.endpoint
        }: ${e instanceof Error ? e.message : String(e)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
