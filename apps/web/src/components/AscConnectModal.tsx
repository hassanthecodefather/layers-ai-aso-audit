import { useState } from 'react';
import { saveAscCredentials } from '../lib/api';

interface Props {
  isOpen: boolean;
  onConnected: () => void;
  onClose: () => void;
}

export function AscConnectModal({ isOpen, onConnected, onClose }: Props) {
  const [keyId, setKeyId] = useState('');
  const [issuerId, setIssuerId] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await saveAscCredentials(keyId.trim(), issuerId.trim(), privateKey.trim());
      onConnected();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
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
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, color: '#f4f4f5', margin: 0 }}>
            Connect App Store Connect
          </h2>
          <button
            type="button"
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#71717a', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}
          >
            ×
          </button>
        </div>
        <form onSubmit={handleConnect} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ fontSize: 13, color: '#71717a', margin: 0 }}>
            Required to include your keyword field and promotional text in the audit.
            Find these in App Store Connect → Users &amp; Access → Keys.
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
      </div>
    </div>
  );
}
