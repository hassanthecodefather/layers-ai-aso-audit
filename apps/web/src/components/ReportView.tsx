import { useState } from 'react';
import type { AuditReport } from '../lib/types';
import { ScoreCard } from './ScoreCard';
import { ReviewInsights } from './ReviewInsights';
import { Recommendations } from './Recommendations';
import { CompetitorTable } from './CompetitorTable';
import { StorefrontComparison } from './StorefrontComparison';
import { TrackingCard } from './TrackingCard';
import { ListingUpdatePanel } from './ListingUpdatePanel';

async function downloadMarkdown(report: AuditReport) {
  const res = await fetch('/api/audit/export/markdown', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ report }),
  });
  if (!res.ok) throw new Error(`Export failed: HTTP ${res.status}`);
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const filenameMatch = disposition.match(/filename="([^"]+)"/);
  const filename = filenameMatch?.[1] ?? 'aso-audit.md';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** The full audit report — score card, recommendations, competitors. */
export function ReportView({ report, auditJobId }: { report: AuditReport; auditJobId: string }) {
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const generated = new Date(report.generatedAt);

  async function handleExport() {
    setExporting(true);
    setExportError('');
    try {
      await downloadMarkdown(report);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : 'Export failed.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-5">
      <ScoreCard
        app={report.app}
        overallScore={report.overallScore}
        headline={report.headline}
        dimensions={report.dimensions}
      />

      {report.themeResult && (
        <ReviewInsights themeResult={report.themeResult} />
      )}

      <Recommendations
        quickWins={report.quickWins}
        highImpact={report.highImpact}
        strategic={report.strategic}
      />

      <TrackingCard
        appId={report.app.appId}
        appName={report.app.name}
        url={report.app.url}
        country={report.app.country}
      />

      <CompetitorTable
        summary={report.competitorComparison.summary}
        rows={report.competitorComparison.rows}
      />

      <StorefrontComparison appId={report.app.appId} />

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

      {auditJobId && (
        <div className="mt-6">
          <ListingUpdatePanel auditJobId={auditJobId} appId={report.app.appId} />
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
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
        <div className="flex items-center gap-2">
          {exportError && <span className="text-[10px] text-rose-400">{exportError}</span>}
          <button
            onClick={handleExport}
            disabled={exporting}
            className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[11px] font-medium text-zinc-400 transition-colors hover:border-white/20 hover:bg-white/[0.07] hover:text-zinc-200 disabled:opacity-40"
          >
            {exporting ? 'Exporting…' : 'Export .md'}
          </button>
        </div>
      </div>
    </div>
  );
}
