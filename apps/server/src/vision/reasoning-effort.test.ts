/**
 * Regression: every GeminiVisionClient call must disable Gemini 2.5 Flash
 * thinking (`reasoning_effort: 'none'`), else thinking tokens exhaust the
 * per-call budget and the JSON truncates to an empty result. B5 fixed only
 * the screenshots call by raising max_tokens; this guards all three uniformly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GeminiVisionClient } from './client';
import { setGateway, PassthroughGateway } from '../cost/gateway';

// Capture the JSON body sent to the vision endpoint; return a canned Gemini reply.
const captured: Record<string, unknown>[] = [];

function reply(json: unknown) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(json) } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

beforeEach(() => {
  captured.length = 0;
  setGateway({
    async fetch(url: string, _call: unknown, init?: RequestInit) {
      // Only capture the chat/completions POST (the vision LLM call), not image fetches.
      if (typeof url === 'string' && url.includes('/chat/completions') && init?.body) {
        captured.push(JSON.parse(String(init.body)));
      }
      return reply({ critiques: [], suggestedCoarseScore: 0, pHashDistance: 10, roles: [] });
    },
  });
});

afterEach(() => setGateway(new PassthroughGateway()));

describe('GeminiVisionClient thinking-token control', () => {
  const client = new GeminiVisionClient('test-key');

  it('analyzeScreenshots sends reasoning_effort:none', async () => {
    await client.analyzeScreenshots({ screenshotUrls: [], competitorFirstFrameUrls: [] });
    expect(captured.at(-1)?.reasoning_effort).toBe('none');
  });

  it('analyzeScreenshotSet sends reasoning_effort:none', async () => {
    await client.analyzeScreenshotSet([]);
    expect(captured.at(-1)?.reasoning_effort).toBe('none');
  });

  it('analyzeIcon sends reasoning_effort:none', async () => {
    await client.analyzeIcon({ iconUrl: 'https://example.com/icon.png', competitorIconUrls: [] });
    expect(captured.at(-1)?.reasoning_effort).toBe('none');
  });
});
