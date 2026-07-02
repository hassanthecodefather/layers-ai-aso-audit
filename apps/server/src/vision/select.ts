/**
 * Vision result reuse logic — the testable heart of the zero-LLM reuse assertion.
 *
 * If the screenshot + icon inputs haven't changed since the prior snapshot,
 * the stored VisionResult is valid to reuse (zero additional LLM calls).
 *
 * "Changed" = screenshotUrls or iconUrl differ between current listing and the
 * listing in the prior snapshot. If both match, the stored vision result is valid.
 *
 * This function is a pure function of its inputs — no side effects, no IO.
 * Unit-testable directly without stubbing the workflow.
 */

import type { AppListing } from '../domain/listing';
import type { ListingSignals } from '../scoring/signals';
import type { ListingSnapshot } from '../domain/snapshot';
import { VisionResultSchema } from './types';
import type { VisionResult } from './types';

/**
 * Returns the prior VisionResult if the screenshot + icon inputs haven't
 * changed since the prior snapshot, or null if vision must re-run.
 *
 * Note: `_currentSignals` is accepted but intentionally unused — reserved for
 * future signal-keyed reuse (e.g. keying on locale or version signals).
 */
export function selectVisionResult(
  current: AppListing,
  _currentSignals: ListingSignals,
  priorSnapshot: ListingSnapshot | null,
): VisionResult | null {
  if (!priorSnapshot) return null;

  // Validate the stored vision result against the schema — catches corrupt or
  // schema-drifted rows (z.unknown().optional() in snapshot schema means any
  // JSON can be stored; we validate on the way out, consistent with how recs
  // and identity rows are handled in libsql-storage-client.ts).
  const parsed = VisionResultSchema.safeParse(priorSnapshot.visionResult);
  if (!parsed.success) return null;
  const priorVisionResult: VisionResult = parsed.data as VisionResult;

  const prior = priorSnapshot.listing;

  // Compare screenshot URLs (order-sensitive)
  const currentScreenshots = current.screenshotUrls.join('|');
  const priorScreenshots = prior.screenshotUrls.join('|');
  if (currentScreenshots !== priorScreenshots) return null;

  // Compare icon URL
  if (current.iconUrl !== prior.iconUrl) return null;

  // URLs match → reuse the stored vision result (zero LLM calls)
  return priorVisionResult;
}
