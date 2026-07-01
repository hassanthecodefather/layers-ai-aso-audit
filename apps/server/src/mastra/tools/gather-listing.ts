import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { AppListingSchema } from '../../domain/listing';
import { resolveListing } from '../../sources';
import { getCache } from '../../cost/cache';

/**
 * `gather-listing` — assemble the full, audit-ready listing.
 *
 * Fans out across every data source (iTunes core + reviews + competitors, and
 * the Firecrawl page scrape) and merges them into the canonical `AppListing`.
 * The plain `gatherListing` function is what the workflow's data step calls.
 */

/** Assemble the complete listing for an app. Throws on failure. */
export async function gatherListing(appId: string, country: string) {
  // E1: reset cache hit counter so we can stamp provenance after the fetch fan-out.
  getCache().resetHitCount();

  const listing = await resolveListing({ appId, country });
  if (!listing.ok) throw new Error(listing.error);

  // E1: stamp observedFromCache=true if every fetch was served from cache.
  const hits = getCache().hitCount();
  if (hits > 0) {
    return {
      ...listing.value,
      provenance: { ...listing.value.provenance, observedFromCache: true },
    };
  }

  return listing.value;
}

export const gatherListingTool = createTool({
  id: 'gather-listing',
  description:
    'Gather the full App Store listing for an app — metadata, screenshots, ' +
    'ratings, a recent review sample, category competitors, and (if Firecrawl ' +
    'is configured) the subtitle and promotional text scraped from the web ' +
    'page. Returns the canonical listing the audit scores against.',
  inputSchema: z.object({
    appId: z.string().describe('The numeric App Store app ID.'),
    country: z.string().describe('Two-letter storefront code, e.g. "us".'),
  }),
  outputSchema: AppListingSchema,
  execute: async ({ appId, country }) => gatherListing(appId, country),
});
