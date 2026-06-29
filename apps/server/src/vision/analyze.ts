/**
 * Orchestrates the full vision analysis for one listing.
 *
 * Runs screenshot analysis + icon analysis via the VisionClient, then
 * assembles the typed VisionResult with correct confidence labels:
 *  - screenshotSetVerdict.confidence = 'observed' (vision ran)
 *  - iconVerdict.pHashDistance.confidence = 'observed' (computed from pixels)
 *  - iconVerdict.confusable.confidence = 'inferred' (vision judgment)
 */

import type { AppListing } from '../domain/listing';
import type { VisionClient } from './client';
import type { VisionResult, ScreenshotSetVerdict, IconVerdict } from './types';
import { computeDHash, dHashDistance, defaultImageFetcher } from './phash';
import type { ImageFetcher } from './phash';

const MODEL_ID = 'gemini-2.5-flash';

/**
 * Run vision analysis for a listing.
 *
 * @param listing - The app listing to analyze
 * @param client - The vision client to use (GeminiVisionClient or StubVisionClient)
 * @param imageFetcher - Injectable image fetcher (defaults to real HTTP fetch)
 */
export async function runVision(
  listing: AppListing,
  client: VisionClient,
  imageFetcher: ImageFetcher = defaultImageFetcher,
): Promise<VisionResult> {
  // Take up to 10 iPhone screenshot URLs
  const screenshotUrls = listing.screenshotUrls.slice(0, 10);

  // Take up to 3 competitor first-frame URLs for benchmarking
  // Competitor screenshot URLs are not available in AppListing.Competitor — the
  // schema carries screenshotCount but not the URLs themselves. Pass empty for
  // now; B3/Phase D can enrich this when a competitor-detail fetch is added.
  const competitorFirstFrameUrls: string[] = [];

  // ── Screenshot analysis ──────────────────────────────────────────────────
  const screenshotRaw = await client.analyzeScreenshots({
    screenshotUrls,
    competitorFirstFrameUrls,
  });

  // Map raw critiques to typed critiques with confidence labels
  const critiques = screenshotRaw.critiques.map((c, idx) => ({
    url: screenshotUrls[idx] ?? '',
    slot: c.slot,
    valuePropClarity: { value: c.valuePropClarity, confidence: 'observed' as const },
    readability: { value: c.readability, confidence: 'observed' as const },
    cohesion: { value: c.cohesion, confidence: 'observed' as const },
  }));

  const screenshotSetVerdict: ScreenshotSetVerdict = {
    critiques,
    competitorComparison: {
      value: screenshotRaw.competitorComparison,
      confidence: 'observed', // Vision ran = observed
    },
    coarseScore: screenshotRaw.suggestedCoarseScore, // Already 0|5|10 from client
    confidence: 'observed', // Always 'observed' once vision ran
    modelId: MODEL_ID,
  };

  // ── Icon analysis (only if icon URL is present) ──────────────────────────
  let iconVerdict: IconVerdict | null = null;

  if (listing.iconUrl) {
    // Fetch icon bytes for pHash computation
    const iconBytes = await imageFetcher(listing.iconUrl);

    // Compute dhash for icon
    const iconHash = await computeDHash(iconBytes);

    // Compute pHash distance against competitors (minimum across competitors)
    // Competitor icon URLs are not available in AppListing.Competitor — the
    // schema carries appId and name but not icon URLs. Pass empty for now;
    // B3/Phase D can enrich this when a competitor-detail fetch is added.
    const competitorIconUrls: string[] = [];

    let minPHashDistance = 64; // Maximum Hamming distance if no competitors

    if (competitorIconUrls.length > 0) {
      for (const compUrl of competitorIconUrls) {
        try {
          const compBytes = await imageFetcher(compUrl);
          const compHash = await computeDHash(compBytes);
          const dist = dHashDistance(iconHash, compHash);
          if (dist < minPHashDistance) {
            minPHashDistance = dist;
          }
        } catch {
          // Skip competitor icons that fail to fetch
        }
      }
    }

    // Also run icon analysis through the vision client
    const iconRaw = await client.analyzeIcon({
      iconUrl: listing.iconUrl,
      competitorIconUrls,
    });

    iconVerdict = {
      // pHashDistance is computed from actual pixel data → 'observed'
      pHashDistance: { value: minPHashDistance, confidence: 'observed' },
      // confusable is a vision model judgment → 'inferred'
      confusable: { value: iconRaw.confusable, confidence: 'inferred' },
      // categoryCohesion is also a vision judgment → 'inferred'
      categoryCohesion: { value: iconRaw.categoryCohesion, confidence: 'inferred' },
      confidence: 'observed', // Always 'observed' once vision ran
      modelId: MODEL_ID,
    };
  }

  return { screenshotSetVerdict, iconVerdict };
}
