import type { Confidence } from '../domain/audit';

export interface Labelled<T> {
  value: T;
  confidence: Confidence;
}

/** Per-screenshot critique from the vision model. */
export interface ScreenshotCritique {
  url: string;
  slot: number; // 1-indexed
  valuePropClarity: Labelled<string>; // first 1-2 frames
  readability: Labelled<string>;
  cohesion: Labelled<string>;
}

/** Aggregated verdict for the full screenshot set. */
export interface ScreenshotSetVerdict {
  critiques: ScreenshotCritique[];
  competitorComparison: Labelled<string>; // top-3 first frames vs competitors'
  coarseScore: number; // 0 | 5 | 10 — follows A6 coarse-ordinal pattern
  confidence: Confidence; // always 'observed' once vision ran
  modelId: string;
}

/** Icon analysis. */
export interface IconVerdict {
  pHashDistance: Labelled<number>; // confidence: 'observed' (computed from pixels)
  confusable: Labelled<string>; // confidence: 'inferred' (vision judgment)
  categoryCohesion: Labelled<string>; // confidence: 'inferred'
  confidence: Confidence; // always 'observed' once vision ran
  modelId: string;
}

export interface VisionResult {
  screenshotSetVerdict: ScreenshotSetVerdict;
  iconVerdict: IconVerdict | null; // null if no icon URL
}
