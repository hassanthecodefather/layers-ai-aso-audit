import { useState } from 'react';
import type { AppSummary, Conflict, ResolvedIdentity, IdentityDecision } from '../lib/types';
import { formatCount, formatRating } from '../lib/format';

interface ConfirmationCardProps {
  summary: AppSummary;
  identity: ResolvedIdentity | null;
  identityNeedsConfirm: boolean;
  decision: 'pending' | 'yes' | 'no';
  onConfirm: (identityDecision: IdentityDecision | null) => void;
  onReject: () => void;
  onReopenIdentity?: () => void;
}

/** "Is this the app you meant?" — the human-in-the-loop confirmation gate.
 *  When identityNeedsConfirm is true, also surfaces the resolved identity
 *  so the operator can confirm, correct, or supply their own. */
export function ConfirmationCard({
  summary,
  identity,
  identityNeedsConfirm,
  decision,
  onConfirm,
  onReject,
  onReopenIdentity,
}: ConfirmationCardProps) {
  const pending = decision === 'pending';

  const [identityChoice, setIdentityChoice] = useState<'confirm' | 'correct'>('confirm');
  const [correctedCategory, setCorrectedCategory] = useState(identity?.category ?? '');
  const [correctedNiche, setCorrectedNiche] = useState(identity?.niche ?? '');

  function handleConfirm() {
    if (!identityNeedsConfirm) {
      onConfirm(null);
      return;
    }
    if (identityChoice === 'confirm') {
      onConfirm({ action: 'confirm' });
    } else {
      const trimmed = correctedCategory.trim();
      if (!trimmed) return;
      onConfirm({
        action: 'correct',
        category: trimmed,
        niche: correctedNiche.trim() || null,
      });
    }
  }

  const confirmDisabled =
    identityNeedsConfirm &&
    identityChoice === 'correct' &&
    !correctedCategory.trim();

  const divergenceNote =
    identity?.divergence === 'cross_domain' && summary.primaryGenre
      ? `App Store category "${summary.primaryGenre}" may not reflect what this app actually does.`
      : "We identified this app's function with low confidence.";

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
      {/* App header */}
      <div className="flex items-center gap-4">
        {summary.iconUrl ? (
          <img
            src={summary.iconUrl}
            alt=""
            className="h-16 w-16 shrink-0 rounded-2xl ring-1 ring-white/10"
          />
        ) : (
          <div className="h-16 w-16 shrink-0 rounded-2xl bg-white/5 ring-1 ring-white/10" />
        )}
        <div className="min-w-0">
          <p className="truncate text-base font-semibold text-zinc-50">
            {summary.name}
          </p>
          <p className="truncate text-sm text-zinc-400">{summary.developer}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-zinc-500">
            {summary.primaryGenre && <span>{summary.primaryGenre}</span>}
            <span>
              ★ {formatRating(summary.averageRating)} ·{' '}
              {formatCount(summary.ratingCount)} ratings
            </span>
            <span className="uppercase">{summary.country}</span>
          </div>
        </div>
      </div>

      {/* Previously-confirmed banner — human decision still in force, no re-escalation */}
      {pending && !identityNeedsConfirm && identity?.source === 'human_confirmed' && identity && (
        <div className="mt-4 rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-3">
          <p className="text-xs font-medium text-indigo-400">Previously confirmed</p>
          <p className="mt-0.5 text-xs text-zinc-400">
            You confirmed this app as{' '}
            <span className="text-zinc-200">{identity.category}</span>
            {identity.niche ? (
              <>, niche <span className="text-zinc-200">{identity.niche}</span></>
            ) : null}
            . The audit will use this identity.
          </p>
        </div>
      )}

      {/* Identity panel — only when the resolved identity needs human review */}
      {pending && identityNeedsConfirm && identity && (
        <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3">
          <p className="text-xs font-medium text-amber-400">Identity uncertain</p>
          <p className="mt-0.5 text-xs text-zinc-400">{divergenceNote}</p>

          <div className="mt-2.5 space-y-0.5 text-xs">
            <p>
              <span className="text-zinc-500">We identified: </span>
              <span className="text-zinc-200">{identity.category}</span>
            </p>
            {identity.niche && (
              <p>
                <span className="text-zinc-500">Niche: </span>
                <span className="text-zinc-200">{identity.niche}</span>
              </p>
            )}
          </div>

          <div className="mt-3 space-y-2">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
              <input
                type="radio"
                name="identityChoice"
                value="confirm"
                checked={identityChoice === 'confirm'}
                onChange={() => setIdentityChoice('confirm')}
                className="accent-indigo-500"
              />
              That's correct
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
              <input
                type="radio"
                name="identityChoice"
                value="correct"
                checked={identityChoice === 'correct'}
                onChange={() => setIdentityChoice('correct')}
                className="accent-indigo-500"
              />
              Let me correct it
            </label>
          </div>

          {identityChoice === 'correct' && (
            <div className="mt-3 space-y-2">
              <input
                type="text"
                value={correctedCategory}
                onChange={(e) => setCorrectedCategory(e.target.value)}
                placeholder="Category (e.g. Electric vehicle companion)"
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-indigo-500/50 focus:outline-none"
              />
              <input
                type="text"
                value={correctedNiche}
                onChange={(e) => setCorrectedNiche(e.target.value)}
                placeholder="Niche (optional)"
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-indigo-500/50 focus:outline-none"
              />
            </div>
          )}
        </div>
      )}

      {pending ? (
        <div className="mt-4 flex gap-2">
          <button
            onClick={handleConfirm}
            disabled={confirmDisabled}
            className="flex-1 rounded-xl bg-indigo-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Yes, audit this app
          </button>
          {onReopenIdentity && !identityNeedsConfirm && identity?.source === 'human_confirmed' && (
            <button
              onClick={onReopenIdentity}
              className="rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-medium text-zinc-300 transition hover:bg-white/10"
            >
              Change identity
            </button>
          )}
          <button
            onClick={onReject}
            className="rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-medium text-zinc-300 transition hover:bg-white/10"
          >
            Not quite
          </button>
        </div>
      ) : (
        <p
          className={`mt-3 text-xs font-medium ${
            decision === 'yes' ? 'text-indigo-300' : 'text-zinc-500'
          }`}
        >
          {decision === 'yes'
            ? '✓ Confirmed — running the audit'
            : '✕ Dismissed'}
        </p>
      )}
    </div>
  );
}

// ── ChallengeCard ──────────────────────────────────────────────────────────

export function ChallengeCard({
  conflict,
  decision,
  onConfirmAnyway,
  onRevise,
}: {
  conflict: Conflict;
  decision: 'pending' | 'yes' | 'no';
  onConfirmAnyway: () => void;
  onRevise: () => void;
}) {
  const pending = decision === 'pending';
  return (
    <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4">
      <p className="text-sm font-semibold text-amber-300">
        Before you confirm &ldquo;{conflict.chosenCategory}&rdquo; &mdash; here&rsquo;s why we read this as
        &ldquo;{conflict.evidenceCategory}&rdquo;:
      </p>
      <ul className="mt-3 space-y-1 text-xs text-zinc-300">
        {conflict.evidence.map((e, i) => (
          <li key={i}>&bull; {e.text}</li>
        ))}
      </ul>
      <p className="mt-4 text-sm font-semibold text-amber-300">If you confirm anyway:</p>
      <ul className="mt-2 space-y-1 text-xs text-zinc-400">
        {conflict.consequences.map((c, i) => (
          <li key={i}>&bull; {c}</li>
        ))}
      </ul>
      {pending && (
        <div className="mt-4 flex gap-2">
          <button
            onClick={onConfirmAnyway}
            className="flex-1 rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-medium text-black transition hover:bg-amber-400"
          >
            Confirm &ldquo;{conflict.chosenCategory}&rdquo; anyway
          </button>
          <button
            onClick={onRevise}
            className="rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-medium text-zinc-300 transition hover:bg-white/10"
          >
            Change my answer
          </button>
        </div>
      )}
    </div>
  );
}
