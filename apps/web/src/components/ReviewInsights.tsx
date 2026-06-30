import { useState } from 'react';
import type { ThemeResult } from '../lib/types';

const BUCKET_LABELS: Record<string, string> = {
  crash_stability: 'Crashes & Stability',
  login_auth: 'Login & Auth',
  pricing_subscription: 'Pricing & Subscriptions',
  ads_intrusive: 'Intrusive Ads',
  performance_speed: 'Performance & Speed',
  battery_resource: 'Battery & Resources',
  data_loss_sync: 'Data Loss & Sync',
  ui_ux_confusion: 'UI / UX Confusion',
  onboarding: 'Onboarding',
  notifications: 'Notifications',
  privacy_permissions: 'Privacy & Permissions',
  customer_support: 'Customer Support',
  device_compat: 'Device Compatibility',
  content_quality: 'Content Quality',
  other: 'Other',
};

function bucketLabel(bucket: string): string {
  return BUCKET_LABELS[bucket] ?? bucket;
}

export function ReviewInsights({ themeResult }: { themeResult: ThemeResult }) {
  const { themes, versionDelta, featureRequests, sampleSize } = themeResult;
  const [featsExpanded, setFeatsExpanded] = useState(false);

  const hasContent = themes.length > 0 || versionDelta !== null;
  if (!hasContent) return null;

  const visibleFeats = featsExpanded ? featureRequests : featureRequests.slice(0, 3);
  const hiddenCount = featureRequests.length - 3;

  const deltaSign = versionDelta && versionDelta.delta > 0 ? '+' : '';
  const deltaColor =
    versionDelta === null || versionDelta.delta === 0
      ? 'text-zinc-400'
      : versionDelta.delta > 0
        ? 'text-emerald-400'
        : 'text-rose-400';
  const deltaArrow =
    versionDelta === null || versionDelta.delta === 0
      ? '→'
      : versionDelta.delta > 0
        ? '↑'
        : '↓';

  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <h3 className="text-sm font-semibold text-zinc-100">Review Insights</h3>

      {versionDelta && (
        <div className="mt-2.5">
          <span className="text-xs text-zinc-500">Version sentiment</span>
          <span className={`ml-2 text-xs font-medium ${deltaColor}`}>
            v{versionDelta.olderVersion} → v{versionDelta.newerVersion} · Rating{' '}
            {deltaArrow}
            {Math.abs(versionDelta.delta) === 0
              ? ' unchanged'
              : `${deltaSign}${versionDelta.delta.toFixed(2)}`}
          </span>
        </div>
      )}

      {themes.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {themes.map((theme, i) => (
            <div
              key={i}
              className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2"
            >
              <div className="min-w-0">
                <span className="text-xs font-medium text-zinc-300">
                  {bucketLabel(theme.bucket)}
                </span>
                {theme.isUnresolved && (
                  <span className="ml-1.5 rounded border border-amber-500/30 bg-amber-500/10 px-1 py-0.5 text-[10px] text-amber-400">
                    unresolved
                  </span>
                )}
                <p className="mt-0.5 text-[11px] text-zinc-500">{theme.text}</p>
              </div>
              <span className="shrink-0 rounded-full border border-white/10 bg-white/[0.06] px-2 py-0.5 text-[11px] text-zinc-400">
                {theme.reviewCount}
              </span>
            </div>
          ))}
        </div>
      )}

      {featureRequests.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium text-zinc-400">Feature requests</p>
          <ul className="mt-1.5 space-y-1">
            {visibleFeats.map((fr, i) => (
              <li key={i} className="text-xs text-zinc-500">
                · {fr}
              </li>
            ))}
          </ul>
          {hiddenCount > 0 && !featsExpanded && (
            <button
              onClick={() => setFeatsExpanded(true)}
              className="mt-1 text-[11px] text-zinc-600 underline hover:text-zinc-400"
            >
              {hiddenCount} more
            </button>
          )}
        </div>
      )}

      {sampleSize > 0 && (
        <p className="mt-3 text-[11px] text-zinc-600">
          Based on {sampleSize} recent reviews
        </p>
      )}
    </section>
  );
}
