import { fetchJson, SourceError } from '../http';
import type { ListingCrawler, ListingExtras } from './crawler';

/**
 * Firecrawl-backed crawler.
 *
 * Scrapes the rendered App Store page and uses Firecrawl's JSON-extraction
 * mode to pull out the subtitle, promotional text and whether a preview video
 * is present — the three fields Apple's API never returns.
 *
 * Screenshot count is derived from both the LLM extraction AND a pattern
 * count of Apple CDN image URLs in the raw markdown. The LLM extraction alone
 * misses screenshots that are purely image elements (no surrounding text), so
 * the markdown count acts as a cross-check. The higher of the two wins.
 *
 * Apple screenshot URLs contain `mzstatic.com/image/thumb`. The icon is always
 * one of these, so we subtract 1. The result is clamped to [0, 10].
 */
export class FirecrawlCrawler implements ListingCrawler {
  readonly id = 'firecrawl';
  readonly available = true;
  readonly #apiKey: string;

  constructor(apiKey: string) {
    this.#apiKey = apiKey;
  }

  async scrape(appStoreUrl: string): Promise<ListingExtras | null> {
    try {
      const res = await fetchJson<FirecrawlResponse>(
        'https://api.firecrawl.dev/v2/scrape',
        {
          source: 'Firecrawl',
          timeoutMs: 45_000,
          retries: 1,
          init: {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.#apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              url: appStoreUrl,
              onlyMainContent: true,
              formats: [
                'markdown',
                {
                  type: 'json',
                  prompt: EXTRACTION_PROMPT,
                  schema: EXTRACTION_SCHEMA,
                },
              ],
            }),
          },
        },
      );

      const json = res.data?.json;
      if (!json) return null;

      const llmCount =
        typeof json.screenshotCount === 'number'
          ? Math.max(0, Math.round(json.screenshotCount))
          : 0;
      const mdCount = countScreenshotsFromMarkdown(res.data?.markdown ?? '');
      const screenshotCount = Math.min(10, Math.max(llmCount, mdCount));

      return {
        subtitle: normalise(json.subtitle),
        promotionalText: normalise(json.promotionalText),
        hasPreviewVideo: Boolean(json.hasPreviewVideo),
        screenshotCount,
      };
    } catch (e) {
      // Best-effort: a scrape failure degrades the audit, never aborts it.
      if (e instanceof SourceError) return null;
      return null;
    }
  }
}

interface FirecrawlResponse {
  success?: boolean;
  data?: { json?: Partial<ListingExtras>; markdown?: string };
}

/**
 * Count screenshots by matching Apple CDN image URLs in the Firecrawl markdown.
 * Apple serves all app assets (icon + screenshots) from mzstatic.com; the icon
 * is always present exactly once, so we subtract 1. Returns 0 on a clean miss.
 */
function countScreenshotsFromMarkdown(markdown: string): number {
  if (!markdown) return 0;
  const matches = markdown.match(/mzstatic\.com\/image\/thumb/g) ?? [];
  // Subtract 1 for the icon; don't go below 0.
  return Math.max(0, matches.length - 1);
}

const EXTRACTION_PROMPT =
  'This is an Apple App Store product page. Extract exactly four things: ' +
  '(1) "subtitle" — the short tagline shown directly beneath the app name, ' +
  'separate from the developer name; null if there is none. ' +
  '(2) "promotionalText" — the short promotional paragraph shown above the ' +
  'main description; null if absent or indistinguishable from the description. ' +
  '(3) "hasPreviewVideo" — true if the listing\'s media gallery includes a ' +
  'video/app preview (not just screenshots). ' +
  '(4) "screenshotCount" — the total number of screenshots in the media gallery ' +
  '(do not count the preview video); return 0 if none are visible.';

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    subtitle: { type: ['string', 'null'] },
    promotionalText: { type: ['string', 'null'] },
    hasPreviewVideo: { type: 'boolean' },
    screenshotCount: { type: 'number' },
  },
  required: ['subtitle', 'promotionalText', 'hasPreviewVideo', 'screenshotCount'],
} as const;

function normalise(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}
