export type ChangeEventType = 'go_live' | 'metadata_changed' | 'reviews_shifted' | 'version_status' | 'measurement_verdict' | 'listing_update_resolved';

export type TrackedApp = {
  appId: string;
  country: string;
  bundleId: string;
  appName: string;
  url: string;
  enabled: boolean;
  enabledAt: string;
  lastScannedAt: string | null;
};

export type ChangeEvent = {
  id: string;
  tenantId: string;
  appId: string;
  country: string;
  eventType: ChangeEventType;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type ActivityEvent = {
  id: string;
  appId: string;
  appName: string;
  country: string;
  eventType: 'go_live' | 'metadata_changed' | 'reviews_shifted' | 'measurement_verdict';
  payload: Record<string, unknown>;
  createdAt: string;
};
