import type { createOpenAICompatible } from '@ai-sdk/openai-compatible';

/**
 * The AI SDK chat-model type.
 *
 * Derived from the provider factory itself rather than imported from
 * `@ai-sdk/provider` — several copies of that package coexist in the tree
 * (Mastra bundles its own), and pinning to one causes `LanguageModelV2`
 * version-skew errors. `ReturnType` always matches the version actually used.
 */
export type ChatModel = ReturnType<ReturnType<typeof createOpenAICompatible>>;

/**
 * A pluggable LLM backend — the Strategy seam for the language model.
 *
 * `OllamaProvider` is the only implementation today (it covers both a local
 * Ollama server and Ollama Cloud), but any OpenAI-compatible or bespoke
 * backend can implement this interface and be registered in `getLlmProvider()`
 * — the agent, workflow and routes depend only on this contract.
 */
export interface LlmProvider {
  /** Stable identifier, e.g. "ollama". */
  readonly id: string;
  /** The model id in use — shown in the UI and the audit footer. */
  readonly modelId: string;
  /** The endpoint URL, for diagnostics and error messages. */
  readonly endpoint: string;
  /** The AI SDK model handed to the Mastra agent. */
  model(): ChatModel;
  /** Liveness probe — whether the endpoint is reachable right now. */
  reachable(): Promise<boolean>;
}
