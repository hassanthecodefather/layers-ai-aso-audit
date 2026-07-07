import { useCallback, useMemo, useState } from 'react';
import { identifyApp, runAudit } from '../lib/api';
import type { AppSummary, AuditReport, Conflict, ProgressEvent, ResolvedIdentity, IdentityDecision } from '../lib/types';

/**
 * The chat's state machine.
 *
 * `status` moves strictly: idle → identifying → confirming → auditing → done
 * (and back to idle on rejection or error). The UI renders off it, so illegal
 * transitions — confirming twice, submitting mid-audit — are simply ignored.
 * Messages are a discriminated union, so the view renders them with one
 * exhaustive switch.
 */

export type ChatMessage =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'agent'; text: string }
  | {
      id: string;
      kind: 'confirmation';
      summary: AppSummary;
      identity: ResolvedIdentity | null;
      identityNeedsConfirm: boolean;
      decision: 'pending' | 'yes' | 'no';
    }
  | { id: string; kind: 'progress'; events: ProgressEvent[]; complete: boolean }
  | { id: string; kind: 'report'; report: AuditReport }
  | { id: string; kind: 'error'; text: string }
  | { id: string; kind: 'challenge'; conflict: Conflict; decision: 'pending' | 'yes' | 'no' };

export type AuditStatus =
  | 'idle'
  | 'identifying'
  | 'confirming'
  | 'auditing'
  | 'done';

export interface UseAudit {
  messages: ChatMessage[];
  status: AuditStatus;
  /** True while a network turn is in flight — the composer is locked. */
  busy: boolean;
  submitUrl: (url: string) => void;
  confirm: (identityDecision?: IdentityDecision | null) => void;
  confirmAnyway: () => void;
  reject: () => void;
}

let sequence = 0;
const nextId = (): string => `m${++sequence}`;

export function useAudit(): UseAudit {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<AuditStatus>('idle');
  const [runId, setRunId] = useState<string | null>(null);
  const [pendingDecision, setPendingDecision] = useState<IdentityDecision | null>(null);

  const add = useCallback((message: ChatMessage) => {
    setMessages((prev) => [...prev, message]);
  }, []);

  const patch = useCallback(
    (id: string, update: (m: ChatMessage) => ChatMessage) => {
      setMessages((prev) => prev.map((m) => (m.id === id ? update(m) : m)));
    },
    [],
  );

  const decideConfirmation = useCallback((decision: 'yes' | 'no') => {
    setMessages((prev) =>
      prev.map((m) =>
        m.kind === 'confirmation' && m.decision === 'pending'
          ? { ...m, decision }
          : m,
      ),
    );
  }, []);

  /** Revert the most-recently-locked confirmation card back to pending so that
   *  after a conflict challenge is dismissed the user can change their answer. */
  const revertConfirmationToPending = useCallback(() => {
    setMessages((prev) =>
      prev.map((m) =>
        m.kind === 'confirmation' && m.decision === 'yes'
          ? { ...m, decision: 'pending' as const }
          : m,
      ),
    );
  }, []);

  const submitUrl = useCallback(
    (raw: string) => {
      const url = raw.trim();
      if (!url || status === 'identifying' || status === 'auditing') return;

      add({ id: nextId(), kind: 'user', text: url });
      setStatus('identifying');

      const thinkingId = nextId();
      add({
        id: thinkingId,
        kind: 'agent',
        text: 'Looking that app up on the App Store…',
      });

      identifyApp(url)
        .then(({ runId: id, summary, identity, identityNeedsConfirm }) => {
          setRunId(id);
          patch(thinkingId, () => ({
            id: thinkingId,
            kind: 'agent',
            text: `Found it — here's what's on the listing. Is this the app you want audited?`,
          }));
          add({
            id: nextId(),
            kind: 'confirmation',
            summary,
            identity,
            identityNeedsConfirm,
            decision: 'pending',
          });
          setStatus('confirming');
        })
        .catch((e: unknown) => {
          patch(thinkingId, () => ({
            id: thinkingId,
            kind: 'error',
            text: e instanceof Error ? e.message : 'Could not identify that app.',
          }));
          setStatus('idle');
        });
    },
    [status, add, patch],
  );

  /**
   * Build the shared onProgress/onReport/onError handlers for a runAudit call.
   * Both `confirm` and `confirmAnyway` share these bodies — extracted here to
   * stay DRY. The `progressId` is the id of the progress message to patch.
   */
  const streamHandlers = useCallback(
    (progressId: string) => ({
      onProgress: (event: ProgressEvent) =>
        patch(progressId, (m) =>
          m.kind === 'progress' ? { ...m, events: [...m.events, event] } : m,
        ),
      onReport: (report: AuditReport) => {
        patch(progressId, (m) =>
          m.kind === 'progress' ? { ...m, complete: true } : m,
        );
        add({ id: nextId(), kind: 'report', report });
        add({
          id: nextId(),
          kind: 'agent',
          text: 'Audit complete. Paste another App Store URL to run another.',
        });
        setStatus('done');
        setRunId(null);
      },
      onError: (message: string) => {
        patch(progressId, (m) =>
          m.kind === 'progress' ? { ...m, complete: true } : m,
        );
        add({ id: nextId(), kind: 'error', text: message });
        setStatus('idle');
        setRunId(null);
      },
    }),
    [add, patch],
  );

  const confirm = useCallback((identityDecision?: IdentityDecision | null) => {
    if (status !== 'confirming' || !runId) return;
    decideConfirmation('yes');
    setStatus('auditing');

    const progressId = nextId();
    add({ id: progressId, kind: 'progress', events: [], complete: false });

    void runAudit(runId, {
      ...streamHandlers(progressId),
      onConflict: (conflict: Conflict) => {
        setPendingDecision(identityDecision ?? null);
        // Revert the confirmation card back to actionable so that if the user
        // clicks "Change my answer" the card underneath is live again.
        revertConfirmationToPending();
        add({ id: nextId(), kind: 'challenge', conflict, decision: 'pending' });
        setStatus('confirming');
      },
    }, identityDecision ?? null);
  }, [status, runId, add, decideConfirmation, revertConfirmationToPending, streamHandlers]);

  const confirmAnyway = useCallback(() => {
    // Guard against re-entrancy: only proceed when we are still in the
    // confirming state (not mid-audit or done) and have a pending decision.
    if (status !== 'confirming' || !runId || !pendingDecision) return;
    setStatus('auditing');

    // Lock the challenge card's buttons immediately so a rapid double-click
    // on a stale card cannot fire a second runAudit call.
    setMessages((prev) =>
      prev.map((m) =>
        m.kind === 'challenge' && m.decision === 'pending'
          ? { ...m, decision: 'yes' as const }
          : m,
      ),
    );

    const progressId = nextId();
    add({ id: progressId, kind: 'progress', events: [], complete: false });

    void runAudit(runId, {
      ...streamHandlers(progressId),
      onConflict: () => { /* cannot re-challenge once acknowledged */ },
    }, pendingDecision, /* overrideAcknowledged */ true);
  }, [status, runId, pendingDecision, add, streamHandlers]);

  const reject = useCallback(() => {
    if (status !== 'confirming') return;
    decideConfirmation('no');
    add({
      id: nextId(),
      kind: 'agent',
      text: "No problem — paste the correct App Store URL and I'll take another look.",
    });
    setStatus('idle');
    setRunId(null);
  }, [status, add, decideConfirmation]);

  const busy = status === 'identifying' || status === 'auditing';

  return useMemo(
    () => ({ messages, status, busy, submitUrl, confirm, confirmAnyway, reject }),
    [messages, status, busy, submitUrl, confirm, confirmAnyway, reject],
  );
}
