import { OllamaProvider } from './ollama';
import type { LlmProvider } from './provider';

export type { LlmProvider } from './provider';

const DEFAULT_BASE_URL = 'http://localhost:11434/v1';
const DEFAULT_MODEL = 'gemma3';

/**
 * Resolve the active LLM provider from the environment.
 *
 * `LLM_PROVIDER` selects the implementation (default `ollama`). This `switch`
 * is the registry — adding a backend means adding one case and one class,
 * with no change anywhere else.
 */
export function getLlmProvider(): LlmProvider {
  const id = (process.env.LLM_PROVIDER ?? 'ollama').trim().toLowerCase();

  switch (id) {
    case 'ollama':
      return new OllamaProvider({
        baseUrl: process.env.LLM_BASE_URL?.trim() || DEFAULT_BASE_URL,
        model: process.env.LLM_MODEL?.trim() || DEFAULT_MODEL,
        apiKey: process.env.LLM_API_KEY?.trim() || '',
      });
    default:
      throw new Error(
        `Unknown LLM_PROVIDER "${id}". Supported providers: ollama.`,
      );
  }
}
