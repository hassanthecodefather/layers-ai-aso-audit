import type { AppSummary, AuditReport, ProgressEvent, ResolvedIdentity, IdentityDecision } from './types';

/**
 * The client side of the two audit endpoints. `/audit` is proxied to the
 * Mastra server by Vite (see `vite.config.ts`), so these stay same-origin.
 */

export interface IdentifyResult {
  runId: string;
  summary: AppSummary;
  identity: ResolvedIdentity | null;
  identityNeedsConfirm: boolean;
}

/** Turn 1 — resolve a pasted URL to an app summary for confirmation. */
export async function identifyApp(url: string): Promise<IdentifyResult> {
  const res = await fetch('/audit/identify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<IdentifyResult> & {
    error?: string;
  };
  if (!res.ok || !data.runId || !data.summary) {
    throw new Error(data.error ?? 'Could not identify that app.');
  }
  return {
    runId: data.runId,
    summary: data.summary,
    identity: data.identity ?? null,
    identityNeedsConfirm: data.identityNeedsConfirm ?? false,
  };
}

export interface AuditStreamHandlers {
  onProgress: (event: ProgressEvent) => void;
  onReport: (report: AuditReport) => void;
  onError: (message: string) => void;
}

/**
 * Turn 2 — resume the run and consume its Server-Sent Events: `progress`
 * lines while the audit runs, then a single `report` (or `error`).
 */
export async function runAudit(
  runId: string,
  handlers: AuditStreamHandlers,
  identityDecision?: IdentityDecision | null,
): Promise<void> {
  const res = await fetch('/audit/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId, identityDecision: identityDecision ?? null }),
  });

  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    handlers.onError(data.error ?? 'Could not start the audit.');
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line.
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) dispatchFrame(frame, handlers);
  }
}

function dispatchFrame(frame: string, handlers: AuditStreamHandlers): void {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return;

  let data: unknown;
  try {
    data = JSON.parse(dataLines.join('\n'));
  } catch {
    return;
  }

  if (event === 'progress') handlers.onProgress(data as ProgressEvent);
  else if (event === 'report') handlers.onReport(data as AuditReport);
  else if (event === 'error') {
    handlers.onError((data as { message?: string }).message ?? 'Audit failed.');
  }
}

export interface Health {
  llm: { provider: string; model: string; endpoint: string; reachable: boolean };
  crawler: { id: string; available: boolean };
}

/** Capability probe — whether the LLM is reachable and Firecrawl configured. */
export async function fetchHealth(): Promise<Health> {
  const res = await fetch('/audit/health');
  if (!res.ok) throw new Error('Server unavailable.');
  return res.json();
}
