import { FirecrawlCrawler } from './firecrawl';
import { NullCrawler } from './none';
import type { ListingCrawler } from './crawler';

export type { ListingCrawler, ListingExtras } from './crawler';

/**
 * Resolve the active crawler from the environment.
 *
 * Firecrawl when a `FIRECRAWL_API_KEY` is set, the no-op `NullCrawler`
 * otherwise. To add another scraper, implement `ListingCrawler` and extend
 * the selection here — nothing downstream changes.
 */
export function getCrawler(): ListingCrawler {
  const firecrawlKey = process.env.FIRECRAWL_API_KEY?.trim();
  if (firecrawlKey) return new FirecrawlCrawler(firecrawlKey);
  return new NullCrawler();
}
