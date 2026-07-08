interface ProgressTraceProps {
  step: string | null;
  complete: boolean;
}

/**
 * The live audit trace — shows the current step name while the job runs,
 * so the user always knows what's happening.
 */
export function ProgressTrace({ step, complete }: ProgressTraceProps) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
      <div className="space-y-2.5">
        {step && <p className="text-sm text-gray-500">Step: {step}</p>}
        {!complete && <p className="text-sm text-gray-400">Working…</p>}
        {complete && <p className="text-sm text-gray-400">Done</p>}
      </div>
    </div>
  );
}
