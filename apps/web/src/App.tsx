import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAudit, type ChatMessage } from './hooks/useAudit';
import { Composer } from './components/Composer';
import { ChallengeCard, ConfirmationCard } from './components/ConfirmationCard';
import { ProgressTrace } from './components/ProgressTrace';
import { ReportView } from './components/ReportView';
import { fetchHealth, type Health } from './lib/api';
import type { IdentityDecision } from './lib/types';

/** Top-level chat shell: header, scrolling conversation, composer. */
export function App() {
  const { messages, busy, submitUrl, confirm, confirmAnyway, reject } = useAudit();
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  // "Change my answer" — hides the challenge card so the prior confirmation
  // card is active again. Status is already 'confirming' (set by onConflict),
  // so the confirmation card re-renders as pending without any hook change.
  const [dismissedChallenges, setDismissedChallenges] = useState<Set<string>>(
    () => new Set(),
  );
  const onRevise = useCallback((id: string) => {
    setDismissedChallenges((prev) => new Set([...prev, id]));
  }, []);

  return (
    <div className="flex h-full flex-col">
      <Header />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-6">
          {messages.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="space-y-4">
              {messages
                .filter(
                  (m) => !(m.kind === 'challenge' && dismissedChallenges.has(m.id)),
                )
                .map((message) => (
                  <MessageRow
                    key={message.id}
                    message={message}
                    onConfirm={confirm}
                    onReject={reject}
                    onConfirmAnyway={confirmAnyway}
                    onRevise={onRevise}
                  />
                ))}
            </div>
          )}
          <div ref={endRef} />
        </div>
      </main>
      <Composer disabled={busy} onSubmit={submitUrl} />
    </div>
  );
}

// ── Header ─────────────────────────────────────────────────────────────────

function Header() {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    fetchHealth()
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  return (
    <header className="shrink-0 border-b border-white/10 px-4 py-3">
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-4">
        <div>
          <h1 className="text-sm font-semibold text-zinc-100">
            ASO Audit Agent
          </h1>
          <p className="text-xs text-zinc-500">
            App Store Optimization audits — built on Mastra
          </p>
        </div>
        {health && (
          <div className="flex items-center gap-1.5">
            <Chip
              ok={health.llm.reachable}
              label={health.llm.reachable ? health.llm.model : 'LLM offline'}
              title={
                health.llm.reachable
                  ? `${health.llm.provider} · ${health.llm.endpoint}`
                  : `No LLM at ${health.llm.endpoint}`
              }
            />
            <Chip
              ok={health.crawler.available}
              label={health.crawler.available ? health.crawler.id : 'no crawler'}
              neutralWhenOff
              title={
                health.crawler.available
                  ? 'Subtitle & promo text enabled'
                  : 'Optional — iTunes-only audit'
              }
            />
          </div>
        )}
      </div>
    </header>
  );
}

function Chip({
  ok,
  label,
  neutralWhenOff,
  title,
}: {
  ok: boolean;
  label: string;
  neutralWhenOff?: boolean;
  title?: string;
}) {
  const tone = ok
    ? 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/25'
    : neutralWhenOff
      ? 'bg-white/5 text-zinc-500 ring-white/10'
      : 'bg-rose-500/10 text-rose-300 ring-rose-500/25';
  return (
    <span
      title={title}
      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ${tone}`}
    >
      {ok ? '●' : '○'} {label}
    </span>
  );
}

// ── Empty state ────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="mt-10 text-center">
      <h2 className="text-xl font-semibold text-zinc-100">
        Audit any App Store listing
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-zinc-500">
        Paste an Apple App Store URL below. I'll confirm the app with you, then
        score its listing across ten ASO dimensions and hand back a prioritised
        action plan.
      </p>
    </div>
  );
}

// ── Message rendering ──────────────────────────────────────────────────────

interface MessageRowProps {
  message: ChatMessage;
  onConfirm: (identityDecision: IdentityDecision | null) => void;
  onReject: () => void;
  onConfirmAnyway: () => void;
  onRevise: (id: string) => void;
}

function MessageRow({ message, onConfirm, onReject, onConfirmAnyway, onRevise }: MessageRowProps) {
  switch (message.kind) {
    case 'user':
      return (
        <div className="flex justify-end">
          <p className="max-w-[85%] break-all rounded-2xl rounded-br-md bg-indigo-500/20 px-3.5 py-2 text-sm text-indigo-100 ring-1 ring-indigo-500/20">
            {message.text}
          </p>
        </div>
      );

    case 'agent':
      return <AgentLine>{message.text}</AgentLine>;

    case 'error':
      return (
        <Agent>
          <p className="rounded-2xl rounded-tl-md border border-rose-500/25 bg-rose-500/10 px-3.5 py-2 text-sm text-rose-200">
            {message.text}
          </p>
        </Agent>
      );

    case 'confirmation':
      return (
        <Agent>
          <ConfirmationCard
            summary={message.summary}
            identity={message.identity}
            identityNeedsConfirm={message.identityNeedsConfirm}
            decision={message.decision}
            onConfirm={onConfirm}
            onReject={onReject}
          />
        </Agent>
      );

    case 'progress':
      return (
        <Agent>
          <ProgressTrace events={message.events} complete={message.complete} />
        </Agent>
      );

    case 'report':
      return (
        <Agent>
          <ReportView report={message.report} />
        </Agent>
      );

    case 'challenge':
      return (
        <Agent>
          <ChallengeCard
            conflict={message.conflict}
            decision={message.decision}
            onConfirmAnyway={onConfirmAnyway}
            onRevise={() => onRevise(message.id)}
          />
        </Agent>
      );
  }
}

/** A left-aligned agent row with a small label. */
function Agent({ children }: { children: ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-600">
        Auditor
      </p>
      {children}
    </div>
  );
}

function AgentLine({ children }: { children: ReactNode }) {
  return (
    <Agent>
      <p className="text-sm leading-relaxed text-zinc-300">{children}</p>
    </Agent>
  );
}
