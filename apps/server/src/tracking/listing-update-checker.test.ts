import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

const mockSql = vi.fn().mockResolvedValue([]) as unknown as postgres.Sql;

vi.mock('../queue/listing-update-store', () => ({
  getInFlightListingUpdates: vi.fn(),
  setListingUpdateStatus: vi.fn(),
}));

vi.mock('../asc/credential-store', () => ({
  loadCredentials: vi.fn(),
  signAscToken: vi.fn().mockReturnValue('mock-token'),
}));

vi.mock('../cost/gateway', () => ({
  getGateway: () => ({ fetch: vi.fn() }),
}));

vi.mock('./store', () => ({
  insertChangeEvent: vi.fn(),
}));

const mockGatewayFetch = vi.fn();
vi.mock('../cost/gateway', () => ({
  getGateway: () => ({ fetch: mockGatewayFetch }),
}));

describe('runListingUpdateCheck', () => {
  beforeEach(() => {
    vi.resetModules();
    mockGatewayFetch.mockReset();
  });

  it('does nothing when no in-flight updates', async () => {
    const { getInFlightListingUpdates } = await import('../queue/listing-update-store');
    vi.mocked(getInFlightListingUpdates).mockResolvedValue([]);
    const { runListingUpdateCheck } = await import('./listing-update-checker');
    await expect(runListingUpdateCheck(mockSql)).resolves.toBeUndefined();
    expect(mockGatewayFetch).not.toHaveBeenCalled();
  });

  it('marks update approved when ASC state is READY_FOR_SALE', async () => {
    const { getInFlightListingUpdates, setListingUpdateStatus } = await import('../queue/listing-update-store');
    const { loadCredentials } = await import('../asc/credential-store');
    const { insertChangeEvent } = await import('./store');

    vi.mocked(getInFlightListingUpdates).mockResolvedValue([{
      id: 'lu_1', tenantId: 'tenant1', appId: '123', status: 'submitted',
      ascLocalizationId: 'loc_1', auditJobId: null, proposedFields: {},
      appliedFields: null, rejectionReason: null, submittedAt: new Date(), resolvedAt: null, createdAt: new Date(),
    }]);
    vi.mocked(loadCredentials).mockResolvedValue({ ok: true, value: { keyId: 'K1', issuerId: 'I1', privateKeyPem: '---' } });
    mockGatewayFetch.mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'v1', attributes: { appStoreState: 'READY_FOR_SALE', versionString: '2.0' } }],
    }), { status: 200 }));

    const { runListingUpdateCheck } = await import('./listing-update-checker');
    await runListingUpdateCheck(mockSql);

    expect(setListingUpdateStatus).toHaveBeenCalledWith(
      mockSql, 'lu_1', 'approved', null, expect.any(Date),
    );
    expect(insertChangeEvent).toHaveBeenCalledWith(
      mockSql, 'tenant1',
      expect.objectContaining({ eventType: 'listing_update_resolved', payload: expect.objectContaining({ status: 'approved' }) }),
    );
  });

  it('marks update rejected when ASC state is REJECTED', async () => {
    const { getInFlightListingUpdates, setListingUpdateStatus } = await import('../queue/listing-update-store');
    const { loadCredentials } = await import('../asc/credential-store');

    vi.mocked(getInFlightListingUpdates).mockResolvedValue([{
      id: 'lu_2', tenantId: 'tenant1', appId: '123', status: 'in_review',
      ascLocalizationId: 'loc_1', auditJobId: null, proposedFields: {},
      appliedFields: null, rejectionReason: null, submittedAt: new Date(), resolvedAt: null, createdAt: new Date(),
    }]);
    vi.mocked(loadCredentials).mockResolvedValue({ ok: true, value: { keyId: 'K1', issuerId: 'I1', privateKeyPem: '---' } });
    mockGatewayFetch.mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'v1', attributes: { appStoreState: 'REJECTED', versionString: '2.0' } }],
    }), { status: 200 }));

    const { runListingUpdateCheck } = await import('./listing-update-checker');
    await runListingUpdateCheck(mockSql);

    expect(setListingUpdateStatus).toHaveBeenCalledWith(
      mockSql, 'lu_2', 'rejected', null, expect.any(Date),
    );
  });

  it('updates status to in_review when ASC state is IN_REVIEW', async () => {
    const { getInFlightListingUpdates, setListingUpdateStatus } = await import('../queue/listing-update-store');
    const { loadCredentials } = await import('../asc/credential-store');

    vi.mocked(getInFlightListingUpdates).mockResolvedValue([{
      id: 'lu_3', tenantId: 'tenant1', appId: '123', status: 'submitted',
      ascLocalizationId: 'loc_1', auditJobId: null, proposedFields: {},
      appliedFields: null, rejectionReason: null, submittedAt: new Date(), resolvedAt: null, createdAt: new Date(),
    }]);
    vi.mocked(loadCredentials).mockResolvedValue({ ok: true, value: { keyId: 'K1', issuerId: 'I1', privateKeyPem: '---' } });
    mockGatewayFetch.mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'v1', attributes: { appStoreState: 'IN_REVIEW', versionString: '2.0' } }],
    }), { status: 200 }));

    const { runListingUpdateCheck } = await import('./listing-update-checker');
    await runListingUpdateCheck(mockSql);

    expect(setListingUpdateStatus).toHaveBeenCalledWith(
      mockSql, 'lu_3', 'in_review', null, null,
    );
  });
});
