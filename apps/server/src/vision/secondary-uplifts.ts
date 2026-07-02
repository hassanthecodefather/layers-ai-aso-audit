/**
 * B3 Secondary Uplifts: screenshot intelligence, cross-device matrix, PPO brief.
 *
 * Three secondary uplifts on top of B1's vision pass:
 * 1. Screenshot-set intelligence — role-tag panels, flag duplicates, promote strongest
 * 2. Cross-device / cross-locale consistency matrix — pure code, no LLM
 * 3. PPO ≤3-treatment variant brief — enforce ≤3 non-overlapping creative treatments
 */

import type { AppListing } from '../domain/listing';
import type { VisionClient } from './client';

export interface ScreenshotRole {
  slot: number;
  roleTag: string;     // e.g. "hero", "feature-X", "social-proof", "cta"
  valueProp: string;   // summarised value proposition of this panel
}

export interface ScreenshotSetAnalysis {
  roles: ScreenshotRole[];
  hasDuplicateMessages: boolean;
  duplicateSlots: number[];           // which slots repeat a message
  isPanoramicSet: boolean;            // continuous panoramic strip — no reordering
  treatmentCount: number;             // distinct creative treatments detected
  promoteCandidateSlot: number | null; // slot# to promote into position 1-3, null if panoramic/already optimal
}

export interface DeviceMatrix {
  iphone: { slotsUsed: number; maxSlots: 10 };
  ipad: { slotsUsed: number; maxSlots: 10 };
  /** True when iPad has significantly fewer slots than iPhone (≥3 gap). */
  ipadMissing: boolean;
}

export interface PPOBriefRecommendation {
  treatmentCount: number;
  exceeded: boolean;      // true if treatmentCount > 3
  maxTreatments: 3;
  rationale: string;
}

export interface SecondaryUpliftResult {
  screenshotSetAnalysis: ScreenshotSetAnalysis;
  deviceMatrix: DeviceMatrix;
  ppoBrief: PPOBriefRecommendation;
}

const PPO_RATIONALE =
  'More than 3 creative treatments overlap in the test window, making it hard to attribute which change drove a result. Focus on ≤3 distinct variables (e.g. hero image, headline, background colour).';

/**
 * Pure code — no model. Compute the cross-device slot matrix directly from
 * listing data.
 */
export function computeDeviceMatrix(listing: AppListing): DeviceMatrix {
  const iphoneSlotsUsed = listing.screenshotUrls.length;
  const ipadSlotsUsed = listing.ipadScreenshotUrls.length;
  const gap = iphoneSlotsUsed - ipadSlotsUsed;

  return {
    iphone: { slotsUsed: iphoneSlotsUsed, maxSlots: 10 },
    ipad: { slotsUsed: ipadSlotsUsed, maxSlots: 10 },
    ipadMissing: gap >= 3,
  };
}

/**
 * Run all three secondary uplifts using the existing VisionClient.
 * Calls `analyzeScreenshotSet()` on the VisionClient for screenshot intelligence.
 */
export async function runSecondaryUplifts(
  listing: AppListing,
  client: VisionClient,
): Promise<SecondaryUpliftResult> {
  const screenshotUrls = listing.screenshotUrls.slice(0, 10);

  // ── 1. Screenshot-set intelligence via vision ────────────────────────────
  const raw = await client.analyzeScreenshotSet(screenshotUrls);

  // Promote-panel: only for non-panoramic sets
  const promoteCandidateSlot: number | null = raw.isPanoramicSet
    ? null
    : raw.strongestSlotForPromotion;

  const screenshotSetAnalysis: ScreenshotSetAnalysis = {
    roles: raw.roles,
    hasDuplicateMessages: raw.hasDuplicateMessages,
    duplicateSlots: raw.duplicateSlots,
    isPanoramicSet: raw.isPanoramicSet,
    treatmentCount: raw.treatmentCount,
    promoteCandidateSlot,
  };

  // ── 2. Cross-device matrix (pure code) ───────────────────────────────────
  const deviceMatrix = computeDeviceMatrix(listing);

  // ── 3. PPO ≤3-treatment brief ────────────────────────────────────────────
  const ppoBrief: PPOBriefRecommendation = {
    treatmentCount: raw.treatmentCount,
    exceeded: raw.treatmentCount > 3,
    maxTreatments: 3,
    rationale: PPO_RATIONALE,
  };

  return { screenshotSetAnalysis, deviceMatrix, ppoBrief };
}
