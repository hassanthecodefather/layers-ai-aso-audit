import type { AppSummary, AuditReport, ResolvedIdentity, IdentityDecision, Conflict } from './types';

/**
 * The client side of the two audit endpoints. `/audit` is proxied to the
 * Mastra server by Vite (see `vite.config.ts`), so these stay same-origin.
 */

let _getToken: (() => string | null) | null = null;
let _refreshToken: (() => Promise<string | null>) | null = null;

export function setAuthCallbacks(
  getToken: () => string | null,
  refreshFn: () => Promise<string | null>,
): void {
  _getToken = getToken;
  _refreshToken = refreshFn;
}

async function authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = _getToken?.();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(url, { ...init, headers });

  if (res.status === 401 && _refreshToken) {
    res.body?.cancel();
    const newToken = await _refreshToken();
    if (newToken) {
      headers.set('Authorization', `Bearer ${newToken}`);
      return fetch(url, { ...init, headers });
    }
  }
  return res;
}

export interface StartAuditResult {
  jobId: string;
  runId: string;
  status: string;
}

/** Enqueue a new audit job and return immediately. */
export async function startAudit(
  url: string,
  opts?: { reopenIdentity?: boolean; advancedAudit?: boolean },
): Promise<StartAuditResult> {
  const res = await authedFetch('/audit/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, reopenIdentity: opts?.reopenIdentity, advancedAudit: opts?.advancedAudit }),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<StartAuditResult> & { error?: string };
  if (!res.ok || !data.runId) throw new Error(data.error ?? 'Could not start audit.');
  return data as StartAuditResult;
}

export interface AuditJobStatus {
  jobId: string;
  runId: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'awaiting_confirmation';
  step?: string;
  result?: AuditReport;
  errorMessage?: string;
  suspendPayload?: {
    summary: AppSummary;
    identity: ResolvedIdentity | null;
    identityNeedsConfirm: boolean;
    conflict?: Conflict;
  };
  attempt: number;
  maxAttempts: number;
}

/** Poll job status. Call every 2.5s while status is pending/running. */
export async function pollStatus(runId: string): Promise<AuditJobStatus> {
  const res = await authedFetch(`/audit/status/${runId}`);
  const data = (await res.json().catch(() => ({}))) as Partial<AuditJobStatus> & { error?: string };
  if (!res.ok) throw new Error(data.error ?? 'Could not fetch audit status.');
  return data as AuditJobStatus;
}

/** Confirm the app identity and re-queue the job for the worker. */
export async function confirmAudit(params: {
  runId: string;
  identityDecision?: IdentityDecision | null;
  overrideAcknowledged?: boolean;
  fresh?: boolean;
}): Promise<{ alreadyRunning?: boolean }> {
  const res = await authedFetch('/audit/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      runId: params.runId,
      identityDecision: params.identityDecision ?? null,
      overrideAcknowledged: params.overrideAcknowledged ?? false,
      fresh: params.fresh ?? false,
    }),
  });
  if (res.status === 409) {
    // Job is already running (concurrent duplicate click) — not an error.
    res.body?.cancel();
    return { alreadyRunning: true };
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? 'Could not confirm audit.');
  }
  return {};
}

export interface Health {
  llm: { provider: string; model: string; endpoint: string; reachable: boolean };
  crawler: { id: string; available: boolean };
}

/** Capability probe — whether the LLM is reachable and Firecrawl configured. */
export async function fetchHealth(): Promise<Health> {
  const res = await authedFetch('/audit/health');
  if (!res.ok) throw new Error('Server unavailable.');
  return res.json();
}

export interface AscStatus {
  connected: boolean;
  keyId: string | null;
}

export async function getAscStatus(): Promise<AscStatus> {
  const res = await authedFetch('/settings/asc');
  if (!res.ok) return { connected: false, keyId: null };
  return res.json() as Promise<AscStatus>;
}

export async function saveAscCredentials(
  keyId: string,
  issuerId: string,
  privateKey: string,
): Promise<void> {
  const res = await authedFetch('/settings/asc', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyId, issuerId, privateKey }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error ?? 'Failed to save credentials');
  }
}

export async function deleteAscCredentials(): Promise<void> {
  const res = await authedFetch('/settings/asc', { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to disconnect');
}

export interface TrackedApp {
  appId: string;
  country: string;
  bundleId: string;
  appName: string;
  url: string;
  enabled: boolean;
  enabledAt: string;
  lastScannedAt: string | null;
}

export async function getTrackedApps(): Promise<TrackedApp[]> {
  const res = await authedFetch('/tracking');
  if (!res.ok) throw new Error('Failed to fetch tracked apps');
  return res.json() as Promise<TrackedApp[]>;
}

export async function startTracking(params: {
  appId: string;
  country: string;
  bundleId?: string;
  appName: string;
  url: string;
}): Promise<void> {
  const res = await authedFetch('/tracking', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error('Failed to start tracking');
}

export async function stopTracking(appId: string): Promise<void> {
  const res = await authedFetch(`/tracking/${encodeURIComponent(appId)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to stop tracking');
}

export interface ActivityEvent {
  id: string;
  appId: string;
  appName: string;
  country: string;
  eventType: 'go_live' | 'metadata_changed' | 'reviews_shifted' | 'measurement_verdict' | 'listing_update_resolved';
  payload: Record<string, unknown>;
  createdAt: string;
}

export async function fetchActivity(limit = 20): Promise<ActivityEvent[]> {
  const res = await authedFetch(`/activity?limit=${limit}`);
  if (!res.ok) throw new Error('Failed to fetch activity');
  return res.json() as Promise<ActivityEvent[]>;
}

// — Listing Update types (mirrors server ProposedFields) —
export type ProposedFields = {
  title?: string;
  subtitle?: string;
  keywords?: string;
  description?: string;
  promotionalText?: string;
  releaseNotes?: string;
};

export type ListingUpdateStatus = 'draft' | 'submitted' | 'in_review' | 'approved' | 'rejected';

export interface ListingUpdate {
  id: string;
  tenantId: string;
  appId: string;
  auditJobId: string | null;
  proposedFields: ProposedFields;
  appliedFields: ProposedFields | null;
  ascLocalizationId: string | null;
  status: ListingUpdateStatus;
  rejectionReason: string | null;
  submittedAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface GenerateResult {
  updateId: string;
  proposedFields: ProposedFields;
  currentFields: Record<string, string | null>;
  status: ListingUpdateStatus;
}

export async function generateListingUpdate(auditJobId: string): Promise<GenerateResult> {
  const res = await authedFetch('/listing-update/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ auditJobId }),
  });
  if (!res.ok) throw new Error(`Generate failed: ${res.status}`);
  return res.json() as Promise<GenerateResult>;
}

export async function submitListingUpdate(
  updateId: string,
  approvedFields: ProposedFields,
): Promise<{ update: ListingUpdate }> {
  const res = await authedFetch('/listing-update/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ updateId, approvedFields }),
  });
  if (!res.ok) throw new Error(`Submit failed: ${res.status}`);
  return res.json() as Promise<{ update: ListingUpdate }>;
}

export async function getListingUpdateCurrent(appId: string): Promise<{ update: ListingUpdate | null }> {
  const res = await authedFetch(`/listing-update/${encodeURIComponent(appId)}/current`);
  if (!res.ok) throw new Error(`Current lookup failed: ${res.status}`);
  return res.json() as Promise<{ update: ListingUpdate | null }>;
}
