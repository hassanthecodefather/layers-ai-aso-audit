import { getAscAnalyticsClient } from '../asc/analytics-client';
import type { AscCredentials } from '../asc/credential-store';
import type { ReportRow } from '../asc/types';

export async function requestReport(
  creds: AscCredentials,
  appId: string,
  _country: string,
  startDate: string,
  endDate: string,
): Promise<string> {
  const result = await getAscAnalyticsClient(creds).createReportRequest('APP_STORE_ENGAGEMENT', {
    appId,
    frequency: 'DAILY',
    startDate,
    endDate,
  });
  if (!result.ok) {
    throw new Error(`createReportRequest failed: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

export async function pollReport(
  creds: AscCredentials,
  requestId: string,
): Promise<{ status: 'pending' } | { status: 'ready'; rows: ReportRow[] }> {
  const result = await getAscAnalyticsClient(creds).pollReportInstance(requestId);
  if (!result.ok) {
    throw new Error(`pollReportInstance failed: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}
