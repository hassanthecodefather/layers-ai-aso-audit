import React, { useState, useEffect } from 'react';
import { fetchActivity, type ActivityEvent } from '../lib/api';

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
