import { useState } from 'react';
import { useAuth } from '../lib/auth';

export function AuthForms() {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { login, signup } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'login') {
        await login(email, password);
      } else {
        await signup(email, password);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 360, margin: '120px auto', padding: '0 16px' }}>
      <h1 style={{ fontSize: 20, marginBottom: 24 }}>
        {mode === 'login' ? 'Sign in' : 'Create account'}
      </h1>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14 }}
        />
        <input
          type="password"
          placeholder="Password (min 8 characters)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
          style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14 }}
        />
        {error && <p style={{ color: '#d00', fontSize: 13, margin: 0 }}>{error}</p>}
        <button
          type="submit"
          disabled={busy}
          style={{
            padding: '9px 12px', borderRadius: 6, border: 'none',
            background: mode === 'signup' ? '#4f46e5' : '#000',
            color: '#fff',
            cursor: busy ? 'not-allowed' : 'pointer',
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
      </form>
      <p style={{ fontSize: 13, marginTop: 16, color: '#555' }}>
        {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
        <button
          onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(null); }}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            textDecoration: 'underline',
            color: mode === 'login' ? '#4f46e5' : '#555',
            fontSize: 13, fontWeight: mode === 'login' ? 600 : 400,
          }}
        >
          {mode === 'login' ? 'Sign up' : 'Sign in'}
        </button>
      </p>
    </div>
  );
}
