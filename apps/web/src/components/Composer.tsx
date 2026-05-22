import { useState, type FormEvent } from 'react';

interface ComposerProps {
  disabled: boolean;
  onSubmit: (url: string) => void;
}

const EXAMPLE =
  'https://apps.apple.com/us/app/spotify-music-and-podcasts/id324684580';

/** The chat input — paste an App Store URL and run the audit. */
export function Composer({ disabled, onSubmit }: ComposerProps) {
  const [value, setValue] = useState('');

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const url = value.trim();
    if (!url || disabled) return;
    onSubmit(url);
    setValue('');
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
      <button
        type="button"
        disabled={disabled}
        onClick={() => setValue(EXAMPLE)}
        className="mx-auto mt-2 block max-w-3xl text-left text-xs text-zinc-600 transition hover:text-zinc-400 disabled:opacity-40"
      >
        Try an example — Spotify
      </button>
    </div>
  );
}
