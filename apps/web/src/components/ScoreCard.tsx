import type { AppSummary, ScoredDimension } from '../lib/types';
import { confidenceLabel, overallTone, scoreTone } from '../lib/format';

interface ScoreCardProps {
  app: AppSummary;
  overallScore: number;
  headline: string;
  dimensions: ScoredDimension[];
}

/** The ASO Score Card — overall score ring plus per-dimension bars. */
export function ScoreCard({
  app,
  overallScore,
  headline,
  dimensions,
}: ScoreCardProps) {
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.04] p-5">
      <header className="flex items-center gap-5">
        <ScoreRing score={overallScore} />
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            ASO Score
          </p>
          <p className="truncate text-lg font-semibold text-zinc-50">
            {app.name}
          </p>
          <p className="mt-1 text-sm leading-snug text-zinc-400">{headline}</p>
        </div>
      </header>

      <div className="mt-5 space-y-3.5 border-t border-white/10 pt-5">
        {dimensions.map((dim) => (
          <DimensionRow key={dim.id} dim={dim} />
        ))}
      </div>
    </section>
  );
}

function ScoreRing({ score }: { score: number }) {
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - Math.min(100, Math.max(0, score)) / 100);
  const tone = overallTone(score);

  return (
    <div className="relative h-32 w-32 shrink-0">
      <svg viewBox="0 0 120 120" className="h-32 w-32 -rotate-90">
        <circle
          cx="60"
          cy="60"
          r={radius}
          fill="none"
          strokeWidth="10"
          className="stroke-white/[0.07]"
        />
        <circle
          cx="60"
          cy="60"
          r={radius}
          fill="none"
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className={`${tone.text} transition-[stroke-dashoffset] duration-700`}
          stroke="currentColor"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={`text-3xl font-bold ${tone.text}`}>{score}</span>
        <span className="text-[10px] uppercase tracking-wide text-zinc-500">
          out of 100
        </span>
      </div>
    </div>
  );
}

function DimensionRow({ dim }: { dim: ScoredDimension }) {
  const unavailable = dim.confidence === 'unavailable';
  const tone = scoreTone(dim.score);

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-zinc-200">{dim.label}</span>
          <span className="text-[11px] text-zinc-600">{dim.weight}% weight</span>
          {dim.confidence !== 'observed' && (
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] ring-1 ${
                unavailable
                  ? 'bg-white/5 text-zinc-500 ring-white/10'
                  : 'bg-sky-500/10 text-sky-300 ring-sky-500/25'
              }`}
            >
              {confidenceLabel(dim.confidence)}
            </span>
          )}
        </div>
        <span
          className={`shrink-0 text-sm font-semibold tabular-nums ${
            unavailable ? 'text-zinc-600' : tone.text
          }`}
        >
          {unavailable ? 'n/a' : `${dim.score.toFixed(1)}/10`}
        </span>
      </div>

      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
        {!unavailable && (
          <div
            className={`h-full rounded-full ${tone.bar} transition-[width] duration-700`}
            style={{ width: `${(dim.score / 10) * 100}%` }}
          />
        )}
      </div>

      <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">
        {dim.findings}
      </p>
      {dim.evidence.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {dim.evidence.map((point, i) => (
            <li key={i} className="text-xs text-zinc-600">
              <span className="text-zinc-700">·</span> {point}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
