import { GoogleProvider } from './google';
import { OllamaProvider } from './ollama';
import type { LlmProvider } from './provider';

export type { LlmProvider } from './provider';

const DEFAULT_BASE_URL = 'http://localhost:11434/v1';
const DEFAULT_MODEL = 'gemma3';

const DEFAULT_GOOGLE_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/openai';
const DEFAULT_GOOGLE_MODEL = 'gemini-2.5-flash';

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
    case 'google':
      return new GoogleProvider({
        baseUrl: process.env.LLM_BASE_URL?.trim() || DEFAULT_GOOGLE_BASE_URL,
        model: process.env.LLM_MODEL?.trim() || DEFAULT_GOOGLE_MODEL,
        // Accept the project's LLM_API_KEY, or the standard Gemini env vars
        // (matching the Doppler secret names / AI SDK convention).
        apiKey:
          process.env.LLM_API_KEY?.trim() ||
          process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
          process.env.GEMINI_API_KEY?.trim() ||
          '',
      });
    default:
      throw new Error(
        `Unknown LLM_PROVIDER "${id}". Supported providers: ollama, google.`,
      );
  }
}
