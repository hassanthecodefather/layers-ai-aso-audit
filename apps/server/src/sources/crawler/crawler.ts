/**
 * Page-level listing fields that Apple's iTunes API does not expose — they
 * exist only on the rendered App Store web page.
 */
export interface ListingExtras {
  /** The ≤30-char line shown under the app name. */
  subtitle: string | null;
  /** The ≤170-char editable line above the description. */
  promotionalText: string | null;
  /** Whether the listing leads with an app preview video. */
  hasPreviewVideo: boolean;
  /** Number of screenshots visible in the media gallery; 0 if none detected. */
  screenshotCount: number;
}

/**
 * A crawler for the rendered App Store web page — the Strategy seam for
 * scraping.
 *
 * `FirecrawlCrawler` is the real implementation and `NullCrawler` the no-op
 * fallback. Another scraper (a headless browser, a different scraping API)
 * only needs to implement this interface and be wired into `getCrawler()`.
 */
export interface ListingCrawler {
  /** Stable identifier, e.g. "firecrawl". */
  readonly id: string;
  /** Whether this crawler is configured and usable. */
  readonly available: boolean;
  /**
   * Scrape an App Store page for the page-only fields. Resolves `null` when
   * the crawler is unavailable or the scrape fails — never throws, because
   * these fields are optional enrichment, not a hard dependency.
   */
  scrape(appStoreUrl: string): Promise<ListingExtras | null>;
}
