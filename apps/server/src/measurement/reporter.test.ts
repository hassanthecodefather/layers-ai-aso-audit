import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AscCredentials } from '../asc/credential-store';
import type { ReportRow } from '../asc/types';

const mockCreateReportRequest = vi.fn();
const mockPollReportInstance = vi.fn();

vi.mock('../asc/analytics-client', () => ({
  getAscAnalyticsClient: () => ({
    createReportRequest: (...args: any[]) => mockCreateReportRequest(...args),
    pollReportInstance: (...args: any[]) => mockPollReportInstance(...args),
  }),
}));

import { requestReport, pollReport } from './reporter';

const creds: AscCredentials = { keyId: 'k', issuerId: 'i', privateKeyPem: 'pem' };

describe('reporter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requestReport calls createReportRequest with correct appId, frequency, startDate, endDate', async () => {
    mockCreateReportRequest.mockResolvedValueOnce({ ok: true, value: 'req-1' });
    await requestReport(creds, 'APP1', 'us', '2026-05-04', '2026-06-01');
    expect(mockCreateReportRequest).toHaveBeenCalledWith('APP_STORE_ENGAGEMENT', {
      appId: 'APP1',
      frequency: 'DAILY',
      startDate: '2026-05-04',
      endDate: '2026-06-01',
    });
  });

  it('requestReport returns the requestId string on success', async () => {
    mockCreateReportRequest.mockResolvedValueOnce({ ok: true, value: 'req-42' });
    const id = await requestReport(creds, 'APP1', 'us', '2026-05-04', '2026-06-01');
    expect(id).toBe('req-42');
  });

  it('requestReport throws when the client returns an error', async () => {
    mockCreateReportRequest.mockResolvedValueOnce({ ok: false, error: { kind: 'auth_failed', status: 401 } });
    await expect(requestReport(creds, 'APP1', 'us', '2026-05-04', '2026-06-01')).rejects.toThrow();
  });

  it('pollReport returns { status: "pending" } when client returns pending', async () => {
    mockPollReportInstance.mockResolvedValueOnce({ ok: true, value: { status: 'pending' } });
    const res = await pollReport(creds, 'req-1');
    expect(res).toEqual({ status: 'pending' });
  });

  it('pollReport returns { status: "ready", rows } and passes rows through when client returns ready', async () => {
    const rows: ReportRow[] = [
      { date: '2026-06-01', impressions: 10, downloads: 2, conversionRate: 20, territory: 'US' },
    ];
    mockPollReportInstance.mockResolvedValueOnce({ ok: true, value: { status: 'ready', rows } });
    const res = await pollReport(creds, 'req-1');
    expect(res).toEqual({ status: 'ready', rows });
  });

  it('pollReport throws when the client returns an error', async () => {
    mockPollReportInstance.mockResolvedValueOnce({ ok: false, error: { kind: 'no_credentials', tenantId: 't' } });
    await expect(pollReport(creds, 'req-1')).rejects.toThrow();
  });
});
