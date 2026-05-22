import { fetchJson, SourceError } from '../http';
import type { ListingCrawler, ListingExtras } from './crawler';

/**
 * Firecrawl-backed crawler.
 *
 * Scrapes the rendered App Store page and uses Firecrawl's JSON-extraction
 * mode to pull out the subtitle, promotional text and whether a preview video
 * is present — the three fields Apple's API never returns.
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

      return {
        subtitle: normalise(json.subtitle),
        promotionalText: normalise(json.promotionalText),
        hasPreviewVideo: Boolean(json.hasPreviewVideo),
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
  data?: { json?: Partial<ListingExtras> };
}

const EXTRACTION_PROMPT =
  'This is an Apple App Store product page. Extract exactly three things: ' +
  '(1) "subtitle" — the short tagline shown directly beneath the app name, ' +
  'separate from the developer name; null if there is none. ' +
  '(2) "promotionalText" — the short promotional paragraph shown above the ' +
  'main description; null if absent or indistinguishable from the description. ' +
  '(3) "hasPreviewVideo" — true if the listing\'s media gallery includes a ' +
  'video/app preview (not just screenshots).';

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    subtitle: { type: ['string', 'null'] },
    promotionalText: { type: ['string', 'null'] },
    hasPreviewVideo: { type: 'boolean' },
  },
  required: ['subtitle', 'promotionalText', 'hasPreviewVideo'],
} as const;

function normalise(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}
