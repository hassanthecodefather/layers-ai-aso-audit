import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { parseAppStoreUrl } from '../../domain/app-url';
import { AppSummarySchema } from '../../domain/listing';
import { resolveSummary } from '../../sources';

/**
 * `identify-app` — resolve a pasted App Store URL to surface metadata.
 *
 * The logic lives in the plain `identifyApp` function so it has exactly one
 * implementation, called two ways: the workflow's confirmation step calls the
 * function directly (it needs to then `suspend()`); the agent calls the
 * `createTool` wrapper. Same behaviour, no duplication.
 */

/** Resolve a URL/app ID to its confirmation-card summary. Throws on failure. */
export async function identifyApp(url: string) {
  const ref = parseAppStoreUrl(url);
  if (!ref.ok) throw new Error(ref.error);

  const summary = await resolveSummary(ref.value);
  if (!summary.ok) throw new Error(summary.error);

  return summary.value;
}

export const identifyAppTool = createTool({
  id: 'identify-app',
  description:
    'Resolve an Apple App Store URL (or a bare numeric app ID) to surface ' +
    'metadata — name, developer, icon, category, rating — using only Apple\'s ' +
    'free iTunes Lookup API. Use this to confirm which app the user means ' +
    'before running a full audit.',
  inputSchema: z.object({
    url: z.string().describe('An apps.apple.com URL or a numeric app ID.'),
  }),
  outputSchema: AppSummarySchema,
  execute: async ({ url }) => identifyApp(url),
});
