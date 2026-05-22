import type { AuditReport } from '../lib/types';
import { ScoreCard } from './ScoreCard';
import { Recommendations } from './Recommendations';
import { CompetitorTable } from './CompetitorTable';

/** The full audit report — score card, recommendations, competitors. */
export function ReportView({ report }: { report: AuditReport }) {
  const generated = new Date(report.generatedAt);

  return (
    <div className="space-y-5">
      <ScoreCard
        app={report.app}
        overallScore={report.overallScore}
        headline={report.headline}
        dimensions={report.dimensions}
      />

      <Recommendations
        quickWins={report.quickWins}
        highImpact={report.highImpact}
        strategic={report.strategic}
      />

      <CompetitorTable
        summary={report.competitorComparison.summary}
        rows={report.competitorComparison.rows}
      />

      {report.limitations.length > 0 && (
        <section className="rounded-xl border border-amber-500/15 bg-amber-500/[0.04] p-3.5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-amber-300/80">
            Audit limitations
          </h3>
          <ul className="mt-1.5 space-y-1">
            {report.limitations.map((item, i) => (
              <li key={i} className="text-xs leading-relaxed text-zinc-400">
                · {item}
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="text-[11px] text-zinc-600">
        Audited {generated.toLocaleString()} ·{' '}
        {report.app.country.toUpperCase()} App Store ·{' '}
        <a
          href={report.app.url}
          target="_blank"
          rel="noreferrer"
          className="underline decoration-zinc-700 underline-offset-2 hover:text-zinc-400"
        >
          view listing
        </a>
      </p>
    </div>
  );
}
