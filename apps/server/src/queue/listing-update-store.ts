import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';

export type ListingUpdateStatus = 'draft' | 'submitted' | 'in_review' | 'approved' | 'rejected';

export type ProposedFields = {
  title?: string;
  subtitle?: string;
  keywords?: string;
  description?: string;
  promotionalText?: string;
  releaseNotes?: string;
};

export interface ListingUpdate {
  id: string;
  tenantId: string;
  appId: string;
  auditJobId: string | null;
  proposedFields: ProposedFields;
  appliedFields: ProposedFields | null;
  ascLocalizationId: string | null;
  status: ListingUpdateStatus;
  rejectionReason: string | null;
  submittedAt: Date | null;
  resolvedAt: Date | null;
  createdAt: Date;
  previousFields: ProposedFields | null;
}

interface ListingUpdateRow {
  id: string;
  tenant_id: string;
  app_id: string;
  audit_job_id: string | null;
  proposed_fields: string;
  applied_fields: string | null;
  asc_localization_id: string | null;
  status: string;
  rejection_reason: string | null;
  submitted_at: Date | null;
  resolved_at: Date | null;
  created_at: Date;
  previous_fields: string | null;
}

function rowToListingUpdate(r: ListingUpdateRow): ListingUpdate {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    appId: r.app_id,
    auditJobId: r.audit_job_id,
    proposedFields: typeof r.proposed_fields === 'string'
      ? (JSON.parse(r.proposed_fields) as ProposedFields)
      : (r.proposed_fields as unknown as ProposedFields),
    appliedFields: r.applied_fields
      ? (typeof r.applied_fields === 'string'
          ? (JSON.parse(r.applied_fields) as ProposedFields)
          : (r.applied_fields as unknown as ProposedFields))
      : null,
    ascLocalizationId: r.asc_localization_id,
    status: r.status as ListingUpdateStatus,
    rejectionReason: r.rejection_reason,
    submittedAt: r.submitted_at,
    resolvedAt: r.resolved_at,
    createdAt: r.created_at,
    previousFields: r.previous_fields
      ? (typeof r.previous_fields === 'string'
          ? (JSON.parse(r.previous_fields) as ProposedFields)
          : (r.previous_fields as unknown as ProposedFields))
      : null,
  };
}

export async function insertListingUpdate(
  sql: postgres.Sql,
  params: {
    tenantId: string;
    appId: string;
    auditJobId?: string | null;
    proposedFields: ProposedFields;
    ascLocalizationId?: string | null;
    previousFields?: ProposedFields | null;
  },
): Promise<ListingUpdate> {
  const id = `lu_${randomUUID()}`;
  const rows = await sql<ListingUpdateRow[]>`
    INSERT INTO aso_listing_updates
      (id, tenant_id, app_id, audit_job_id, proposed_fields, asc_localization_id, previous_fields)
    VALUES (
      ${id},
      ${params.tenantId},
      ${params.appId},
      ${params.auditJobId ?? null},
      ${JSON.stringify(params.proposedFields)},
      ${params.ascLocalizationId ?? null},
      ${params.previousFields ? JSON.stringify(params.previousFields) : null}
    )
    RETURNING *
  `;
  return rowToListingUpdate(rows[0]!);
}

export async function getListingUpdateById(
  sql: postgres.Sql,
  tenantId: string,
  id: string,
): Promise<ListingUpdate | null> {
  const rows = await sql<ListingUpdateRow[]>`
    SELECT * FROM aso_listing_updates
    WHERE id = ${id} AND tenant_id = ${tenantId}
    LIMIT 1
  `;
  return rows[0] ? rowToListingUpdate(rows[0]) : null;
}

export async function getLatestListingUpdate(
  sql: postgres.Sql,
  tenantId: string,
  appId: string,
): Promise<ListingUpdate | null> {
  const rows = await sql<ListingUpdateRow[]>`
    SELECT * FROM aso_listing_updates
    WHERE tenant_id = ${tenantId}
      AND app_id = ${appId}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return rows[0] ? rowToListingUpdate(rows[0]) : null;
}

export async function getInFlightListingUpdates(
  sql: postgres.Sql,
): Promise<ListingUpdate[]> {
  const rows = await sql<ListingUpdateRow[]>`
    SELECT * FROM aso_listing_updates
    WHERE status IN ('submitted', 'in_review')
    ORDER BY submitted_at ASC
  `;
  return rows.map(rowToListingUpdate);
}

export async function setListingUpdateSubmitted(
  sql: postgres.Sql,
  id: string,
  appliedFields: ProposedFields,
): Promise<void> {
  await sql`
    UPDATE aso_listing_updates
    SET applied_fields = ${JSON.stringify(appliedFields)},
        status         = 'submitted',
        submitted_at   = NOW()
    WHERE id = ${id}
  `;
}

export async function setListingUpdateStatus(
  sql: postgres.Sql,
  id: string,
  status: ListingUpdateStatus,
  rejectionReason: string | null,
  resolvedAt: Date | null,
): Promise<void> {
  await sql`
    UPDATE aso_listing_updates
    SET status           = ${status},
        rejection_reason = ${rejectionReason},
        resolved_at      = ${resolvedAt}
    WHERE id = ${id}
  `;
}

export async function resetListingUpdateToDraft(
  sql: postgres.Sql,
  id: string,
): Promise<void> {
  await sql`
    UPDATE aso_listing_updates
    SET status         = 'draft',
        applied_fields = NULL,
        submitted_at   = NULL,
        resolved_at    = NULL
    WHERE id = ${id}
  `;
}

export async function updateListingUpdateProposedFields(
  sql: postgres.Sql,
  id: string,
  proposedFields: ProposedFields,
): Promise<ListingUpdate> {
  const rows = await sql<ListingUpdateRow[]>`
    UPDATE aso_listing_updates
    SET proposed_fields = ${JSON.stringify(proposedFields)}
    WHERE id = ${id}
    RETURNING *
  `;
  return rowToListingUpdate(rows[0]!);
}
