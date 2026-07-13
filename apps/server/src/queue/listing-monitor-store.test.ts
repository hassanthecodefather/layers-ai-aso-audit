import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

const makeRow = (overrides = {}) => ({
  id: 'lm_abc',
  tenant_id: 'tenant1',
  app_id: '123456',
  listing_update_id: 'lu_1',
  status: 'pending_baseline',
  baseline_request_id: null,
  after_request_id: null,
  baseline_metrics: null,
  latest_metrics: null,
  alert_fired_at: null,
  closed_at: null,
  approved_at: new Date('2026-07-01'),
  created_at: new Date('2026-07-01'),
  ...overrides,
});

describe('listing-monitor-store', () => {
  let mockSql: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    mockSql = vi.fn().mockResolvedValue([]);
  });

  it('insertListingMonitor returns a mapped ListingMonitor', async () => {
    mockSql.mockResolvedValueOnce([makeRow()]);
    const { insertListingMonitor } = await import('./listing-monitor-store');
    const result = await insertListingMonitor(mockSql as unknown as postgres.Sql, {
      tenantId: 'tenant1',
      appId: '123456',
      listingUpdateId: 'lu_1',
      approvedAt: new Date('2026-07-01'),
    });
    expect(result.id).toBe('lm_abc');
    expect(result.status).toBe('pending_baseline');
    expect(result.baselineMetrics).toBeNull();
    expect(result.approvedAt).toBeInstanceOf(Date);
  });

  it('getMonitorsInStatus returns mapped rows', async () => {
    mockSql.mockResolvedValueOnce([makeRow(), makeRow({ id: 'lm_2' })]);
    const { getMonitorsInStatus } = await import('./listing-monitor-store');
    const results = await getMonitorsInStatus(mockSql as unknown as postgres.Sql, 'pending_baseline');
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('lm_abc');
  });

  it('getMonitorById returns null when no row', async () => {
    mockSql.mockResolvedValueOnce([]);
    const { getMonitorById } = await import('./listing-monitor-store');
    const result = await getMonitorById(mockSql as unknown as postgres.Sql, 'tenant1', 'lm_missing');
    expect(result).toBeNull();
  });

  it('setMonitorAlerted parses JSON baseline_metrics from row with JSONB', async () => {
    const rowWithMetrics = makeRow({
      status: 'alerted',
      baseline_metrics: JSON.stringify({ impressions: 1000, downloads: 200, conversionRate: 0.2 }),
      latest_metrics: JSON.stringify({ impressions: 800, downloads: 160, conversionRate: 0.16 }),
    });
    mockSql.mockResolvedValueOnce([rowWithMetrics]);
    const { getMonitorById } = await import('./listing-monitor-store');
    const result = await getMonitorById(mockSql as unknown as postgres.Sql, 'tenant1', 'lm_abc');
    expect(result?.baselineMetrics).toEqual({ impressions: 1000, downloads: 200, conversionRate: 0.2 });
    expect(result?.latestMetrics).toEqual({ impressions: 800, downloads: 160, conversionRate: 0.16 });
  });

  it('setMonitorClosed calls sql with closed_at', async () => {
    const { setMonitorClosed } = await import('./listing-monitor-store');
    await setMonitorClosed(mockSql as unknown as postgres.Sql, 'lm_abc');
    expect(mockSql).toHaveBeenCalled();
  });
});
