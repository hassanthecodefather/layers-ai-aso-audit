import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { startAudit, pollStatus, confirmAudit } from '../lib/api';
import type { AppSummary, AuditReport, Conflict, ResolvedIdentity, IdentityDecision } from '../lib/types';

export type ChatMessage =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'agent'; text: string }
  | {
      id: string; kind: 'confirmation';
      summary: AppSummary; identity: ResolvedIdentity | null;
      identityNeedsConfirm: boolean; decision: 'pending' | 'yes' | 'no';
    }
  | { id: string; kind: 'progress'; step: string | null; complete: boolean }
  | { id: string; kind: 'report'; report: AuditReport; auditJobId: string }
  | { id: string; kind: 'error'; text: string }
  | { id: string; kind: 'challenge'; conflict: Conflict; decision: 'pending' | 'yes' | 'no' };

export type AuditStatus = 'idle' | 'starting' | 'running' | 'confirming' | 'done';

export interface UseAudit {
  messages: ChatMessage[];
  status: AuditStatus;
  busy: boolean;
  submitUrl: (url: string, opts?: { advancedAudit?: boolean }) => void;
  confirm: (identityDecision?: IdentityDecision | null) => void;
  confirmAnyway: () => void;
  reject: () => void;
  reopenIdentity: () => void;
}

const POLL_INTERVAL_MS = 2500;

let sequence = 0;
const nextId = (): string => `m${++sequence}`;

export function useAudit(): UseAudit {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<AuditStatus>('idle');
  const [runId, setRunId] = useState<string | null>(null);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const [pendingDecision, setPendingDecision] = useState<IdentityDecision | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const consecutiveErrors = useRef(0);

  const add = useCallback((message: ChatMessage) => {
    setMessages((prev) => [...prev, message]);
  }, []);

  const patch = useCallback((id: string, update: (m: ChatMessage) => ChatMessage) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? update(m) : m)));
  }, []);

  // Stop any running poll loop.
  const stopPolling = useCallback(() => {
    if (pollTimer.current !== null) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  // Start polling GET /audit/status/:runId every POLL_INTERVAL_MS.
  // progressId: the id of the progress message to update with step names.
  const startPolling = useCallback((rid: string, progressId: string) => {
    async function tick() {
      try {
        const s = await pollStatus(rid);
        // Reset consecutive error counter on any successful response.
        consecutiveErrors.current = 0;

        if (s.status === 'pending' || s.status === 'running') {
          patch(progressId, (m) =>
            m.kind === 'progress' ? { ...m, step: s.step ?? null } : m,
          );
          pollTimer.current = setTimeout(tick, POLL_INTERVAL_MS);

        } else if (s.status === 'awaiting_confirmation') {
          stopPolling();
          const payload = s.suspendPayload;
          if (!payload) {
            add({ id: nextId(), kind: 'error', text: 'Audit paused but no confirmation data received.' });
            setStatus('idle');
            return;
          }
          patch(progressId, (m) => m.kind === 'progress' ? { ...m, complete: true } : m);

          if (payload.conflict) {
            // Re-suspend with a challenge — show the challenge card.
            setMessages((prev) =>
              prev.map((m) =>
                m.kind === 'confirmation' && m.decision === 'yes'
                  ? { ...m, decision: 'pending' as const }
                  : m,
              ),
            );
            add({ id: nextId(), kind: 'challenge', conflict: payload.conflict, decision: 'pending' });
          } else {
            // Initial suspend — show the confirmation card.
            add({
              id: nextId(), kind: 'confirmation',
              summary: payload.summary,
              identity: payload.identity,
              identityNeedsConfirm: payload.identityNeedsConfirm,
              decision: 'pending',
            });
          }
          setStatus('confirming');

        } else if (s.status === 'done') {
          stopPolling();
          patch(progressId, (m) => m.kind === 'progress' ? { ...m, complete: true } : m);
          if (s.result) {
            add({ id: nextId(), kind: 'report', report: s.result, auditJobId: s.jobId });
            add({ id: nextId(), kind: 'agent', text: 'Audit complete. Paste another App Store URL to run another.' });
          }
          setStatus('done');
          setRunId(null);

        } else if (s.status === 'failed') {
          stopPolling();
          patch(progressId, (m) => m.kind === 'progress' ? { ...m, complete: true } : m);
          if (s.attempt < s.maxAttempts) {
            // Still retrying — resume polling.
            add({ id: nextId(), kind: 'agent', text: `Retrying… (attempt ${s.attempt} of ${s.maxAttempts})` });
            pollTimer.current = setTimeout(tick, POLL_INTERVAL_MS * 2);
          } else {
            add({ id: nextId(), kind: 'error', text: s.errorMessage ?? 'The audit failed.' });
            setStatus('idle');
            setRunId(null);
          }
        }
      } catch (err) {
        // Transient network error — keep polling, but stop after 5 consecutive failures.
        consecutiveErrors.current += 1;
        if (consecutiveErrors.current >= 5) {
          stopPolling();
          add({ id: nextId(), kind: 'error', text: 'Lost connection to the server. Please refresh and try again.' });
          setStatus('idle');
          setRunId(null);
          return;
        }
        pollTimer.current = setTimeout(tick, POLL_INTERVAL_MS);
      }
    }
    pollTimer.current = setTimeout(tick, POLL_INTERVAL_MS);
  }, [add, patch, stopPolling]);

  // Clean up on unmount.
  useEffect(() => () => stopPolling(), [stopPolling]);

  const submitUrl = useCallback((raw: string, opts?: { advancedAudit?: boolean }) => {
    const url = raw.trim();
    if (!url || status === 'starting' || status === 'running') return;

    stopPolling();
    add({ id: nextId(), kind: 'user', text: url });
    setPendingUrl(url);
    setStatus('starting');

    const thinkingId = nextId();
    add({ id: thinkingId, kind: 'agent', text: 'Queuing audit…' });

    startAudit(url, opts)
      .then(({ runId: rid }) => {
        setRunId(rid);
        const progressId = nextId();
        patch(thinkingId, () => ({
          id: thinkingId, kind: 'agent' as const,
          text: 'Audit queued — identifying app…',
        }));
        add({ id: progressId, kind: 'progress', step: null, complete: false });
        setStatus('running');
        startPolling(rid, progressId);
      })
      .catch((e: unknown) => {
        patch(thinkingId, () => ({
          id: thinkingId, kind: 'error' as const,
          text: e instanceof Error ? e.message : 'Could not start audit.',
        }));
        setStatus('idle');
      });
  }, [status, add, patch, stopPolling, startPolling]);

  const confirm = useCallback((identityDecision?: IdentityDecision | null) => {
    if (status !== 'confirming' || !runId) return;

    setMessages((prev) =>
      prev.map((m) =>
        m.kind === 'confirmation' && m.decision === 'pending'
          ? { ...m, decision: 'yes' as const }
          : m,
      ),
    );
    setPendingDecision(identityDecision ?? null);
    setStatus('running');

    const progressId = nextId();
    add({ id: progressId, kind: 'progress', step: null, complete: false });

    confirmAudit({ runId, identityDecision: identityDecision ?? null })
      .then(() => {
        stopPolling();
        startPolling(runId, progressId);
      })
      .catch((e: unknown) => {
        add({ id: nextId(), kind: 'error', text: e instanceof Error ? e.message : 'Confirmation failed.' });
        setStatus('idle');
      });
  }, [status, runId, add, startPolling]);

  const confirmAnyway = useCallback(() => {
    if (status !== 'confirming' || !runId) return;

    setMessages((prev) =>
      prev.map((m) =>
        m.kind === 'challenge' && m.decision === 'pending'
          ? { ...m, decision: 'yes' as const }
          : m,
      ),
    );
    setStatus('running');

    const progressId = nextId();
    add({ id: progressId, kind: 'progress', step: null, complete: false });

    confirmAudit({ runId, identityDecision: pendingDecision, overrideAcknowledged: true })
      .then(() => {
        stopPolling();
        startPolling(runId, progressId);
      })
      .catch((e: unknown) => {
        add({ id: nextId(), kind: 'error', text: e instanceof Error ? e.message : 'Confirmation failed.' });
        setStatus('idle');
      });
  }, [status, runId, pendingDecision, add, startPolling]);

  const reopenIdentity = useCallback(() => {
    if (!pendingUrl || status !== 'confirming') return;
    stopPolling();
    setMessages((prev) => prev.filter((m) => m.kind !== 'confirmation'));
    setRunId(null);
    setStatus('starting');

    const thinkingId = nextId();
    add({ id: thinkingId, kind: 'agent', text: 'Re-opening identity — resolving fresh…' });

    startAudit(pendingUrl, { reopenIdentity: true })
      .then(({ runId: rid }) => {
        setRunId(rid);
        const progressId = nextId();
        patch(thinkingId, () => ({
          id: thinkingId, kind: 'agent' as const,
          text: 'Queued with fresh identity resolve — identifying app…',
        }));
        add({ id: progressId, kind: 'progress', step: null, complete: false });
        setStatus('running');
        startPolling(rid, progressId);
      })
      .catch((e: unknown) => {
        patch(thinkingId, () => ({
          id: thinkingId, kind: 'error' as const,
          text: e instanceof Error ? e.message : 'Could not re-identify the app.',
        }));
        setStatus('idle');
      });
  }, [pendingUrl, status, add, patch, stopPolling, startPolling]);

  const reject = useCallback(() => {
    if (status !== 'confirming') return;
    stopPolling();
    setMessages((prev) =>
      prev.map((m) =>
        m.kind === 'confirmation' && m.decision === 'pending'
          ? { ...m, decision: 'no' as const }
          : m,
      ),
    );
    add({ id: nextId(), kind: 'agent', text: "No problem — paste the correct App Store URL and I'll take another look." });
    setStatus('idle');
    setRunId(null);
  }, [status, add, stopPolling]);

  const busy = status === 'starting' || status === 'running';

  return useMemo(
    () => ({ messages, status, busy, submitUrl, confirm, confirmAnyway, reject, reopenIdentity }),
    [messages, status, busy, submitUrl, confirm, confirmAnyway, reject, reopenIdentity],
  );
}
