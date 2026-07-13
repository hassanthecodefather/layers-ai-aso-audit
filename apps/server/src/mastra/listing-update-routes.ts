import { registerApiRoute } from '@mastra/core/server';
import { Agent } from '@mastra/core';
import { z } from 'zod';
import { getAuthenticatedTenantId } from '../auth/middleware';
import { getPgSql } from '../memory';
import {
  insertListingUpdate,
  getListingUpdateById,
  getLatestListingUpdate,
  setListingUpdateSubmitted,
  resetListingUpdateToDraft,
  updateListingUpdateProposedFields,
} from '../queue/listing-update-store';
import { loadCredentials } from '../asc/credential-store';
import { fetchAscListingData } from '../asc/listing-client';
import { pushListingUpdate } from '../asc/listing-writer';
import { getLlmProvider } from '../llm';
import { extractJsonObject } from '../scoring/extract';
import { getJobById } from '../queue/job-store';
import type { AuditReport } from '../domain/audit';

export const ProposedFieldsSchema = z.object({
  title: z.string().max(30).optional(),
  subtitle: z.string().max(30).optional(),
  keywords: z.string().max(100).optional(),
  description: z.string().max(4000).optional(),
  promotionalText: z.string().max(170).optional(),
  releaseNotes: z.string().max(4000).optional(),
});

// Helper: extract numeric appId from an App Store URL
// e.g. https://apps.apple.com/app/id1234567890 → "1234567890"
function extractAppIdFromUrl(url: string): string {
  const match = /\/id(\d+)/.exec(url);
  return match?.[1] ?? '';
}

function buildGeneratePrompt(params: {
  currentFields: Record<string, string | null>;
  recommendations: string;
  rejectionReason?: string | null;
}): string {
  const { currentFields, recommendations, rejectionReason } = params;
  const fieldLines = Object.entries(currentFields)
    .map(([k, v]) => `${k}: "${v ?? ''}"`)
    .join('\n');

  const rejectionContext = rejectionReason
    ? `\nIMPORTANT: Apple rejected the previous submission because: "${rejectionReason}". Generate new values that address this rejection while still applying the audit recommendations.\n`
    : '';

  return `You are an App Store Optimization expert. Based on the audit recommendations below, generate concrete new field values for this App Store listing.${rejectionContext}

CURRENT LISTING:
${fieldLines}

AUDIT RECOMMENDATIONS:
${recommendations}

INSTRUCTIONS:
- Only output fields that have recommendations and should change.
- Stay strictly within hard character limits: title ≤ 30, subtitle ≤ 30, keywords ≤ 100, description ≤ 4000, promotionalText ≤ 170, releaseNotes ≤ 4000.
- For keywords: comma-separated, no spaces after commas, no duplication of title/subtitle words.
- Return ONLY the fields that differ from current values.`;
}

export const listingUpdateRoutes = [
  registerApiRoute('/listing-update/generate', {
    method: 'POST',
    handler: async (c) => {
      const tenantId = await getAuthenticatedTenantId(c);
      if (!tenantId) return c.json({ error: 'Unauthorized' }, 401);
      const sql = getPgSql();
      if (!sql) return c.json({ error: 'Database not configured.' }, 503);

      const body = await c.req.json().catch(() => ({}));
      const auditJobId = typeof body?.auditJobId === 'string' ? body.auditJobId.trim() : '';
      if (!auditJobId) return c.json({ error: 'Missing auditJobId.' }, 400);

      try {
        // Load and verify the audit job
        const job = await getJobById(sql, tenantId, auditJobId);
        if (!job) return c.json({ error: 'Audit job not found.' }, 404);
        if (job.status !== 'done') return c.json({ error: 'Audit not yet complete.' }, 400);

        // Extract appId from the job URL (AuditJob has no appId field)
        const appId = extractAppIdFromUrl(job.url);
        if (!appId) return c.json({ error: 'Could not extract appId from audit job URL.' }, 400);

        // Block if a non-terminal update already exists
        const existing = await getLatestListingUpdate(sql, tenantId, appId);
        if (existing && !['approved', 'rejected'].includes(existing.status)) {
          return c.json({ error: 'An update is already in progress.', updateId: existing.id }, 409);
        }

        // Load ASC credentials
        const credsResult = await loadCredentials(sql, tenantId);
        if (!credsResult.ok || !credsResult.value) {
          return c.json({ error: 'ASC credentials not configured.' }, 400);
        }
        const creds = credsResult.value;

        // Fetch current listing data + localization ID
        const ascData = await fetchAscListingData(creds, appId);
        if (!ascData.localizationId) {
          return c.json({
            error: 'Could not fetch ASC listing data. Check credentials and that app has a live version.',
          }, 400);
        }

        // Parse audit report recommendations
        const report = JSON.parse(job.resultJson ?? '{}') as Partial<AuditReport>;
        const allRecs = [
          ...(report.quickWins ?? []),
          ...(report.highImpact ?? []),
          ...(report.strategic ?? []),
        ];
        const recommendationsText = allRecs
          .map((r) => `[${r.referent?.value ?? r.dimension}] ${r.title}: ${r.rationale}`)
          .join('\n');

        // Get rejection reason from existing rejected update (for re-generation flow)
        const rejectionReason = existing?.status === 'rejected' ? existing.rejectionReason : null;

        // LLM call — generate proposed field values
        const currentFields: Record<string, string | null> = {
          title: null,               // ASC listing-client doesn't return title/subtitle yet
          subtitle: null,
          keywords: ascData.keywords,
          description: null,
          promotionalText: ascData.promotionalText,
        };

        const llmAgent = new Agent({
          id: 'listing-field-writer',
          name: 'Listing Field Writer',
          instructions: 'You generate App Store listing field values as JSON. Return ONLY a JSON object, no markdown, no explanation.',
          model: getLlmProvider('fast').model(),
        });
        const llmResult = await llmAgent.generate(
          buildGeneratePrompt({ currentFields, recommendations: recommendationsText, rejectionReason }),
          { modelSettings: { temperature: 0 } },
        );
        const jsonText = extractJsonObject(llmResult.text ?? '');
        if (!jsonText) throw new Error('LLM returned no structured JSON');
        const fieldsParsed = ProposedFieldsSchema.safeParse(JSON.parse(jsonText));
        if (!fieldsParsed.success) throw new Error('LLM output failed field schema validation');
        const proposedFields = fieldsParsed.data;

        let updateRow;
        if (existing?.status === 'rejected') {
          // Rejection re-generation path: reuse existing row, update proposed_fields
          await resetListingUpdateToDraft(sql, existing.id);
          updateRow = await updateListingUpdateProposedFields(sql, existing.id, proposedFields);
        } else {
          // Normal path: insert new row
          updateRow = await insertListingUpdate(sql, {
            tenantId,
            appId,
            auditJobId,
            proposedFields,
            ascLocalizationId: ascData.localizationId,
            previousFields: {
              ...(currentFields.keywords != null ? { keywords: currentFields.keywords } : {}),
              ...(currentFields.promotionalText != null ? { promotionalText: currentFields.promotionalText } : {}),
            },
          });
        }

        return c.json({
          updateId: updateRow.id,
          proposedFields: updateRow.proposedFields,
          currentFields,
          status: updateRow.status,
        });
      } catch (e) {
        console.error('[listing-update/generate] failed:', e);
        return c.json({ error: 'Generation failed.' }, 500);
      }
    },
  }),

  registerApiRoute('/listing-update/submit', {
    method: 'POST',
    handler: async (c) => {
      const tenantId = await getAuthenticatedTenantId(c);
      if (!tenantId) return c.json({ error: 'Unauthorized' }, 401);
      const sql = getPgSql();
      if (!sql) return c.json({ error: 'Database not configured.' }, 503);

      const body = await c.req.json().catch(() => ({}));
      const updateId = typeof body?.updateId === 'string' ? body.updateId.trim() : '';
      const approvedFields = body?.approvedFields;
      if (!updateId) return c.json({ error: 'Missing updateId.' }, 400);
      if (!approvedFields || typeof approvedFields !== 'object') {
        return c.json({ error: 'Missing approvedFields.' }, 400);
      }

      const fieldsResult = ProposedFieldsSchema.safeParse(approvedFields);
      if (!fieldsResult.success) {
        return c.json({ error: 'Invalid approvedFields.', details: fieldsResult.error.issues }, 400);
      }

      try {
        const update = await getListingUpdateById(sql, tenantId, updateId);
        if (!update) return c.json({ error: 'Update not found.' }, 404);
        if (update.status !== 'draft') return c.json({ error: 'Update is not in draft status.' }, 400);
        if (!update.ascLocalizationId) return c.json({ error: 'No ASC localization ID on this update.' }, 400);

        const credsResult = await loadCredentials(sql, tenantId);
        if (!credsResult.ok || !credsResult.value) {
          return c.json({ error: 'ASC credentials not configured.' }, 400);
        }

        const pushResult = await pushListingUpdate(credsResult.value, update.ascLocalizationId, fieldsResult.data);
        if (!pushResult.ok) {
          return c.json({ error: `ASC push failed: ${pushResult.error}` }, 502);
        }

        await setListingUpdateSubmitted(sql, updateId, fieldsResult.data);
        const updated = await getListingUpdateById(sql, tenantId, updateId);
        return c.json({ update: updated });
      } catch (e) {
        console.error('[listing-update/submit] failed:', e);
        return c.json({ error: 'Submit failed.' }, 500);
      }
    },
  }),

  registerApiRoute('/listing-update/:appId/current', {
    method: 'GET',
    handler: async (c) => {
      const tenantId = await getAuthenticatedTenantId(c);
      if (!tenantId) return c.json({ error: 'Unauthorized' }, 401);
      const sql = getPgSql();
      if (!sql) return c.json({ error: 'Database not configured.' }, 503);

      const appId = c.req.param('appId');
      if (!appId) return c.json({ error: 'Missing appId.' }, 400);

      try {
        const update = await getLatestListingUpdate(sql, tenantId, appId);
        return c.json({ update: update ?? null });
      } catch (e) {
        console.error('[listing-update/current] failed:', e);
        return c.json({ error: 'Lookup failed.' }, 500);
      }
    },
  }),
];
