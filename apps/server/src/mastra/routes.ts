import { registerApiRoute } from '@mastra/core/server';
import { streamSSE } from 'hono/streaming';
import { getLlmProvider } from '../llm';
import { getCrawler } from '../sources/crawler';
import { fetchITunesCore } from '../sources/itunes';
import { sweepStorefronts, DEFAULT_SWEEP_COUNTRIES } from '../sources/storefront-sweep';
import { AuditReportSchema } from '../domain/audit';
import { reportToMarkdown, markdownFilename } from '../export/markdown';
import { getAuthenticatedTenantId } from '../auth/middleware';

/**
 * Custom HTTP routes that drive the audit workflow for the chat UI.
 *
 * The flow is a suspend/resume workflow, so the server controls the run and
 * hands the browser a dead-simple SSE stream. Two endpoints mirror the two
 * chat turns:
 *
 *   POST /audit/identify  → start the run; it suspends; return the app summary
 *   POST /audit/run       → resume the run; stream progress + the final report
 *
 * A "no" to the confirmation never reaches the server — the UI just starts a
 * fresh run with the next URL, abandoning the suspended one.
 */

const WORKFLOW_ID = 'asoAuditWorkflow';

/**
 * Suspended runs awaiting confirmation, kept between the two requests. Mastra
 * also persists the run to LibSQL, so this is an in-process fast path with a
 * `createRun({ runId })` rehydration fallback below.
 */
const pendingRuns = new Map<string, any>();

/** First non-nullish candidate — for reading Mastra result shapes defensively. */
function firstOf<T>(...candidates: (T | null | undefined)[]): T | undefined {
  return candidates.find((c) => c != null) ?? undefined;
}

/** Locate the confirm-app suspend payload ({ summary, identity, ... }). */
function extractSuspendPayload(result: any): any {
  const step = result?.steps?.['confirm-app'];
  return firstOf(
    step?.suspendPayload,
    step?.payload,
    step?.suspendedPayload,
    result?.suspendPayload,
    result?.payload,
  );
}

/** Locate the confirmation summary in a suspended workflow result. */
function extractSummary(result: any): unknown {
  return extractSuspendPayload(result)?.summary;
}

/** Locate the challenge conflict payload in a re-suspended confirm step. */
function extractConflict(result: any): unknown {
  return extractSuspendPayload(result)?.conflict ?? null;
}

/** Locate the audit report in a completed workflow result. */
function extractReport(result: any): unknown {
  return firstOf(
    result?.result,
    result?.output,
    result?.steps?.['score-listing']?.output,
    result?.payload?.output,
  );
}

/** Build a human-readable message from a failed workflow result. */
function extractError(result: any): string {
  const stepError =
    result?.steps?.['score-listing']?.error ??
    result?.steps?.['gather-listing']?.error ??
    result?.steps?.['confirm-app']?.error ??
    result?.error;
  if (typeof stepError === 'string') return stepError;
  if (stepError?.message) return String(stepError.message);
  return 'The audit failed unexpectedly. Check the server logs.';
}

/** Translate a workflow step id into a user-facing progress line. */
function progressFor(stepId: string): { phase: string; message: string } | null {
  switch (stepId) {
    case 'gather-listing':
      return {
        phase: 'gather',
        message:
          'Gathering the App Store listing — metadata, screenshots, reviews and competitors…',
      };
    case 'score-listing':
      return {
        phase: 'score',
        message: 'Scoring all ten ASO dimensions with the auditor agent…',
      };
    default:
      return null;
  }
}

// ── /audit/sweep — storefront sweep (observe-only, free iTunes) ───────────────

/** ISO country codes we accept; keeps the endpoint from being a free proxy. */
const ALLOWED_COUNTRIES = new Set([
  'gb', 'au', 'ca', 'de', 'fr', 'es', 'it', 'jp', 'kr', 'br',
  'mx', 'nl', 'se', 'no', 'dk', 'fi', 'pl', 'pt', 'tr', 'in',
  'hk', 'sg', 'tw', 'nz', 'za', 'ar', 'cl', 'co', 'ru', 'cn',
]);

export const auditRoutes = [
  // ── Portable Markdown export ──────────────────────────────────────────────
  registerApiRoute('/audit/export/markdown', {
    method: 'POST',
    handler: async (c) => {
      const tenantId = await getAuthenticatedTenantId(c);
      if (!tenantId) return c.json({ error: 'Unauthorized' }, 401);
      try {
        const body = await c.req.json().catch(() => ({}));
        const parsed = AuditReportSchema.safeParse(body?.report);
        if (!parsed.success) {
          return c.json({ error: 'Invalid report payload.' }, 400);
        }
        const md = reportToMarkdown(parsed.data);
        const filename = markdownFilename(parsed.data);
        c.header('Content-Type', 'text/markdown; charset=utf-8');
        c.header('Content-Disposition', `attachment; filename="${filename}"`);
        return c.body(md);
      } catch (e) {
        console.error('[export/markdown] failed:', e);
        return c.json({ error: e instanceof Error ? e.message : 'Export failed.' }, 500);
      }
    },
  }),

  // ── Capability probe — lets the UI tell the user what's configured ───────
  registerApiRoute('/audit/health', {
    method: 'GET',
    handler: async (c) => {
      const tenantId = await getAuthenticatedTenantId(c);
      if (!tenantId) return c.json({ error: 'Unauthorized' }, 401);
      const llm = getLlmProvider();
      const crawler = getCrawler();
      return c.json({
        llm: {
          provider: llm.id,
          model: llm.modelId,
          endpoint: llm.endpoint,
          reachable: await llm.reachable(),
        },
        crawler: { id: crawler.id, available: crawler.available },
      });
    },
  }),

  // ── Turn 1: identify the app and pause for confirmation ──────────────────
  registerApiRoute('/audit/identify', {
    method: 'POST',
    handler: async (c) => {
      const tenantId = await getAuthenticatedTenantId(c);
      if (!tenantId) return c.json({ error: 'Unauthorized' }, 401);
      try {
        const mastra = c.get('mastra');
        const body = await c.req.json().catch(() => ({}));
        const url = typeof body?.url === 'string' ? body.url.trim() : '';
        if (!url) return c.json({ error: 'Paste an App Store URL first.' }, 400);

        const workflow = mastra.getWorkflow(WORKFLOW_ID);
        const run = await workflow.createRun();
        const reopenIdentity = body?.reopenIdentity === true;
        const result: any = await run.start({ inputData: { url, reopenIdentity, tenantId } });

        if (result?.status === 'suspended') {
          const payload = extractSuspendPayload(result);
          const summary = payload?.summary;
          if (!summary) {
            console.error(
              '[identify] no summary; result keys:',
              Object.keys(result ?? {}),
              JSON.stringify(result?.steps ?? {}).slice(0, 600),
            );
            return c.json(
              { error: 'Could not read the app summary from the workflow.' },
              500,
            );
          }
          pendingRuns.set(run.runId, run);
          // Surface the resolved identity too, so the UI can widen the prompt to
          // "here's what we think your app is — confirm, correct, or pick" when
          // the identity escalates (spec ID). Most apps need no identity ask.
          return c.json({
            runId: run.runId,
            summary,
            identity: payload?.identity ?? null,
            identityNeedsConfirm: Boolean(payload?.identityNeedsConfirm),
          });
        }

        // Failing this early means a bad URL or an unknown app.
        return c.json({ error: extractError(result) }, 422);
      } catch (e) {
        console.error('[identify] failed:', e);
        return c.json(
          { error: e instanceof Error ? e.message : 'Failed to identify the app.' },
          422,
        );
      }
    },
  }),

  // ── Storefront sweep — observe-only, free iTunes ──────────────────────────
  registerApiRoute('/audit/sweep', {
    method: 'POST',
    handler: async (c) => {
      const tenantId = await getAuthenticatedTenantId(c);
      if (!tenantId) return c.json({ error: 'Unauthorized' }, 401);
      try {
        const body = await c.req.json().catch(() => ({}));
        const appId = typeof body?.appId === 'string' ? body.appId.trim() : '';
        if (!appId) return c.json({ error: 'Missing appId.' }, 400);

        // Countries to sweep — default to the canonical four if not specified.
        const requested: string[] = Array.isArray(body?.countries)
          ? (body.countries as unknown[]).filter((c): c is string => typeof c === 'string').map((c) => c.toLowerCase())
          : [...DEFAULT_SWEEP_COUNTRIES];
        const countries = requested.filter((c) => ALLOWED_COUNTRIES.has(c));
        if (countries.length === 0) return c.json({ error: 'No valid country codes provided.' }, 400);

        // Fetch the primary (US) listing.
        const primary = await fetchITunesCore({ appId, country: 'us' });
        if (!primary.ok) return c.json({ error: `App not found in US store: ${primary.error}` }, 404);

        const results = await sweepStorefronts(appId, primary.value, countries);
        return c.json({ appId, primary: primary.value.name, results });
      } catch (e) {
        console.error('[sweep] failed:', e);
        return c.json({ error: e instanceof Error ? e.message : 'Sweep failed.' }, 500);
      }
    },
  }),

  // ── Turn 2: run the audit, streaming progress then the report ────────────
  registerApiRoute('/audit/run', {
    method: 'POST',
    handler: async (c) => {
      const tenantId = await getAuthenticatedTenantId(c);
      if (!tenantId) return c.json({ error: 'Unauthorized' }, 401);
      const mastra = c.get('mastra');
      const body = await c.req.json().catch(() => ({}));
      const runId = typeof body?.runId === 'string' ? body.runId : '';
      if (!runId) return c.json({ error: 'Missing runId.' }, 400);
      const identityDecision = body?.identityDecision ?? null;
      const overrideAcknowledged = body?.overrideAcknowledged === true;
      // When true, all source fetches in gather-listing bypass the cache.
      // The documented --fresh post-release bypass (spec E1).
      const fresh = typeof body?.fresh === 'boolean' ? body.fresh : false;

      const workflow = mastra.getWorkflow(WORKFLOW_ID);
      const run =
        pendingRuns.get(runId) ?? (await workflow.createRun({ runId }));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return streamSSE(c as any, async (stream) => {
        // Serialise writes — stream events and the result arrive on different
        // callstacks, and interleaved SSE frames would corrupt.
        let chain: Promise<unknown> = Promise.resolve();
        let wasSuspended = false;
        const send = (event: string, data: unknown): void => {
          chain = chain.then(() =>
            stream.writeSSE({ event, data: JSON.stringify(data) }),
          );
        };

        send('progress', {
          phase: 'confirmed',
          message: 'Confirmed. Starting the audit…',
        });

        try {
          const wfStream = await run.resumeStream({
            step: 'confirm-app',
            resumeData: { confirmed: true, identityDecision, overrideAcknowledged, fresh },
          });

          const seen = new Set<string>();
          // `fullStream` is the supported async-iterable view of the run.
          const events: AsyncIterable<any> =
            (wfStream as any).fullStream ?? wfStream;
          for await (const chunk of events) {
            if (chunk?.type !== 'workflow-step-start') continue;
            const stepId = firstOf<string>(
              chunk?.payload?.id,
              chunk?.payload?.stepId,
              chunk?.payload?.step?.id,
              chunk?.payload?.stepName,
            );
            if (!stepId || seen.has(stepId)) continue;
            seen.add(stepId);
            const progress = progressFor(stepId);
            if (progress) send('progress', progress);
          }

          const result: any = await wfStream.result;
          if (result?.status === 'suspended') {
            // The gate challenged a contested override — send the conflict and keep
            // the run alive so the UI can resubmit with overrideAcknowledged.
            wasSuspended = true;
            send('conflict', extractConflict(result));
          } else if (result?.status === 'success') {
            send('report', extractReport(result));
          } else {
            send('error', { message: extractError(result) });
          }
        } catch (e) {
          console.error('[run] failed:', e);
          send('error', {
            message: e instanceof Error ? e.message : 'The audit failed.',
          });
        } finally {
          if (!wasSuspended) pendingRuns.delete(runId);
          send('done', {});
          await chain;
        }
      });
    },
  }),
];
