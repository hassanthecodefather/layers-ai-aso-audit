import { signAscToken } from './auth';
import { getGateway } from '../cost/gateway';
import { ok, err } from '../domain/result';
import type { Result } from '../domain/result';
import type { ReportType, ReportFilters, ReportRow, ReportPollResult, AscError } from './types';
import type { AscCredentials } from './credential-store';

const ASC_BASE = 'https://api.appstoreconnect.apple.com';

export interface AscAnalyticsClient {
  createReportRequest(type: ReportType, filters: ReportFilters): Promise<Result<string, AscError>>;
  pollReportInstance(requestId: string): Promise<Result<ReportPollResult, AscError>>;
}

export class AppleAscAnalyticsClient implements AscAnalyticsClient {
  constructor(private readonly creds: AscCredentials) {}

  async createReportRequest(
    type: ReportType,
    filters: ReportFilters,
  ): Promise<Result<string, AscError>> {
    const token = signAscToken(this.creds.keyId, this.creds.issuerId, this.creds.privateKeyPem);
    const url = `${ASC_BASE}/v1/analyticsReportRequests`;

    let response: Response;
    try {
      response = await getGateway().fetch(url, { kind: 'app', upstream: 'asc' }, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          data: {
            type: 'analyticsReportRequests',
            attributes: {
              accessType: 'ONE_TIME_SNAPSHOT',
            },
            relationships: {
              app: {
                data: { type: 'apps', id: filters.appId },
              },
            },
          },
        }),
      });
    } catch (e) {
      return err({ kind: 'api_error', status: 0, detail: String(e) });
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return err({ kind: 'auth_failed', status: response.status });
      }
      const detail = await response.text().catch(() => '');
      return err({ kind: 'api_error', status: response.status, detail: detail.slice(0, 200) });
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      return err({ kind: 'parse_error', raw: 'non-JSON response from createReportRequest' });
    }

    const requestId = (data as { data?: { id?: string } })?.data?.id;
    if (!requestId) {
      return err({ kind: 'parse_error', raw: JSON.stringify(data).slice(0, 200) });
    }

    return ok(requestId);
  }

  async pollReportInstance(requestId: string): Promise<Result<ReportPollResult, AscError>> {
    const token = signAscToken(this.creds.keyId, this.creds.issuerId, this.creds.privateKeyPem);

    // NOTE: This Analytics Reports API shape (request body, URL structure, TSV download)
    // is based on Apple's documentation but has NOT been verified against real API responses.
    // After live testing, adjust field names, URL paths, and data format as needed.

    // Step 1: list reports for this request
    const reportsUrl = `${ASC_BASE}/v1/analyticsReportRequests/${encodeURIComponent(requestId)}/reports`;
    let reportsRes: Response;
    try {
      reportsRes = await getGateway().fetch(reportsUrl, { kind: 'app', upstream: 'asc' }, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (e) {
      return err({ kind: 'api_error', status: 0, detail: String(e) });
    }

    if (!reportsRes.ok) {
      const detail = await reportsRes.text().catch(() => '');
      return err({ kind: 'api_error', status: reportsRes.status, detail: detail.slice(0, 200) });
    }

    const reportsData = await reportsRes.json().catch(() => null);
    const reports = (reportsData as { data?: unknown[] })?.data;
    if (!reports || reports.length === 0) return ok({ status: 'pending' });

    // Step 2: get instances for the first report
    const reportId = (reports[0] as { id?: string })?.id;
    if (!reportId) return ok({ status: 'pending' });

    const instancesUrl = `${ASC_BASE}/v1/analyticsReports/${encodeURIComponent(reportId)}/instances`;
    let instancesRes: Response;
    try {
      instancesRes = await getGateway().fetch(instancesUrl, { kind: 'app', upstream: 'asc' }, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (e) {
      return err({ kind: 'api_error', status: 0, detail: String(e) });
    }

    if (!instancesRes.ok) {
      const detail = await instancesRes.text().catch(() => '');
      return err({ kind: 'api_error', status: instancesRes.status, detail: detail.slice(0, 200) });
    }

    const instancesData = await instancesRes.json().catch(() => null);
    const instances = (instancesData as { data?: unknown[] })?.data;
    if (!instances || instances.length === 0) return ok({ status: 'pending' });

    // Step 3: download the first instance's segments
    const instanceId = (instances[0] as { id?: string })?.id;
    if (!instanceId) return ok({ status: 'pending' });

    const segmentsUrl = `${ASC_BASE}/v1/analyticsReportInstances/${encodeURIComponent(instanceId)}/segments`;
    let segmentsRes: Response;
    try {
      segmentsRes = await getGateway().fetch(segmentsUrl, { kind: 'app', upstream: 'asc' }, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (e) {
      return err({ kind: 'api_error', status: 0, detail: String(e) });
    }

    if (!segmentsRes.ok) {
      const detail = await segmentsRes.text().catch(() => '');
      return err({ kind: 'api_error', status: segmentsRes.status, detail: detail.slice(0, 200) });
    }

    const segmentsData = await segmentsRes.json().catch(() => null);
    const segments = (segmentsData as { data?: unknown[] })?.data;
    if (!segments || segments.length === 0) return ok({ status: 'pending' });

    // Step 4: download the actual data from the first segment URL
    const downloadUrl = (segments[0] as { attributes?: { url?: string } })?.attributes?.url;
    if (!downloadUrl) return ok({ status: 'pending' });

    let downloadRes: Response;
    try {
      downloadRes = await getGateway().fetch(downloadUrl, { kind: 'app', upstream: 'asc' }, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (e) {
      return err({ kind: 'api_error', status: 0, detail: String(e) });
    }

    if (!downloadRes.ok) {
      const detail = await downloadRes.text().catch(() => '');
      return err({ kind: 'api_error', status: downloadRes.status, detail: detail.slice(0, 200) });
    }

    const text = await downloadRes.text().catch(() => '');
    const rows = parseReportCsv(text);
    return ok({ status: 'ready', rows });
  }
}

function parseReportCsv(csv: string): ReportRow[] {
  const lines = csv.split('\n').filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split('\t').map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const cols = line.split('\t');
    const get = (name: string) => cols[headers.indexOf(name)] ?? '';
    return {
      date: get('date'),
      impressions: Number(get('impressions')) || 0,
      downloads: Number(get('total downloads')) || Number(get('downloads')) || 0,
      conversionRate: Number(get('conversion rate')) || 0,
      territory: get('territory') || get('storefront'),
    };
  }).filter((r) => r.date);
}

export class StubAscAnalyticsClient implements AscAnalyticsClient {
  #nextId = 1;
  constructor(private readonly rows: ReportRow[]) {}

  async createReportRequest(
    _type: ReportType,
    _filters: ReportFilters,
  ): Promise<Result<string, AscError>> {
    return ok(`stub-request-${this.#nextId++}`);
  }

  async pollReportInstance(_requestId: string): Promise<Result<ReportPollResult, AscError>> {
    return ok({ status: 'ready', rows: this.rows });
  }
}

export class NoOpAscAnalyticsClient implements AscAnalyticsClient {
  async createReportRequest(
    _type: ReportType,
    _filters: ReportFilters,
  ): Promise<Result<string, AscError>> {
    return ok('noop-request-id');
  }

  async pollReportInstance(_requestId: string): Promise<Result<ReportPollResult, AscError>> {
    return ok({ status: 'pending' });
  }
}

export function getAscAnalyticsClient(creds: AscCredentials): AscAnalyticsClient {
  return new AppleAscAnalyticsClient(creds);
}
