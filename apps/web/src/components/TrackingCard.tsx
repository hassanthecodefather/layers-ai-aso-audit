import React, { useState, useEffect } from 'react';
import { getTrackedApps, startTracking, stopTracking } from '../lib/api';

interface Props {
  appId: string;
  appName: string;
  url: string;
  country: string;
}

function formatRelative(date: Date): string {
  const hours = Math.round((Date.now() - date.getTime()) / 3_600_000);
  if (hours < 1) return 'less than an hour ago';
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
}

export function TrackingCard({ appId, appName, url, country }: Props) {
  const [status, setStatus] = useState<'loading' | 'tracking' | 'not_tracking'>('loading');
  const [lastScannedAt, setLastScannedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getTrackedApps()
      .then((apps) => {
        const found = apps.find((a) => a.appId === appId && a.country === country);
        if (found) {
          setStatus('tracking');
          setLastScannedAt(found.lastScannedAt);
        } else {
          setStatus('not_tracking');
        }
      })
      .catch(() => setStatus('not_tracking'));
  }, [appId, country]);

  async function handleEnable() {
    setBusy(true);
    setError(null);
    try {
      await startTracking({ appId, appName, url, country });
      setStatus('tracking');
      setLastScannedAt(null);
    } catch {
      setError('Failed to enable tracking. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDisable() {
    setBusy(true);
    setError(null);
    try {
      await stopTracking(appId);
      setStatus('not_tracking');
    } catch {
      setError('Failed to disable tracking. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (status === 'loading') return null;

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      {status === 'not_tracking' ? (
        <>
          <p className="font-semibold text-gray-900">Watch this app</p>
          <p className="mt-1 text-sm text-gray-500">
            I'll check daily for go-lives, metadata changes, and review shifts.
          </p>
          {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
          <button
            className="mt-3 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            onClick={handleEnable}
            disabled={busy}
          >
            {busy ? 'Enabling…' : 'Enable tracking'}
          </button>
        </>
      ) : (
        <>
          <p className="font-semibold text-gray-900">Tracking active</p>
          <p className="mt-1 text-sm text-gray-500">
            {lastScannedAt
              ? `Last checked ${formatRelative(new Date(lastScannedAt))}`
              : 'First scan pending'}
          </p>
          {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
          <button
            className="mt-2 text-xs text-gray-400 hover:text-gray-600 disabled:opacity-50"
            onClick={handleDisable}
            disabled={busy}
          >
            {busy ? 'Disabling…' : 'Disable'}
          </button>
        </>
      )}
    </div>
  );
}
