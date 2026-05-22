import type { AppSummary } from '../lib/types';
import { formatCount, formatRating } from '../lib/format';

interface ConfirmationCardProps {
  summary: AppSummary;
  decision: 'pending' | 'yes' | 'no';
  onConfirm: () => void;
  onReject: () => void;
}

/** "Is this the app you meant?" — the human-in-the-loop confirmation gate. */
export function ConfirmationCard({
  summary,
  decision,
  onConfirm,
  onReject,
}: ConfirmationCardProps) {
  const pending = decision === 'pending';

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
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

      {pending ? (
        <div className="mt-4 flex gap-2">
          <button
            onClick={onConfirm}
            className="flex-1 rounded-xl bg-indigo-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-400"
          >
            Yes, audit this app
          </button>
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
