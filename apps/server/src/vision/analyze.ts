/**
 * Orchestrates the full vision analysis for one listing.
 *
 * Runs screenshot analysis + icon analysis via the VisionClient, then
 * assembles the typed VisionResult with correct confidence labels:
 *  - screenshotSetVerdict.confidence = 'observed' (live client) | 'inferred' (no-op)
 *  - iconVerdict.pHashDistance.confidence = 'observed' (live + real comparisons) | 'inferred'
 *  - iconVerdict.confusable.confidence = 'inferred' (always — vision judgment)
 */

import type { Confidence } from '../domain/audit';
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
  // 'observed' only when a live API client ran; 'inferred' for no-op fallback.
  const resultConfidence: Confidence = client.isLive ? 'observed' : 'inferred';

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

  // Gate 'observed' on vision actually producing critiques.
  // A parse failure (backward-scan returning {}) leaves critiques empty —
  // labelling that 'observed' would fabricate a confident score with no evidence.
  // The downstream visionUsable() guard in deriveConfidence/codeScore checks the
  // same invariant once this VisionResult is assembled.
  const screenshotConfidence: Confidence =
    screenshotRaw.critiques.length > 0 && client.isLive ? 'observed' : 'inferred';

  // Map raw critiques to typed critiques with confidence labels
  const critiques = screenshotRaw.critiques.map((c, idx) => ({
    url: screenshotUrls[idx] ?? '',
    slot: c.slot,
    valuePropClarity: { value: c.valuePropClarity, confidence: screenshotConfidence },
    readability: { value: c.readability, confidence: screenshotConfidence },
    cohesion: { value: c.cohesion, confidence: screenshotConfidence },
  }));

  // Apply slot-utilization cap: Gemini only sees the screenshots that exist, so
  // it can return 10 (excellent) even when slots are unused. Cap at 5 when fewer
  // than 10 slots are used — unused slots are always a missed ASO opportunity.
  const geminiScore = screenshotRaw.suggestedCoarseScore;
  const slotCap: 0 | 5 | 10 = screenshotUrls.length >= 10 ? 10 : 5;
  const coarseScore: 0 | 5 | 10 = geminiScore > slotCap ? slotCap : geminiScore;

  const screenshotSetVerdict: ScreenshotSetVerdict = {
    critiques,
    competitorComparison: {
      value: screenshotRaw.competitorComparison,
      confidence: screenshotConfidence,
    },
    coarseScore,
    confidence: screenshotConfidence,
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
      // pHashDistance: 'observed' only when real competitor icons were compared
      // AND a live client ran; 'inferred' when URLs are empty (placeholder 64)
      // or when the no-op client ran.
      pHashDistance: {
        value: minPHashDistance,
        confidence: competitorIconUrls.length > 0 && client.isLive ? 'observed' : 'inferred',
      },
      // confusable/categoryCohesion are vision model judgments → always 'inferred'
      confusable: { value: iconRaw.confusable, confidence: 'inferred' },
      categoryCohesion: { value: iconRaw.categoryCohesion, confidence: 'inferred' },
      confidence: resultConfidence,
      modelId: MODEL_ID,
    };
  }

  return { screenshotSetVerdict, iconVerdict };
}
