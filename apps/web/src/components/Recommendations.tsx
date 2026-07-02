import type { Recommendation } from '../lib/types';

interface RecommendationsProps {
  quickWins: Recommendation[];
  highImpact: Recommendation[];
  strategic: Recommendation[];
}

const GROUPS = [
  {
    key: 'quickWins' as const,
    title: 'Quick Wins',
    blurb: 'Implementable today, high impact.',
    accent: 'text-emerald-300',
  },
  {
    key: 'highImpact' as const,
    title: 'High-Impact Changes',
    blurb: 'More effort, significant payoff.',
    accent: 'text-amber-300',
  },
  {
    key: 'strategic' as const,
    title: 'Strategic Recommendations',
    blurb: 'Longer-term positioning.',
    accent: 'text-sky-300',
  },
];

/** The three prioritised recommendation groups. */
export function Recommendations(props: RecommendationsProps) {
  return (
    <div className="space-y-5">
      {GROUPS.map((group) => {
        const items = props[group.key];
        if (items.length === 0) return null;
        return (
          <section key={group.key}>
            <h3 className={`text-sm font-semibold ${group.accent}`}>
              {group.title}
              <span className="ml-2 font-normal text-zinc-600">
                {group.blurb}
              </span>
            </h3>
            <div className="mt-2 space-y-2">
              {items.map((rec, i) => (
                <RecommendationCard key={i} rec={rec} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

const BUCKET_SHORT: Record<string, string> = {
  crash_stability: 'Crashes',
  login_auth: 'Login',
  pricing_subscription: 'Pricing',
  ads_intrusive: 'Ads',
  performance_speed: 'Performance',
  battery_resource: 'Battery',
  data_loss_sync: 'Data Loss',
  ui_ux_confusion: 'UI/UX',
  onboarding: 'Onboarding',
  notifications: 'Notifications',
  privacy_permissions: 'Privacy',
  customer_support: 'Support',
  device_compat: 'Compatibility',
  content_quality: 'Content',
  other: 'Other',
};

function RecommendationCard({ rec }: { rec: Recommendation }) {
  const hasDiff = rec.before != null && rec.after != null;
  const isKeyword = rec.intent === 'add_keyword' && rec.referent?.kind === 'keyword' && rec.referent.value;
  const keywords = isKeyword
    ? rec.referent.value!.split(',').map((k) => k.trim()).filter(Boolean)
    : [];
  const isTheme = rec.intent === 'fix_complaint_theme' && rec.referent?.kind === 'theme';
  const isReviewId = rec.intent === 'respond_to_reviews' && rec.referent?.kind === 'reviewId';

  return (
    <article className="rounded-xl border border-white/10 bg-white/[0.03] p-3.5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-zinc-100">{rec.title}</p>
        {isTheme && rec.referent.bucket && (
          <span className="shrink-0 rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-300">
            {BUCKET_SHORT[rec.referent.bucket] ?? rec.referent.bucket}
          </span>
        )}
        {isReviewId && rec.referent.value && (
          <span className="shrink-0 rounded-md border border-white/10 bg-white/[0.05] px-2 py-0.5 font-mono text-[10px] text-zinc-500">
            {rec.referent.value}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs leading-relaxed text-zinc-400">
        {rec.rationale}
      </p>

      {keywords.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {keywords.map((kw) => (
            <span
              key={kw}
              className="rounded-md border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-xs font-medium text-violet-300"
            >
              {kw}
            </span>
          ))}
        </div>
      )}

      {hasDiff && (
        <div className="mt-2.5 space-y-1.5">
          <DiffLine label="Before" value={rec.before!} tone="before" />
          <DiffLine label="After" value={rec.after!} tone="after" />
        </div>
      )}

      <div className="mt-2.5 flex items-center justify-between gap-2">
        <p className="text-[11px] text-zinc-600">
          <span className="text-zinc-500">Evidence:</span> {rec.evidence}
        </p>
        {rec.proofRegime && <ProofRegimeBadge regime={rec.proofRegime} />}
      </div>
    </article>
  );
}

const PROOF_REGIME_LABEL: Record<string, { label: string; cls: string }> = {
  observable_now: { label: 'Observable',    cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' },
  correlational:  { label: 'Correlational', cls: 'border-sky-500/30 bg-sky-500/10 text-sky-400' },
  funnel_asc:     { label: 'ASC funnel',    cls: 'border-amber-500/30 bg-amber-500/10 text-amber-400' },
  ppo_causal:     { label: 'PPO test',      cls: 'border-violet-500/30 bg-violet-500/10 text-violet-400' },
};

function ProofRegimeBadge({ regime }: { regime: string }) {
  const def = PROOF_REGIME_LABEL[regime];
  if (!def) return null;
  return (
    <span title="How you can measure this rec's effect" className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${def.cls}`}>
      {def.label}
    </span>
  );
}

function DiffLine({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'before' | 'after';
}) {
  const styles =
    tone === 'before'
      ? 'border-rose-500/20 bg-rose-500/[0.07] text-rose-200/90'
      : 'border-emerald-500/20 bg-emerald-500/[0.07] text-emerald-200/90';
  return (
    <div className={`rounded-lg border px-2.5 py-1.5 ${styles}`}>
      <span className="mr-2 text-[10px] font-semibold uppercase tracking-wide opacity-60">
        {label}
      </span>
      <span className="text-xs">{value}</span>
    </div>
  );
}
