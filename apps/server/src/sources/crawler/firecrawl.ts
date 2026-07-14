import { createHash } from 'node:crypto';
import { fetchJson, SourceError } from '../http';
import type { ListingCrawler, ListingExtras } from './crawler';

/**
 * Firecrawl-backed crawler.
 *
 * Scrapes the rendered App Store page and uses Firecrawl's JSON-extraction
 * mode to pull out the subtitle, promotional text and whether a preview video
 * is present — the three fields Apple's API never returns.
 *
 * Screenshot count uses three strategies, taking the maximum:
 *  1. LLM extraction — asks the model to count visible screenshots
 *  2. Markdown URL count — counts mzstatic.com/image/thumb in the markdown,
 *     minus 1 for the icon. Misses lazy-loaded carousel items.
 *  3. HTML PurpleSource count — counts Apple's screenshot CDN path prefix in
 *     the raw HTML. Screenshots are served from PurpleSource* buckets while
 *     the app icon uses Purple* (no "Source"). This is the most reliable
 *     counter because it's present in the Next.js __NEXT_DATA__ JSON blob even
 *     when the React carousel hasn't rendered. iTunes Lookup API sometimes
 *     returns screenshotUrls:[] for valid published apps (a known Apple quirk),
 *     so this HTML fallback prevents a false zero.
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
          // Cache key must be derived from the App Store URL being scraped, not
          // the Firecrawl endpoint (which is the same POST URL for every app and
          // would cause all audits to share one cache entry).
          call: {
            kind: 'app',
            upstream: 'crawler',
            entityId: createHash('sha256').update(appStoreUrl).digest('hex').slice(0, 16),
          },
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
                'html',
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
      const htmlCount = countScreenshotsFromHtml(res.data?.html ?? '');
      const screenshotCount = Math.min(10, Math.max(llmCount, mdCount, htmlCount));

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
  data?: { json?: Partial<ListingExtras>; markdown?: string; html?: string };
}

/**
 * Count iPhone screenshots from Apple CDN URLs in the Firecrawl markdown.
 * Applies the same portrait aspect-ratio filter (H/W > 1.5) as the HTML
 * counter — markdown image URLs include rendered dimensions (e.g. /300x650bb.jpg)
 * so we can distinguish phone screenshots from iPad and square icons.
 * Falls back to 0 when no portrait URLs are found.
 */
function countScreenshotsFromMarkdown(markdown: string): number {
  if (!markdown) return 0;
  const seen = new Set<string>();
  for (const m of markdown.matchAll(
    /mzstatic\.com\/image\/thumb\/PurpleSource[^/]+\/(v\d+\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9-]+)[^)]*?\/(\d+)x(\d+)bb/g,
  )) {
    const w = parseInt(m[2]!, 10);
    const h = parseInt(m[3]!, 10);
    if (w > 0 && h / w > 1.5) seen.add(m[1]!);
  }
  return seen.size;
}

/**
 * Count unique iPhone screenshots from the raw HTML via Apple's screenshot CDN bucket.
 * Screenshots are hosted under `PurpleSource*` buckets (e.g. PurpleSource211,
 * PurpleSource221) while app icons use `Purple*` without "Source" — so this
 * regex won't match the icon. Each screenshot asset appears many times in the
 * HTML across multiple size variants (1x/2x/3x, different dimensions); we
 * deduplicate by the unique hash portion of the path
 * (`v4/aa/bb/cc/ddddd...`) so each physical screenshot counts once.
 *
 * Aspect-ratio filter (H/W > 1.5): keeps portrait phone screenshots and
 * excludes square app icons from the "Related Apps" section (64x64, 128x128)
 * and landscape/OG images that also appear under PurpleSource buckets.
 * iPad screenshots (e.g. 1366x1024) are landscape or near-square and are
 * also excluded, so the count reflects iPhone slots only.
 */
function countScreenshotsFromHtml(html: string): number {
  if (!html) return 0;
  const seen = new Set<string>();
  // Capture hash + rendered dimensions (WxHbb suffix) in a single pass.
  for (const m of html.matchAll(
    /mzstatic\.com\/image\/thumb\/PurpleSource[^/]+\/(v\d+\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9-]+)[^"]*?\/(\d+)x(\d+)bb/g,
  )) {
    const w = parseInt(m[2]!, 10);
    const h = parseInt(m[3]!, 10);
    // Portrait phone screenshots have H/W > 1.5 (e.g. 300x650 = 2.17).
    // Square icons (64x64, 400x400) and iPad landscape screenshots are excluded.
    if (w > 0 && h / w > 1.5) {
      seen.add(m[1]!);
    }
  }
  return seen.size;
}

const EXTRACTION_PROMPT =
  'This is an Apple App Store product page. Extract exactly four things: ' +
  '(1) "subtitle" — the short tagline shown directly beneath the app name, ' +
  'separate from the developer name; null if there is none. ' +
  '(2) "promotionalText" — the short promotional paragraph shown above the ' +
  'main description; null if absent or indistinguishable from the description. ' +
  '(3) "hasPreviewVideo" — true if the listing\'s media gallery includes a ' +
  'video/app preview (not just screenshots). ' +
  '(4) "screenshotCount" — the number of iPhone screenshots in the media gallery ' +
  '(portrait/tall images only; do not count iPad screenshots, the preview video, ' +
  'or app icons from related-apps sections); return 0 if none are visible.';

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
