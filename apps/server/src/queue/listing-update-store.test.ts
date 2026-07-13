import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

// Mock gateway is not needed here — we mock the sql function directly
const makeRow = (overrides = {}) => ({
  id: 'lu_abc',
  tenant_id: 'tenant1',
  app_id: '123456',
  audit_job_id: 'job_1',
  proposed_fields: JSON.stringify({ title: 'New Title' }),
  applied_fields: null,
  asc_localization_id: 'loc_1',
  status: 'draft',
  rejection_reason: null,
  submitted_at: null,
  resolved_at: null,
  created_at: new Date('2026-01-01'),
  previous_fields: null,
  ...overrides,
});

describe('listing-update-store', () => {
  let mockSql: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    // postgres tagged-template calls are plain function calls under the hood
    mockSql = vi.fn().mockResolvedValue([]);
  });

  it('insertListingUpdate returns a mapped ListingUpdate', async () => {
    mockSql.mockResolvedValueOnce([makeRow()]);
    const { insertListingUpdate } = await import('./listing-update-store');
    const result = await insertListingUpdate(mockSql as unknown as postgres.Sql, {
      tenantId: 'tenant1',
      appId: '123456',
      auditJobId: 'job_1',
      proposedFields: { title: 'New Title' },
      ascLocalizationId: 'loc_1',
    });
    expect(result.id).toBe('lu_abc');
    expect(result.tenantId).toBe('tenant1');
    expect(result.status).toBe('draft');
    expect(result.proposedFields).toEqual({ title: 'New Title' });
    expect(result.appliedFields).toBeNull();
  });

  it('getListingUpdateById returns null when no row', async () => {
    mockSql.mockResolvedValueOnce([]);
    const { getListingUpdateById } = await import('./listing-update-store');
    const result = await getListingUpdateById(mockSql as unknown as postgres.Sql, 'tenant1', 'lu_missing');
    expect(result).toBeNull();
  });

  it('getLatestListingUpdate returns the most recent non-approved update', async () => {
    const row = makeRow({ status: 'submitted' });
    mockSql.mockResolvedValueOnce([row]);
    const { getLatestListingUpdate } = await import('./listing-update-store');
    const result = await getLatestListingUpdate(mockSql as unknown as postgres.Sql, 'tenant1', '123456');
    expect(result?.status).toBe('submitted');
  });

  it('getInFlightListingUpdates returns submitted and in_review rows', async () => {
    const rows = [makeRow({ status: 'submitted' }), makeRow({ id: 'lu_2', status: 'in_review' })];
    mockSql.mockResolvedValueOnce(rows);
    const { getInFlightListingUpdates } = await import('./listing-update-store');
    const results = await getInFlightListingUpdates(mockSql as unknown as postgres.Sql);
    expect(results).toHaveLength(2);
  });

  it('setListingUpdateStatus updates status and resolution fields', async () => {
    const { setListingUpdateStatus } = await import('./listing-update-store');
    await setListingUpdateStatus(mockSql as unknown as postgres.Sql, 'lu_abc', 'approved', null, new Date());
    expect(mockSql).toHaveBeenCalled();
  });

  it('resetListingUpdateToDraft resets status to draft', async () => {
    const { resetListingUpdateToDraft } = await import('./listing-update-store');
    await resetListingUpdateToDraft(mockSql as unknown as postgres.Sql, 'lu_abc');
    expect(mockSql).toHaveBeenCalled();
  });

  it('insertListingUpdate stores and returns previousFields', async () => {
    const { insertListingUpdate } = await import('./listing-update-store');
    const row = makeRow({ previous_fields: JSON.stringify({ title: 'Old Title' }) });
    mockSql.mockResolvedValueOnce([row]);
    const result = await insertListingUpdate(mockSql as unknown as postgres.Sql, {
      tenantId: 'tenant1',
      appId: '123456',
      proposedFields: { title: 'New Title' },
      previousFields: { title: 'Old Title' },
    });
    expect(result.previousFields).toEqual({ title: 'Old Title' });
  });
});
