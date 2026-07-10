import { createHash } from 'node:crypto';

export function computeScreenshotHash(screenshotUrls: string[]): string | null {
  if (!screenshotUrls.length) return null;
  return createHash('sha256')
    .update([...screenshotUrls].sort().join('|'))
    .digest('hex');
}
