import type { ProgressEvent } from '../lib/types';

interface ProgressTraceProps {
  events: ProgressEvent[];
  complete: boolean;
}

/**
 * The live audit trace — one line per workflow phase as the SSE stream
 * delivers it, so the user always knows what's happening.
 */
export function ProgressTrace({ events, complete }: ProgressTraceProps) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
      <ol className="space-y-2.5">
        {events.map((event, i) => {
          const isLast = i === events.length - 1;
          const active = isLast && !complete;
          return (
            <li key={`${event.phase}-${i}`} className="flex items-start gap-3">
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                {active ? (
                  <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-indigo-400" />
                ) : (
                  <span className="text-emerald-400">✓</span>
                )}
              </span>
              <span
                className={`text-sm ${active ? 'text-zinc-200' : 'text-zinc-500'}`}
              >
                {event.message}
              </span>
            </li>
          );
        })}
        {events.length === 0 && (
          <li className="text-sm text-zinc-500">Starting…</li>
        )}
      </ol>
    </div>
  );
}
