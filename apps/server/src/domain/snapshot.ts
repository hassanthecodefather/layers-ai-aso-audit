import { z } from 'zod';
import { AppListingSchema } from './listing';
import { AuditReportSchema } from './audit';

/**
 * An immutable record of one audit run (spec P1 "Snapshot store + rubric
 * replay", Build Appendix §A `aso_listing_snapshots`). Freezing the listing,
 * the deterministic signals, the report, and the version stamps is what makes
 * two things possible later: a zero-LLM rubric-weight replay (re-run the
 * assembler over `report_json`'s draft), and an evidence chip that resolves to
 * *that date's* source data and can never be back-dated.
 */
export const ListingSnapshotSchema = z.object({
  id: z.string(),
  appId: z.string(),
  country: z.string(),
  fetchedAt: z.string(),
  /** The full normalised AppListing as observed. */
  listing: AppListingSchema,
  /** Deterministic signals (scoring/signals.ts) — kept opaque to the seam. */
  signals: z.unknown(),
  /** The assembled AuditReport. */
  report: AuditReportSchema,
  /** Hash of the RUBRIC weights at scoring time — the rubric-replay key. */
  rubricVersion: z.string(),
  /** Hash of the scoring prompt. */
  promptHash: z.string(),
  modelId: z.string(),
  /**
   * Vision analysis result from B1 (screenshot + icon quality from Gemini).
   * Optional for backward compatibility with Phase A snapshots.
   * Stored as an opaque JSON blob — validated by the vision module on use.
   */
  visionResult: z.unknown().optional(),
  /**
   * Keyword candidate + gap result from C2/C4. Optional for backward
   * compatibility with pre-C snapshots. Validated by candidates.ts on use.
   */
  candidateResult: z.unknown().optional(),
  /**
   * Theme analysis result from D2. Optional for backward compatibility with
   * pre-D snapshots. Validated by themes.ts on use.
   */
  themeResult: z.unknown().optional(),
  /**
   * Seeds used for D3 function-grounded competitor discovery (niche + category).
   * Stored so selectFunctionCompetitors can skip AppKittie on unchanged identity.
   * Absent when D3 didn't run or returned no competitors.
   */
  functionCompetitorSeeds: z.array(z.string()).optional(),
});
export type ListingSnapshot = z.infer<typeof ListingSnapshotSchema>;
