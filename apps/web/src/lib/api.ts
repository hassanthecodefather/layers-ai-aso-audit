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
export async function startAudit(url: string, reopenIdentity = false): Promise<StartAuditResult> {
  const res = await authedFetch('/audit/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, reopenIdentity }),
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
