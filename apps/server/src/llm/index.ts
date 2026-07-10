import { GoogleProvider } from './google';
import type { LlmProvider } from './provider';

export type { LlmProvider } from './provider';

const DEFAULT_GOOGLE_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/openai';
const DEFAULT_GOOGLE_MODEL = 'gemini-3.5-flash';

/**
 * Resolve the active LLM provider from the environment.
 *
 * Gemini is the only backend (Ollama was removed — see the implementation
 * plan, Phase 0). `LLM_PROVIDER` still selects the implementation and defaults
 * to `google`; the `switch` is the registry, so adding a future backend means
 * adding one case and one class, with no change anywhere else.
 */
export function getLlmProvider(tier: 'fast' | 'capable' = 'capable'): LlmProvider {
  const id = (process.env.LLM_PROVIDER ?? 'google').trim().toLowerCase();

  switch (id) {
    case 'google': {
      const capableModel = process.env.LLM_MODEL?.trim() || DEFAULT_GOOGLE_MODEL;
      const fastModel = process.env.LLM_MODEL_FAST?.trim() || capableModel;
      return new GoogleProvider({
        baseUrl: process.env.LLM_BASE_URL?.trim() || DEFAULT_GOOGLE_BASE_URL,
        model: tier === 'fast' ? fastModel : capableModel,
        // Accept the project's LLM_API_KEY, or the standard Gemini env vars
        // (matching the Doppler secret names / AI SDK convention).
        apiKey:
          process.env.LLM_API_KEY?.trim() ||
          process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
          process.env.GEMINI_API_KEY?.trim() ||
          '',
      });
    }
    default:
      throw new Error(
        `Unknown LLM_PROVIDER "${id}". The only supported provider is google.`,
      );
  }
}

/**
 * Startup readiness check: confirm the pinned model actually responds before
 * the first audit hits it. Logs the outcome and returns whether it passed —
 * deliberately non-throwing so a transient blip at boot can't crash the
 * server; the per-run `reachable()` gate in the workflow still fails loudly if
 * the model is down when an audit is requested.
 */
export async function verifyLlmStartup(
  log: (msg: string) => void = (m) => console.warn(m),
): Promise<boolean> {
  const llm = getLlmProvider();
  const check = await llm.verifyModel();
  if (check.ok) {
    log(`[llm] ${check.detail}`);
  } else {
    log(`[llm] startup check FAILED — ${check.detail}`);
  }
  return check.ok;
}
