/**
 * Public API for the vision module.
 */

export { runVision } from './analyze';
export { getVisionClient, StubVisionClient, NoOpVisionClient, GeminiVisionClient } from './client';
export { selectVisionResult } from './select';
export { computeDHash, dHashDistance, defaultImageFetcher } from './phash';
export type {
  VisionResult,
  ScreenshotSetVerdict,
  ScreenshotCritique,
  IconVerdict,
  Labelled,
} from './types';
export type {
  VisionClient,
  ScreenshotAnalysisInput,
  IconAnalysisInput,
  ScreenshotRawResult,
  IconRawResult,
} from './client';
export type { ImageFetcher } from './phash';
