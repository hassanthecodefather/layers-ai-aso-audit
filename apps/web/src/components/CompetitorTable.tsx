import type { CompetitorRow } from '../lib/types';

interface CompetitorTableProps {
  summary: string;
  rows: CompetitorRow[];
}

/** Side-by-side comparison against the top category competitors. */
export function CompetitorTable({ summary, rows }: CompetitorTableProps) {
  return (
    <section>
      <h3 className="text-sm font-semibold text-zinc-200">
        Competitor Comparison
      </h3>
      <p className="mt-1 text-xs leading-relaxed text-zinc-400">{summary}</p>

      {rows.length > 0 && (
        <div className="mt-2.5 overflow-hidden rounded-xl border border-white/10">
          <table className="w-full text-left text-xs">
            <thead className="bg-white/[0.04] text-zinc-500">
              <tr>
                <th className="px-3 py-2 font-medium">Competitor</th>
                <th className="px-3 py-2 font-medium">Rating</th>
                <th className="px-3 py-2 font-medium">Positioning</th>
                <th className="px-3 py-2 font-medium">Their edge</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06]">
              {rows.map((row, i) => (
                <tr key={i} className="align-top">
                  <td className="px-3 py-2 font-medium text-zinc-200">
                    {row.name}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-zinc-400">
                    {row.rating}
                  </td>
                  <td className="px-3 py-2 text-zinc-400">{row.positioning}</td>
                  <td className="px-3 py-2 text-zinc-400">{row.edge}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
