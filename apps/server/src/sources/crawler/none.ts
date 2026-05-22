import type { ListingCrawler } from './crawler';

/**
 * The no-op crawler — used when no scraper is configured.
 *
 * A Null Object: callers treat every crawler the same and never branch on
 * "is a crawler configured?". The audit simply proceeds on iTunes data alone,
 * with the page-only dimensions flagged unavailable.
 */
export class NullCrawler implements ListingCrawler {
  readonly id = 'none';
  readonly available = false;

  async scrape(): Promise<null> {
    return null;
  }
}
