import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAudit, type ChatMessage } from './hooks/useAudit';
import { Composer } from './components/Composer';
import { ChallengeCard, ConfirmationCard } from './components/ConfirmationCard';
import { ProgressTrace } from './components/ProgressTrace';
import { ReportView } from './components/ReportView';
import { fetchHealth, type Health, setAuthCallbacks } from './lib/api';
import { AscSettings } from './components/AscSettings';
import { ActivityFeed } from './components/ActivityFeed';
import type { IdentityDecision } from './lib/types';
import { AuthProvider, useAuth } from './lib/auth';
import { AuthForms } from './components/AuthForms';

/** Top-level chat shell: header, scrolling conversation, composer. */
function AppInner() {
  const { accessToken, refreshToken } = useAuth();

  // Wire auth callbacks into the API layer once on mount / when token changes
  React.useEffect(() => {
    setAuthCallbacks(() => accessToken, refreshToken);
  }, [accessToken, refreshToken]);

  if (!accessToken) return <AuthForms />;

  return <AppContent />;
}

function AppContent() {
  const { messages, busy, submitUrl, confirm, confirmAnyway, reject, reopenIdentity } = useAudit();
  const endRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<'audit' | 'activity'>('audit');

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  const [dismissedChallenges, setDismissedChallenges] = useState<Set<string>>(
    () => new Set(),
  );
  const onRevise = useCallback((id: string) => {
    setDismissedChallenges((prev) => new Set([...prev, id]));
  }, []);

  return (
    <div className="flex h-full flex-col">
      <Header onNavigate={setView} currentView={view} />
      {view === 'activity' ? (
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-4 py-6">
            <h1 className="mb-4 text-lg font-semibold text-gray-900">Activity</h1>
            <ActivityFeed />
          </div>
        </main>
      ) : (
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
                    onReopenIdentity={reopenIdentity}
                  />
                ))}
            </div>
          )}
          <div ref={endRef} />
        </div>
        </main>
      )}
      <Composer disabled={busy} onSubmit={submitUrl} />
    </div>
  );
}

// ── Header ─────────────────────────────────────────────────────────────────

function Header({ onNavigate, currentView }: {
  onNavigate: (view: 'audit' | 'activity') => void;
  currentView: 'audit' | 'activity';
}) {
  const { logout } = useAuth();
  const [health, setHealth] = useState<Health | null>(null);
  const [showAscSettings, setShowAscSettings] = useState(false);

  useEffect(() => {
    fetchHealth()
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  return (
    <>
      {showAscSettings && <AscSettings onClose={() => setShowAscSettings(false)} />}
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
          <div className="flex items-center gap-2">
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
            <button
              className={`rounded px-3 py-1.5 text-sm font-medium ${
                currentView === 'activity'
                  ? 'bg-gray-100 text-gray-900'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
              onClick={() => onNavigate('activity')}
            >
              Activity
            </button>
            <button
              className={`rounded px-3 py-1.5 text-sm font-medium ${
                currentView === 'audit'
                  ? 'bg-gray-100 text-gray-900'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
              onClick={() => onNavigate('audit')}
            >
              Audit
            </button>
            <button
              onClick={() => setShowAscSettings(true)}
              title="App Store Connect settings"
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: '#71717a', fontSize: 16, padding: '4px 6px', borderRadius: 6,
                lineHeight: 1,
              }}
            >
              ⚙
            </button>
            <button
              onClick={() => void logout()}
              title="Sign out"
              className="rounded px-3 py-1.5 text-sm font-medium text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
    </>
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
  onReopenIdentity: () => void;
}

function MessageRow({ message, onConfirm, onReject, onConfirmAnyway, onRevise, onReopenIdentity }: MessageRowProps) {
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
            advancedAudit={message.advancedAudit}
            onConfirm={onConfirm}
            onReject={onReject}
            onReopenIdentity={onReopenIdentity}
          />
        </Agent>
      );

    case 'progress':
      return (
        <Agent>
          <ProgressTrace step={message.step} complete={message.complete} />
        </Agent>
      );

    case 'report':
      return (
        <Agent>
          <ReportView report={message.report} auditJobId={message.auditJobId} />
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

export default function App() {
  return (
    <AuthProvider>
      <AppInner />
    </AuthProvider>
  );
}
