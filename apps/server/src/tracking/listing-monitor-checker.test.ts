import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

const mockSql = vi.fn().mockResolvedValue([]) as unknown as postgres.Sql;

vi.mock('../queue/listing-monitor-store', () => ({
  getMonitorsInStatus: vi.fn().mockResolvedValue([]),
  setMonitorBaselineRequest: vi.fn(),
  setMonitorBaseline: vi.fn(),
  setMonitorAfterRequest: vi.fn(),
  setMonitorAlerted: vi.fn(),
  setMonitorClosed: vi.fn(),
  forceCloseStaleMonitors: vi.fn(),
}));

vi.mock('../asc/credential-store', () => ({
  loadCredentials: vi.fn(),
}));

const mockCreateRequest = vi.fn();
const mockPollInstance = vi.fn();
vi.mock('../asc/analytics-client', () => ({
  getAscAnalyticsClient: vi.fn(() => ({
    createReportRequest: mockCreateRequest,
    pollReportInstance: mockPollInstance,
  })),
}));

vi.mock('./store', () => ({
  insertChangeEvent: vi.fn(),
}));

const baseMonitor = {
  id: 'lm_1', tenantId: 'tenant1', appId: '123', listingUpdateId: 'lu_1',
  baselineRequestId: null, afterRequestId: null,
  baselineMetrics: null, latestMetrics: null,
  alertFiredAt: null, closedAt: null,
  approvedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), // 3 days ago
  createdAt: new Date(),
};

describe('runListingMonitorCheck', () => {
  beforeEach(() => {
    vi.resetModules();
    mockCreateRequest.mockReset();
    mockPollInstance.mockReset();
  });

  it('does nothing when no monitors in any status', async () => {
    const { getMonitorsInStatus } = await import('../queue/listing-monitor-store');
    vi.mocked(getMonitorsInStatus).mockResolvedValue([]);
    const { runListingMonitorCheck } = await import('./listing-monitor-checker');
    await expect(runListingMonitorCheck(mockSql)).resolves.toBeUndefined();
    expect(mockCreateRequest).not.toHaveBeenCalled();
  });

  it('submits baseline request for pending_baseline monitor past 48h', async () => {
    const { getMonitorsInStatus, setMonitorBaselineRequest } = await import('../queue/listing-monitor-store');
    const { loadCredentials } = await import('../asc/credential-store');
    vi.mocked(getMonitorsInStatus).mockImplementation(async (_, status) =>
      status === 'pending_baseline' ? [{ ...baseMonitor, status: 'pending_baseline' }] : []
    );
    vi.mocked(loadCredentials).mockResolvedValue({ ok: true, value: { keyId: 'K1', issuerId: 'I1', privateKeyPem: '---' } });
    mockCreateRequest.mockResolvedValue({ ok: true, value: 'req_123' });

    const { runListingMonitorCheck } = await import('./listing-monitor-checker');
    await runListingMonitorCheck(mockSql);

    expect(mockCreateRequest).toHaveBeenCalledWith('APP_STORE_ENGAGEMENT', expect.objectContaining({ appId: '123', frequency: 'DAILY' }));
    expect(setMonitorBaselineRequest).toHaveBeenCalledWith(mockSql, 'lm_1', 'req_123');
  });

  it('does not submit baseline for monitor within 48h of approval', async () => {
    const { getMonitorsInStatus } = await import('../queue/listing-monitor-store');
    const recentMonitor = { ...baseMonitor, approvedAt: new Date(Date.now() - 1 * 60 * 60 * 1000) }; // 1 hour ago
    vi.mocked(getMonitorsInStatus).mockImplementation(async (_, status) =>
      status === 'pending_baseline' ? [{ ...recentMonitor, status: 'pending_baseline' }] : []
    );

    const { runListingMonitorCheck } = await import('./listing-monitor-checker');
    await runListingMonitorCheck(mockSql);

    expect(mockCreateRequest).not.toHaveBeenCalled();
  });

  it('stores baseline metrics when poll returns ready', async () => {
    const { getMonitorsInStatus, setMonitorBaseline } = await import('../queue/listing-monitor-store');
    const { loadCredentials } = await import('../asc/credential-store');
    const pollingMonitor = { ...baseMonitor, status: 'polling_baseline', baselineRequestId: 'req_abc' };
    vi.mocked(getMonitorsInStatus).mockImplementation(async (_, status) =>
      status === 'polling_baseline' ? [pollingMonitor] : []
    );
    vi.mocked(loadCredentials).mockResolvedValue({ ok: true, value: { keyId: 'K1', issuerId: 'I1', privateKeyPem: '---' } });
    mockPollInstance.mockResolvedValue({
      ok: true,
      value: {
        status: 'ready',
        rows: [
          { date: '2026-07-01', impressions: 1000, downloads: 200, conversionRate: 0.2, territory: 'US' },
          { date: '2026-07-02', impressions: 1100, downloads: 210, conversionRate: 0.19, territory: 'US' },
        ],
      },
    });

    const { runListingMonitorCheck } = await import('./listing-monitor-checker');
    await runListingMonitorCheck(mockSql);

    expect(setMonitorBaseline).toHaveBeenCalledWith(mockSql, 'lm_1', {
      impressions: 2100,
      downloads: 410,
      conversionRate: expect.closeTo(0.195, 3),
    });
  });

  it('fires alert when threshold is breached', async () => {
    const { getMonitorsInStatus, setMonitorAlerted } = await import('../queue/listing-monitor-store');
    const { loadCredentials } = await import('../asc/credential-store');
    const { insertChangeEvent } = await import('./store');
    const ninedays = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000);
    const monitoringMonitor = {
      ...baseMonitor, status: 'polling_after', afterRequestId: 'req_after',
      approvedAt: ninedays,
      baselineMetrics: { impressions: 1000, downloads: 200, conversionRate: 0.2 },
    };
    vi.mocked(getMonitorsInStatus).mockImplementation(async (_, status) =>
      status === 'polling_after' ? [monitoringMonitor] : []
    );
    vi.mocked(loadCredentials).mockResolvedValue({ ok: true, value: { keyId: 'K1', issuerId: 'I1', privateKeyPem: '---' } });
    mockPollInstance.mockResolvedValue({
      ok: true,
      value: {
        status: 'ready',
        rows: [
          // −20% conversion, −20% impressions, −20% downloads → all thresholds breached
          { date: '2026-07-10', impressions: 800, downloads: 160, conversionRate: 0.16, territory: 'US' },
        ],
      },
    });

    const { runListingMonitorCheck } = await import('./listing-monitor-checker');
    await runListingMonitorCheck(mockSql);

    expect(setMonitorAlerted).toHaveBeenCalled();
    expect(insertChangeEvent).toHaveBeenCalledWith(
      mockSql, 'tenant1',
      expect.objectContaining({ eventType: 'listing_update_alert' }),
    );
  });

  it('closes monitor when threshold is NOT breached', async () => {
    const { getMonitorsInStatus, setMonitorClosed } = await import('../queue/listing-monitor-store');
    const { loadCredentials } = await import('../asc/credential-store');
    const ninedays = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000);
    const pollingAfterMonitor = {
      ...baseMonitor, status: 'polling_after', afterRequestId: 'req_after',
      approvedAt: ninedays,
      baselineMetrics: { impressions: 1000, downloads: 200, conversionRate: 0.2 },
    };
    vi.mocked(getMonitorsInStatus).mockImplementation(async (_, status) =>
      status === 'polling_after' ? [pollingAfterMonitor] : []
    );
    vi.mocked(loadCredentials).mockResolvedValue({ ok: true, value: { keyId: 'K1', issuerId: 'I1', privateKeyPem: '---' } });
    mockPollInstance.mockResolvedValue({
      ok: true,
      value: {
        status: 'ready',
        // Metrics only dropped 5% — below threshold
        rows: [{ date: '2026-07-10', impressions: 950, downloads: 190, conversionRate: 0.19, territory: 'US' }],
      },
    });

    const { runListingMonitorCheck } = await import('./listing-monitor-checker');
    await runListingMonitorCheck(mockSql);

    expect(setMonitorClosed).toHaveBeenCalledWith(mockSql, 'lm_1');
  });
});
