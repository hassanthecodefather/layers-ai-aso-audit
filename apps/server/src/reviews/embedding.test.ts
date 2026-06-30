/**
 * Unit tests for the embedding module (src/reviews/embedding.ts).
 * All tests run without network — stub embedders only.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  cosineSimilarity,
  resolveOtherThemeKey,
  NoOpEmbeddingProvider,
} from './embedding';

// ── cosineSimilarity ──────────────────────────────────────────────────────────

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical unit vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0);
  });

  it('returns 0 for zero-length (empty) vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([], [1, 0])).toBe(0);
  });

  it('returns 0 when vectors have different lengths', () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });

  it('returns ~0.85+ for near-identical vectors', () => {
    // [1,0,0] vs [0.9,0.44,0]: cosine ≈ 0.9 / (1 * sqrt(0.81+0.1936)) ≈ 0.9
    const sim = cosineSimilarity([1, 0, 0], [0.9, 0.44, 0]);
    expect(sim).toBeGreaterThanOrEqual(0.85);
  });

  it('returns negative for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0);
  });
});

// ── resolveOtherThemeKey ──────────────────────────────────────────────────────

describe('resolveOtherThemeKey', () => {
  it('returns content hash when embedder is NoOp (isLive=false)', async () => {
    const key = await resolveOtherThemeKey('some complaint', [], new NoOpEmbeddingProvider());
    expect(key).toMatch(/^other:[0-9a-f]{16}$/);
  });

  it('same text always produces same content hash (determinism)', async () => {
    const k1 = await resolveOtherThemeKey('map broken', [], new NoOpEmbeddingProvider());
    const k2 = await resolveOtherThemeKey('map broken', [], new NoOpEmbeddingProvider());
    expect(k1).toBe(k2);
  });

  it('different texts produce different content hashes', async () => {
    const k1 = await resolveOtherThemeKey('map broken', [], new NoOpEmbeddingProvider());
    const k2 = await resolveOtherThemeKey('login fails', [], new NoOpEmbeddingProvider());
    expect(k1).not.toBe(k2);
  });

  it('normalises text before hashing (trim + lowercase + NFC)', async () => {
    const k1 = await resolveOtherThemeKey('  Map Broken  ', [], new NoOpEmbeddingProvider());
    const k2 = await resolveOtherThemeKey('map broken', [], new NoOpEmbeddingProvider());
    expect(k1).toBe(k2);
  });

  it('returns prior valueKey when cosine >= 0.85 (embedding match)', async () => {
    // Stub embedder: new text → [1,0,0], prior text → [0.9,0.44,0] (cosine ≈ 0.9)
    const stubEmb = { isLive: true, embed: vi.fn()
      .mockResolvedValueOnce([1, 0, 0])        // new complaint
      .mockResolvedValueOnce([0.9, 0.44, 0]),  // prior complaint (cosine ~0.9 with [1,0,0])
    };
    const priors = [{ text: 'prior complaint text', valueKey: 'other:abc123def456ab12' }];
    const key = await resolveOtherThemeKey('new complaint text', priors, stubEmb);
    expect(key).toBe('other:abc123def456ab12'); // matched prior
  });

  it('returns new hash when cosine < 0.85 (distinct complaint)', async () => {
    const stubEmb = { isLive: true, embed: vi.fn()
      .mockResolvedValueOnce([1, 0, 0])   // new complaint
      .mockResolvedValueOnce([0, 1, 0]),  // prior complaint (cosine = 0, orthogonal)
    };
    const priors = [{ text: 'prior text', valueKey: 'other:abc123def456ab12' }];
    const key = await resolveOtherThemeKey('distinct complaint', priors, stubEmb);
    expect(key).toMatch(/^other:[0-9a-f]{16}$/);
    expect(key).not.toBe('other:abc123def456ab12');
  });

  it('falls back to content hash when live embedder returns empty vector', async () => {
    const stubEmb = { isLive: true, embed: vi.fn().mockResolvedValueOnce([]) };
    const priors = [{ text: 'prior text', valueKey: 'other:abc123def456ab12' }];
    const key = await resolveOtherThemeKey('some complaint', priors, stubEmb);
    expect(key).toMatch(/^other:[0-9a-f]{16}$/);
  });

  it('skips embedding comparison when priorOtherThemes is empty even if embedder is live', async () => {
    const stubEmb = { isLive: true, embed: vi.fn() };
    const key = await resolveOtherThemeKey('some complaint', [], stubEmb);
    // No embed calls should be made
    expect(stubEmb.embed).not.toHaveBeenCalled();
    expect(key).toMatch(/^other:[0-9a-f]{16}$/);
  });
});
