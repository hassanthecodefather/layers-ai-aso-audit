import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ChatModel, LlmProvider } from './provider';

export interface OllamaConfig {
  /** OpenAI-compatible base URL — local or https://ollama.com/v1 for Cloud. */
  baseUrl: string;
  model: string;
  /** Empty for a local server; required for Ollama Cloud. */
  apiKey: string;
}

/**
 * Ollama — local (`http://localhost:11434/v1`) or Ollama Cloud
 * (`https://ollama.com/v1`).
 *
 * Both speak the OpenAI-compatible protocol, so one implementation serves
 * both; the base URL and API key decide which. Reached through the AI SDK's
 * `openai-compatible` provider, which Mastra accepts directly as an agent
 * model.
 */
export class OllamaProvider implements LlmProvider {
  readonly id = 'ollama';
  readonly modelId: string;
  readonly endpoint: string;
  readonly #apiKey: string;

  constructor(config: OllamaConfig) {
    this.endpoint = config.baseUrl.replace(/\/+$/, '');
    this.modelId = config.model;
    this.#apiKey = config.apiKey;
  }

  model(): ChatModel {
    const provider = createOpenAICompatible({
      name: 'ollama',
      baseURL: this.endpoint,
      // A local server ignores the key; Ollama Cloud requires it.
      apiKey: this.#apiKey || 'ollama',
    });
    return provider(this.modelId);
  }

  async reachable(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${this.endpoint}/models`, {
        signal: controller.signal,
        headers: this.#apiKey
          ? { Authorization: `Bearer ${this.#apiKey}` }
          : {},
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
