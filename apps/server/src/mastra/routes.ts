import { registerApiRoute } from '@mastra/core/server';
import { getLlmProvider } from '../llm';
import { getCrawler } from '../sources/crawler';
import { fetchITunesCore } from '../sources/itunes';
import { sweepStorefronts, DEFAULT_SWEEP_COUNTRIES } from '../sources/storefront-sweep';
import { AuditReportSchema } from '../domain/audit';
import { reportToMarkdown, markdownFilename } from '../export/markdown';
import { getAuthenticatedTenantId } from '../auth/middleware';
import { insertJob, getJobByRunId, markJobPending } from '../queue/job-store';
import { newId } from '../memory/ids';
import { getPgSql } from '../memory';

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
      return c.json(
        { error: 'This endpoint is deprecated. Use POST /audit/start and poll GET /audit/status/:runId.' },
        410,
      );
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
      return c.json(
        { error: 'This endpoint is deprecated. Use POST /audit/confirm and poll GET /audit/status/:runId.' },
        410,
      );
    },
  }),

  // ── POST /audit/start — enqueue a new audit job ──────────────────────────
  registerApiRoute('/audit/start', {
    method: 'POST',
    handler: async (c) => {
      const tenantId = await getAuthenticatedTenantId(c);
      if (!tenantId) return c.json({ error: 'Unauthorized' }, 401);
      const sql = getPgSql();
      if (!sql) return c.json({ error: 'Database not configured.' }, 503);
      try {
        const body = await c.req.json().catch(() => ({}));
        const url = typeof body?.url === 'string' ? body.url.trim() : '';
        if (!url) return c.json({ error: 'Paste an App Store URL first.' }, 400);
        const reopenIdentity = body?.reopenIdentity === true;
        const runId = newId('run');
        const job = await insertJob(sql, { runId, tenantId, url, reopenIdentity });
        return c.json({ jobId: job.id, runId: job.runId, status: job.status });
      } catch (e) {
        console.error('[audit/start] failed:', e);
        return c.json({ error: 'Could not enqueue audit.' }, 500);
      }
    },
  }),

  // ── GET /audit/status/:runId — poll job status ────────────────────────────
  registerApiRoute('/audit/status/:runId', {
    method: 'GET',
    handler: async (c) => {
      const tenantId = await getAuthenticatedTenantId(c);
      if (!tenantId) return c.json({ error: 'Unauthorized' }, 401);
      const sql = getPgSql();
      if (!sql) return c.json({ error: 'Database not configured.' }, 503);
      const runId = c.req.param('runId');
      const job = await getJobByRunId(sql, runId);
      if (!job) return c.json({ error: 'Job not found.' }, 404);
      if (job.tenantId !== tenantId) return c.json({ error: 'Not found.' }, 404);
      const response: Record<string, unknown> = {
        jobId: job.id,
        runId: job.runId,
        status: job.status,
        step: job.step,
        attempt: job.attempt,
        maxAttempts: job.maxAttempts,
      };
      if (job.status === 'done' && job.resultJson) {
        try { response.result = JSON.parse(job.resultJson); } catch { /* malformed */ }
      }
      if (job.status === 'failed') {
        response.errorMessage = job.errorMessage;
      }
      if (job.status === 'awaiting_confirmation' && job.suspendPayloadJson) {
        try { response.suspendPayload = JSON.parse(job.suspendPayloadJson); } catch { /* malformed */ }
      }
      return c.json(response);
    },
  }),

  // ── POST /audit/confirm — resume after human confirmation ─────────────────
  registerApiRoute('/audit/confirm', {
    method: 'POST',
    handler: async (c) => {
      const tenantId = await getAuthenticatedTenantId(c);
      if (!tenantId) return c.json({ error: 'Unauthorized' }, 401);
      const sql = getPgSql();
      if (!sql) return c.json({ error: 'Database not configured.' }, 503);
      try {
        const body = await c.req.json().catch(() => ({}));
        const runId = typeof body?.runId === 'string' ? body.runId : '';
        if (!runId) return c.json({ error: 'Missing runId.' }, 400);
        const job = await getJobByRunId(sql, runId);
        if (!job) return c.json({ error: 'Job not found.' }, 404);
        if (job.tenantId !== tenantId) return c.json({ error: 'Not found.' }, 404);
        if (job.status !== 'awaiting_confirmation') {
          return c.json({ error: `Job is not awaiting confirmation (status: ${job.status}).` }, 409);
        }
        const resumeData = {
          confirmed: true,
          identityDecision: body?.identityDecision ?? null,
          overrideAcknowledged: body?.overrideAcknowledged === true,
          fresh: body?.fresh === true,
        };
        await markJobPending(sql, job.id, JSON.stringify(resumeData));
        return c.json({ ok: true });
      } catch (e) {
        console.error('[audit/confirm] failed:', e);
        return c.json({ error: 'Could not confirm audit.' }, 500);
      }
    },
  }),
];
