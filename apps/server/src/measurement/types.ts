import type { ReportRow } from '../asc/types';

export type WindowState =
  | 'awaiting_baseline'
  | 'polling_baseline'
  | 'awaiting_after'
  | 'polling_after'
  | 'closed'
  | 'error';

export type MeasurementWindow = {
  id: string;
  tenantId: string;
  appId: string;
  country: string;
  versionString: string;
  recKeys: string[];
  mixedAuthorship: boolean;
  openedAt: string; // ISO-8601
  regime: 'correlational';
  state: WindowState;
  baselineRequestId: string | null;
  afterRequestId: string | null;
  baselineJson: ReportRow[] | null;
  afterJson: ReportRow[] | null;
  verdictJson: VerdictJson | null;
  errorMessage: string | null;
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
};

export type VerdictMetrics = {
  before: number;
  after: number;
  deltaPercent: number;
};

export type VerdictJson = {
  regime: 'correlational';
  windowDays: 28;
  metrics: {
    impressions: VerdictMetrics;
    downloads: VerdictMetrics;
    conversionRate: VerdictMetrics;
  };
  mixedAuthorship: boolean;
  disclaimer: string;
};
