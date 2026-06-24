import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ChatModel, LlmProvider } from './provider';

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
}
