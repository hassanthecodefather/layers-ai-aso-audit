import React, { useState, useEffect } from 'react';
import { fetchActivity, revertListingUpdate, dismissListingAlert, type ActivityEvent } from '../lib/api';

function ActivityCard({ event }: { event: ActivityEvent }) {
  const date = new Date(event.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

  if (event.eventType === 'go_live') {
    const p = event.payload as { versionString: string };
    return (
      <div className="rounded-lg border border-green-200 bg-green-50 p-4">
        <p className="font-medium text-green-800">
          {event.appName} v{p.versionString} went live
        </p>
        <p className="text-sm text-green-600">{date} · Full audit queued</p>
      </div>
    );
  }

  if (event.eventType === 'metadata_changed') {
    const p = event.payload as { field: string; before: string | null; after: string | null };
    const label = p.field.charAt(0).toUpperCase() + p.field.slice(1);
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <p className="font-medium text-gray-900">{label} changed · {event.appName}</p>
        <p className="text-sm text-gray-500">{date}</p>
        {p.before !== null && p.after !== null && (
          <p className="mt-1 truncate text-xs text-gray-400">
            {String(p.before).slice(0, 60)} → {String(p.after).slice(0, 60)}
          </p>
        )}
      </div>
    );
  }

  if (event.eventType === 'measurement_verdict') {
    const p = event.payload as {
      versionString: string;
      metrics: {
        impressions: { deltaPercent: number };
        downloads: { deltaPercent: number };
        conversionRate: { deltaPercent: number };
      };
      mixedAuthorship: boolean;
      disclaimer: string;
    };
    const fmt = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
    return (
      <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
        <p className="font-medium text-blue-800">
          📊 v{p.versionString} results · {event.appName} · {date}
        </p>
        <p className="mt-1 text-sm text-blue-700">
          Impressions {fmt(p.metrics.impressions.deltaPercent)} · Downloads {fmt(p.metrics.downloads.deltaPercent)} · Conversion {fmt(p.metrics.conversionRate.deltaPercent)}
        </p>
        <p className="mt-1 text-xs text-blue-500">Directional only — 28-day window, correlational.</p>
        {p.mixedAuthorship && (
          <p className="mt-0.5 text-xs text-blue-500">Multiple changes applied — bundle-level attribution.</p>
        )}
      </div>
    );
  }

  if (event.eventType === 'reviews_shifted') {
    const p = event.payload as { ratingBefore: number | null; ratingAfter: number | null; countBefore: number | null; countAfter: number | null };
    const countDelta = p.countAfter != null && p.countBefore != null ? p.countAfter - p.countBefore : null;
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <p className="font-medium text-gray-900">
          Rating {p.ratingBefore?.toFixed(1)} → {p.ratingAfter?.toFixed(1)} · {event.appName}
        </p>
        <p className="text-sm text-gray-500">
          {date}{countDelta != null ? ` · ${countDelta > 0 ? '+' : ''}${countDelta} reviews` : ''}
        </p>
      </div>
    );
  }

  if (event.eventType === 'listing_update_resolved') {
    const p = event.payload as { status: 'approved' | 'rejected'; rejectionReason?: string };
    const isApproved = p.status === 'approved';
    return (
      <div
        className={`rounded-lg border p-4 ${isApproved ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}`}
      >
        <p className={`font-medium ${isApproved ? 'text-green-800' : 'text-red-800'}`}>
          {isApproved ? '✓ Your listing update was approved' : '✗ Apple rejected your listing update'}
        </p>
        <p className={`text-sm ${isApproved ? 'text-green-600' : 'text-red-600'}`}>
          {date} · {event.appName}
        </p>
        {!isApproved && p.rejectionReason && (
          <p className="mt-1 text-sm text-red-500">{p.rejectionReason}</p>
        )}
      </div>
    );
  }

  // ── listing_update_alert card ─────────────────────────────────────────────────
  if (event.eventType === 'listing_update_alert') {
    const p = event.payload as {
      monitorId: string;
      deltas: { conversionRateDelta: number; impressionsDelta: number; downloadsDelta: number };
    };
    const fmt = (n: number) => `${n >= 0 ? '+' : ''}${Math.round(n * 100)}%`;

    return (
      <AlertCard
        event={event}
        monitorId={p.monitorId}
        summary={`Conversion rate ${fmt(p.deltas.conversionRateDelta)}, downloads ${fmt(p.deltas.downloadsDelta)} in the 7 days after your listing update.`}
      />
    );
  }

  // ── listing_update_reverted card ──────────────────────────────────────────────
  if (event.eventType === 'listing_update_reverted') {
    return (
      <div style={{ padding: '12px 16px', borderLeft: '3px solid #888', marginBottom: 8, background: '#1a1a1a' }}>
        <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>
          {new Date(event.createdAt).toLocaleDateString()} · {event.appName}
        </div>
        <div style={{ fontWeight: 500 }}>↩ Listing reverted to previous values</div>
        <div style={{ fontSize: 13, color: '#aaa', marginTop: 4 }}>
          Consider running a new audit before resubmitting.
        </div>
      </div>
    );
  }

  return null;
}

export function ActivityFeed() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchActivity(20)
      .then(setEvents)
      .catch(() => setEvents([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="py-8 text-center text-sm text-gray-400">Loading activity…</div>;
  }

  if (events.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-gray-400">
        No activity yet. Enable tracking for an app after auditing it.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {events.map((event) => (
        <ActivityCard key={event.id} event={event} />
      ))}
    </div>
  );
}

function AlertCard({
  event,
  monitorId,
  summary,
}: {
  event: { createdAt: string; appName: string };
  monitorId: string;
  summary: string;
}) {
  const [phase, setPhase] = React.useState<'idle' | 'working' | 'done'>('idle');
  const [action, setAction] = React.useState<'reverted' | 'dismissed' | null>(null);

  const handleRevert = async () => {
    setPhase('working');
    try {
      await revertListingUpdate(monitorId);
      setAction('reverted');
      setPhase('done');
    } catch {
      setPhase('idle');
    }
  };

  const handleDismiss = async () => {
    setPhase('working');
    try {
      await dismissListingAlert(monitorId);
      setAction('dismissed');
      setPhase('done');
    } catch {
      setPhase('idle');
    }
  };

  if (phase === 'done') {
    return (
      <div style={{ padding: '12px 16px', borderLeft: '3px solid #888', marginBottom: 8, background: '#1a1a1a' }}>
        <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>
          {new Date(event.createdAt).toLocaleDateString()} · {event.appName}
        </div>
        <div style={{ fontSize: 13, color: '#aaa' }}>
          {action === 'reverted' ? '↩ Listing reverted.' : 'Alert dismissed.'}
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '12px 16px', borderLeft: '3px solid #f90', marginBottom: 8, background: '#1a1a1a' }}>
      <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>
        {new Date(event.createdAt).toLocaleDateString()} · {event.appName}
      </div>
      <div style={{ fontWeight: 500, marginBottom: 6 }}>⚠ Your listing update may be hurting performance</div>
      <div style={{ fontSize: 13, color: '#aaa', marginBottom: 10 }}>{summary}</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={handleRevert}
          disabled={phase === 'working'}
          style={{ padding: '6px 14px', cursor: 'pointer' }}
        >
          {phase === 'working' ? '…' : 'Revert Listing'}
        </button>
        <button
          onClick={handleDismiss}
          disabled={phase === 'working'}
          style={{ padding: '6px 14px', cursor: 'pointer', opacity: 0.7 }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
