import { createHash } from 'node:crypto';
import { getGateway } from '../cost/gateway';

export interface EmbeddingProvider {
  /** Embed a text string, returns a float vector. Returns [] on failure. */
  embed(text: string): Promise<number[]>;
  readonly isLive: boolean;
}

/** No-op provider when no API key — never fabricates an embedding. */
export class NoOpEmbeddingProvider implements EmbeddingProvider {
  readonly isLive = false;
  async embed(_text: string): Promise<number[]> { return []; }
}

/** Gemini text-embedding-004 via the generativelanguage REST API. */
export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly isLive = true;
  constructor(private readonly apiKey: string) {}

  async embed(text: string): Promise<number[]> {
    try {
      const res = await getGateway().fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${this.apiKey}`,
        { kind: 'app', upstream: 'embedding' },
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'models/text-embedding-004', content: { parts: [{ text }] } }) },
      );
      if (!res.ok) return [];
      const json = await res.json() as { embedding?: { values?: number[] } };
      return json.embedding?.values ?? [];
    } catch {
      return [];
    }
  }
}

/** Returns Gemini provider if key available, else NoOp. */
export function getEmbeddingProvider(): EmbeddingProvider {
  const key = process.env['GOOGLE_GENERATIVE_AI_API_KEY']?.trim() ||
               process.env['GEMINI_API_KEY']?.trim() || '';
  if (key) return new GeminiEmbeddingProvider(key);
  return new NoOpEmbeddingProvider();
}

/** Cosine similarity in [−1, 1]. Returns 0 for zero-length vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length !== a.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

const THRESHOLD = 0.85;

/**
 * Stable value_key for an 'other'-bucket complaint.
 *
 * - If `embedder.isLive` and there are prior other-themes: embed the text,
 *   compare cosine against each prior, return the first prior's valueKey
 *   when similarity ≥ 0.85 (equivalent complaint → same ledger row).
 * - Otherwise: content-hash of the normalised text (new complaint → new row).
 *   The hash is deterministic so the same complaint always maps to the same key.
 */
export async function resolveOtherThemeKey(
  text: string,
  priorOtherThemes: readonly { text: string; valueKey: string }[],
  embedder: EmbeddingProvider,
): Promise<string> {
  if (embedder.isLive && priorOtherThemes.length > 0) {
    const newEmb = await embedder.embed(text);
    if (newEmb.length > 0) {
      for (const prior of priorOtherThemes) {
        const priorEmb = await embedder.embed(prior.text);
        if (cosineSimilarity(newEmb, priorEmb) >= THRESHOLD) {
          return prior.valueKey;
        }
      }
    }
  }
  // No match or no live embedder — stable content hash
  const norm = text.normalize('NFC').trim().toLowerCase();
  return 'other:' + createHash('sha256').update(norm).digest('hex').slice(0, 16);
}
