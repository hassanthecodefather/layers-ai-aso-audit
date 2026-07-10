export type AscError =
  | { kind: 'auth_failed';    status: number }
  | { kind: 'not_found';      appId: string }
  | { kind: 'rate_limited';   retryAfterMs: number }
  | { kind: 'api_error';      status: number; detail: string }
  | { kind: 'parse_error';    raw: string }
  | { kind: 'no_credentials'; tenantId: string };

export type AppVersion = {
  versionString: string;
  state: string;
  createdDate: string;
  earliestReleaseDate: string | null;
};

export type ReportType = 'APP_STORE_ENGAGEMENT';

export type ReportFilters = {
  appId: string;
  frequency: 'DAILY';
  startDate: string;
  endDate: string;
};

export type ReportRow = {
  date: string;
  impressions: number;
  downloads: number;
  conversionRate: number;
  territory: string;
};

export type ReportPollResult =
  | { status: 'pending' }
  | { status: 'ready'; rows: ReportRow[] };
