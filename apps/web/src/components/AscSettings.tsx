import { useState, useEffect } from 'react';
import { getAscStatus, saveAscCredentials, deleteAscCredentials, type AscStatus } from '../lib/api';

interface Props {
  onClose: () => void;
}

export function AscSettings({ onClose }: Props) {
  const [status, setStatus] = useState<AscStatus | null>(null);
  const [keyId, setKeyId] = useState('');
  const [issuerId, setIssuerId] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAscStatus().then(setStatus).catch(() => setStatus({ connected: false, keyId: null }));
  }, []);

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await saveAscCredentials(keyId.trim(), issuerId.trim(), privateKey.trim());
      setStatus({ connected: true, keyId: keyId.trim() });
      setPrivateKey('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteAscCredentials();
      setStatus({ connected: false, keyId: null });
      setKeyId('');
      setIssuerId('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50,
    }}>
      <div style={{
        background: '#18181b', border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 12, padding: 24, width: '100%', maxWidth: 440,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, color: '#f4f4f5', margin: 0 }}>
            App Store Connect
          </h2>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#71717a', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}
          >
            ×
          </button>
        </div>

        {status === null ? (
          <p style={{ color: '#71717a', fontSize: 14 }}>Loading…</p>
        ) : status.connected ? (
          <div>
            <p style={{ fontSize: 14, color: '#a1a1aa', marginBottom: 16 }}>
              Connected — Key ID: <span style={{ color: '#f4f4f5', fontFamily: 'monospace' }}>{status.keyId}</span>
            </p>
            {error && <p style={{ color: '#f87171', fontSize: 13, marginBottom: 12 }}>{error}</p>}
            <button
              onClick={handleDisconnect}
              disabled={busy}
              style={{
                padding: '8px 16px', borderRadius: 6, background: '#3f3f46',
                color: '#f4f4f5', border: 'none', cursor: busy ? 'not-allowed' : 'pointer', fontSize: 14,
              }}
            >
              {busy ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </div>
        ) : (
          <form onSubmit={handleConnect} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <p style={{ fontSize: 13, color: '#71717a', margin: 0 }}>
              Required to measure real impressions and downloads. Find these in App Store Connect → Users &amp; Access → Keys.
            </p>
            <input
              type="text"
              placeholder="Key ID"
              value={keyId}
              onChange={(e) => setKeyId(e.target.value)}
              required
              style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #3f3f46', background: '#27272a', color: '#f4f4f5', fontSize: 14 }}
            />
            <input
              type="text"
              placeholder="Issuer ID"
              value={issuerId}
              onChange={(e) => setIssuerId(e.target.value)}
              required
              style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #3f3f46', background: '#27272a', color: '#f4f4f5', fontSize: 14 }}
            />
            <textarea
              placeholder="Private key (.p8 file contents — paste here)"
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              required
              rows={5}
              style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #3f3f46', background: '#27272a', color: '#f4f4f5', fontSize: 13, fontFamily: 'monospace', resize: 'vertical' }}
            />
            {error && <p style={{ color: '#f87171', fontSize: 13, margin: 0 }}>{error}</p>}
            <button
              type="submit"
              disabled={busy}
              style={{
                padding: '9px 12px', borderRadius: 6, background: '#2563eb',
                color: '#fff', border: 'none', cursor: busy ? 'not-allowed' : 'pointer', fontSize: 14,
              }}
            >
              {busy ? 'Connecting…' : 'Connect App Store Connect'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
