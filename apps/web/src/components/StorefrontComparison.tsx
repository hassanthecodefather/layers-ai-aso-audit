import { useState } from 'react';

interface StorefrontGap {
  field: 'title' | 'subtitle' | 'description' | 'availability';
  us: string | null;
  storefront: string | null;
  identical: boolean;
}

interface StorefrontRec {
  country: string;
  field: StorefrontGap['field'];
  title: string;
  rationale: string;
  proofRegime: string;
}

interface StorefrontResult {
  country: string;
  available: boolean;
  listing: { name: string; averageRating: number | null; ratingCount: number | null } | null;
  gaps: StorefrontGap[];
  recs: StorefrontRec[];
}

interface SweepResponse {
  appId: string;
  primary: string;
  results: StorefrontResult[];
}

const COUNTRY_FLAG: Record<string, string> = {
  gb: '🇬🇧', au: '🇦🇺', ca: '🇨🇦', de: '🇩🇪', fr: '🇫🇷',
  es: '🇪🇸', it: '🇮🇹', jp: '🇯🇵', kr: '🇰🇷', br: '🇧🇷',
  mx: '🇲🇽', nl: '🇳🇱', se: '🇸🇪', no: '🇳🇴', dk: '🇩🇰',
};

const COUNTRY_NAME: Record<string, string> = {
  gb: 'United Kingdom', au: 'Australia', ca: 'Canada', de: 'Germany',
  fr: 'France', es: 'Spain', it: 'Italy', jp: 'Japan',
  kr: 'South Korea', br: 'Brazil', mx: 'Mexico', nl: 'Netherlands',
  se: 'Sweden', no: 'Norway', dk: 'Denmark',
};

const FIELD_LABEL: Record<string, string> = {
  title: 'Title', subtitle: 'Subtitle', description: 'Description', availability: 'Availability',
};

const PROOF_REGIME_LABEL: Record<string, { label: string; cls: string }> = {
  observable_now: { label: 'Observable', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' },
  correlational:  { label: 'Correlational', cls: 'border-sky-500/30 bg-sky-500/10 text-sky-400' },
};

function flag(country: string) {
  return COUNTRY_FLAG[country] ?? '🌐';
}
function name(country: string) {
  return COUNTRY_NAME[country] ?? country.toUpperCase();
}

function StatusChip({ available }: { available: boolean }) {
  return available ? (
    <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
      Available
    </span>
  ) : (
    <span className="rounded border border-rose-500/30 bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-medium text-rose-400">
      Unavailable
    </span>
  );
}

function RecRow({ rec }: { rec: StorefrontRec }) {
  const regime = PROOF_REGIME_LABEL[rec.proofRegime];
  return (
    <article className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-zinc-100">{rec.title}</p>
        <span className="shrink-0 rounded border border-white/10 bg-white/[0.05] px-1.5 py-0.5 text-[10px] text-zinc-500">
          {FIELD_LABEL[rec.field]}
        </span>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">{rec.rationale}</p>
      {regime && (
        <div className="mt-2 flex">
          <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${regime.cls}`}>
            {regime.label}
          </span>
        </div>
      )}
    </article>
  );
}

function StorefrontCard({ result }: { result: StorefrontResult }) {
  const hasRecs = result.recs.length > 0;
  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.02] p-3.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-lg" aria-hidden>{flag(result.country)}</span>
          <span className="text-sm font-semibold text-zinc-200">{name(result.country)}</span>
        </div>
        <StatusChip available={result.available} />
      </div>
      {result.listing && (
        <p className="mt-1 text-[11px] text-zinc-600">
          {result.listing.name}
          {result.listing.averageRating != null && (
            <> · ★ {result.listing.averageRating.toFixed(1)} ({result.listing.ratingCount?.toLocaleString() ?? '?'} ratings)</>
          )}
        </p>
      )}
      {hasRecs ? (
        <div className="mt-2.5 space-y-2">
          {result.recs.map((rec, i) => (
            <RecRow key={i} rec={rec} />
          ))}
        </div>
      ) : (
        result.available && (
          <p className="mt-2 text-[11px] text-emerald-400/80">
            No localisation gaps detected — listing appears to differ from the US version.
          </p>
        )
      )}
    </section>
  );
}

/** Storefront sweep panel — fetches on demand, no auto-run. */
export function StorefrontComparison({ appId }: { appId: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [data, setData] = useState<SweepResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  async function runSweep() {
    setState('loading');
    setErrorMsg('');
    try {
      const res = await fetch('/api/audit/sweep', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as any)?.error ?? `HTTP ${res.status}`);
      }
      const json = await res.json();
      setData(json as SweepResponse);
      setState('done');
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Sweep failed.');
      setState('error');
    }
  }

  if (state === 'idle' || state === 'error') {
    return (
      <section className="rounded-xl border border-white/10 bg-white/[0.02] p-3.5">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-zinc-200">Storefront sweep</h3>
            <p className="mt-0.5 text-[11px] text-zinc-500">
              Compare this listing across GB · AU · CA · DE storefronts to find localisation gaps.
            </p>
          </div>
          <button
            onClick={runSweep}
            className="shrink-0 rounded-lg border border-white/10 bg-white/[0.05] px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-white/20 hover:bg-white/[0.08] hover:text-zinc-100 active:scale-[0.97]"
          >
            Run sweep
          </button>
        </div>
        {state === 'error' && (
          <p className="mt-2 text-[11px] text-rose-400">{errorMsg}</p>
        )}
      </section>
    );
  }

  if (state === 'loading') {
    return (
      <section className="rounded-xl border border-white/10 bg-white/[0.02] p-3.5">
        <p className="text-sm text-zinc-400">Sweeping storefronts… (4 iTunes lookups)</p>
      </section>
    );
  }

  // done
  const totalRecs = data!.results.reduce((n, r) => n + r.recs.length, 0);
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-200">
          Storefront sweep
          <span className="ml-2 text-xs font-normal text-zinc-500">
            {totalRecs === 0 ? 'No gaps found' : `${totalRecs} gap${totalRecs === 1 ? '' : 's'} found`}
          </span>
        </h3>
        <button
          onClick={runSweep}
          className="text-[11px] text-zinc-600 underline underline-offset-2 hover:text-zinc-400"
        >
          Re-run
        </button>
      </div>
      {data!.results.map((result) => (
        <StorefrontCard key={result.country} result={result} />
      ))}
    </section>
  );
}
