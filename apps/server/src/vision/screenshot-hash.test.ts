import { describe, it, expect } from 'vitest';
import { computeScreenshotHash } from './screenshot-hash';

describe('computeScreenshotHash', () => {
  it('returns null for empty array', () => {
    expect(computeScreenshotHash([])).toBeNull();
  });

  it('same URLs in different order produce the same hash', () => {
    const a = computeScreenshotHash(['https://example.com/a.png', 'https://example.com/b.png']);
    const b = computeScreenshotHash(['https://example.com/b.png', 'https://example.com/a.png']);
    expect(a).toBe(b);
    expect(a).not.toBeNull();
  });

  it('different URL set produces a different hash', () => {
    const a = computeScreenshotHash(['https://example.com/a.png']);
    const b = computeScreenshotHash(['https://example.com/c.png']);
    expect(a).not.toBe(b);
  });

  it('adding one URL changes the hash', () => {
    const a = computeScreenshotHash(['https://example.com/a.png']);
    const b = computeScreenshotHash(['https://example.com/a.png', 'https://example.com/new.png']);
    expect(a).not.toBe(b);
  });
});
