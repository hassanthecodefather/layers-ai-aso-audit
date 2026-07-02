/**
 * F · Portable Markdown export.
 *
 * Pure function: AuditReport → Markdown string. No I/O, no dependencies
 * beyond the domain types. Designed to be called from an HTTP route, a CLI,
 * or a test without any server context.
 */

import type { AuditReport, Recommendation, ScoredDimension } from '../domain/audit';

// ── Helpers ───────────────────────────────────────────────────────────────────

function pad(s: string | number, width: number): string {
  return String(s).padEnd(width);
}

function scoreBar(score: number): string {
  const filled = Math.round(score / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function recBlock(rec: Recommendation, i: number): string {
  const lines: string[] = [];
  lines.push(`### ${i + 1}. ${rec.title}`);
  lines.push('');
  lines.push(`**Dimension:** ${rec.dimension} · **Intent:** \`${rec.intent}\``);
  if (rec.proofRegime) lines.push(`**Proof regime:** ${rec.proofRegime}`);
  lines.push('');
  lines.push(rec.rationale);
  lines.push('');
  lines.push(`_Evidence: ${rec.evidence}_`);
  if (rec.before != null && rec.after != null) {
    lines.push('');
    lines.push('**Before →**');
    lines.push('');
    lines.push(`> ${rec.before}`);
    lines.push('');
    lines.push('**After →**');
    lines.push('');
    lines.push(`> ${rec.after}`);
  }
  return lines.join('\n');
}

function dimensionTable(dimensions: ScoredDimension[]): string {
  const rows = dimensions.map((d) => {
    const bar = scoreBar(d.score);
    return `| ${pad(d.label, 18)} | ${pad(d.score + '/10', 7)} | \`${bar}\` | ${d.findings.slice(0, 80)}${d.findings.length > 80 ? '…' : ''} |`;
  });
  return [
    '| Dimension          | Score   | Bar          | Findings |',
    '| :----------------- | :------ | :----------- | :------- |',
    ...rows,
  ].join('\n');
}

// ── Public surface ────────────────────────────────────────────────────────────

/** Convert a finished audit report to a Markdown document. */
export function reportToMarkdown(report: AuditReport): string {
  const generated = new Date(report.generatedAt).toUTCString();
  const sections: string[] = [];

  // ── Header ──────────────────────────────────────────────────────────────────
  sections.push(`# ASO Audit — ${report.app.name}`);
  sections.push('');
  sections.push(`**Generated:** ${generated}  `);
  sections.push(`**Country:** ${report.app.country.toUpperCase()} App Store  `);
  sections.push(`**Developer:** ${report.app.developer}  `);
  if (report.app.averageRating != null) {
    sections.push(`**Rating:** ★ ${report.app.averageRating.toFixed(1)} (${(report.app.ratingCount ?? 0).toLocaleString()} ratings)  `);
  }
  sections.push(`**Overall ASO score:** ${report.overallScore}/100`);
  sections.push('');

  // ── Headline ─────────────────────────────────────────────────────────────────
  sections.push(`## Summary`);
  sections.push('');
  sections.push(report.headline);
  sections.push('');

  // ── Dimension table ───────────────────────────────────────────────────────────
  sections.push('## Dimension breakdown');
  sections.push('');
  sections.push(dimensionTable(report.dimensions));
  sections.push('');

  // ── Recommendations ───────────────────────────────────────────────────────────
  const groups: [string, Recommendation[]][] = [
    ['Quick Wins', report.quickWins],
    ['High-Impact Changes', report.highImpact],
    ['Strategic Recommendations', report.strategic],
  ];
  for (const [heading, recs] of groups) {
    if (recs.length === 0) continue;
    sections.push(`## ${heading}`);
    sections.push('');
    recs.forEach((rec, i) => {
      sections.push(recBlock(rec, i));
      sections.push('');
    });
  }

  // ── Competitor comparison ─────────────────────────────────────────────────────
  if (report.competitorComparison.rows.length > 0) {
    sections.push('## Competitor comparison');
    sections.push('');
    sections.push(report.competitorComparison.summary);
    sections.push('');
    const rows = report.competitorComparison.rows.map(
      (r) => `| ${r.name} | ${r.rating} | ${r.positioning} | ${r.edge} |`,
    );
    sections.push('| Name | Rating | Positioning | Edge |');
    sections.push('| :--- | :----- | :---------- | :--- |');
    sections.push(...rows);
    sections.push('');
  }

  // ── Review themes ─────────────────────────────────────────────────────────────
  if (report.themeResult && report.themeResult.themes.length > 0) {
    sections.push('## Review themes');
    sections.push('');
    sections.push(`Sample: ${report.themeResult.sampleSize} reviews`);
    sections.push('');
    for (const theme of report.themeResult.themes) {
      const unresolved = theme.isUnresolved ? ' _(unresolved)_' : '';
      sections.push(`- **${theme.bucket}**${unresolved} (${theme.reviewCount} reviews): ${theme.text}`);
    }
    sections.push('');
  }

  // ── Limitations ───────────────────────────────────────────────────────────────
  if (report.limitations.length > 0) {
    sections.push('## Audit limitations');
    sections.push('');
    for (const lim of report.limitations) {
      sections.push(`- ${lim}`);
    }
    sections.push('');
  }

  sections.push('---');
  sections.push('');
  sections.push(`_Generated by Layers ASO Audit · ${report.app.url}_`);

  return sections.join('\n');
}

/** Suggested filename for the Markdown export. */
export function markdownFilename(report: AuditReport): string {
  const slug = report.app.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const date = report.generatedAt.slice(0, 10);
  return `aso-audit-${slug}-${date}.md`;
}
