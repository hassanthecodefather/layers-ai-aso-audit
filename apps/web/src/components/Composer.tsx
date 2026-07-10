import { useState, type FormEvent } from 'react';
import { getAscStatus } from '../lib/api';
import { AscConnectModal } from './AscConnectModal';

interface ComposerProps {
  disabled: boolean;
  onSubmit: (url: string, opts?: { advancedAudit?: boolean }) => void;
}

const EXAMPLE =
  'https://apps.apple.com/us/app/spotify-music-and-podcasts/id324684580';

export function Composer({ disabled, onSubmit }: ComposerProps) {
  const [value, setValue] = useState('');
  const [advancedEnabled, setAdvancedEnabled] = useState(false);
  const [ascStatus, setAscStatus] = useState<'unknown' | 'connected' | 'disconnected'>('unknown');
  const [showModal, setShowModal] = useState(false);
  const [checking, setChecking] = useState(false);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const url = value.trim();
    if (!url || disabled) return;
    onSubmit(url, { advancedAudit: advancedEnabled });
    setValue('');
    setAdvancedEnabled(false);
  }

  async function handleAdvancedToggle() {
    if (advancedEnabled) {
      setAdvancedEnabled(false);
      return;
    }
    let status = ascStatus;
    if (status === 'unknown') {
      setChecking(true);
      try {
        const s = await getAscStatus().catch(() => ({ connected: false, keyId: null }));
        status = s.connected ? 'connected' : 'disconnected';
        setAscStatus(status);
      } finally {
        setChecking(false);
      }
    }
    if (status === 'connected') {
      setAdvancedEnabled(true);
    } else {
      setShowModal(true);
    }
  }

  function handleConnected() {
    setAscStatus('connected');
    setShowModal(false);
    setAdvancedEnabled(true);
  }

  return (
    <div className="border-t border-white/10 bg-[#0a0a0f]/95 px-4 py-4 backdrop-blur">
      <form
        onSubmit={handleSubmit}
        className="mx-auto flex max-w-3xl items-center gap-2"
      >
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={disabled}
          placeholder="Paste an Apple App Store URL…"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-indigo-400/60 focus:bg-white/[0.07] disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={disabled || !value.trim()}
          className="shrink-0 rounded-xl bg-indigo-500 px-5 py-3 text-sm font-medium text-white transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Audit
        </button>
      </form>

      <div className="mx-auto mt-2 max-w-3xl flex items-center gap-3">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={advancedEnabled || checking}
            onChange={handleAdvancedToggle}
            disabled={disabled || checking}
            className="rounded"
          />
          <span className="text-xs text-zinc-500">Advanced Audit</span>
        </label>
        {advancedEnabled && (
          <span className="text-xs text-emerald-400">
            ASC connected · keyword + promotional text will be included
          </span>
        )}
      </div>

      <button
        type="button"
        disabled={disabled}
        onClick={() => setValue(EXAMPLE)}
        className="mx-auto mt-1 block max-w-3xl text-left text-xs text-zinc-600 transition hover:text-zinc-400 disabled:opacity-40"
      >
        Try an example — Spotify
      </button>

      <AscConnectModal
        isOpen={showModal}
        onConnected={handleConnected}
        onClose={() => setShowModal(false)}
      />
    </div>
  );
}
