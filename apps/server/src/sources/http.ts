/**
 * Shared HTTP helper for the data sources. Every external call goes through
 * here so timeout, retry/backoff and error shape are consistent — the source
 * adapters stay focused on *mapping* data, not on transport plumbing.
 */

/** A failure from an external data source. Carries which source failed. */
export class SourceError extends Error {
  constructor(
    readonly source: string,
    message: string,
    readonly retryable: boolean,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'SourceError';
  }
}

interface FetchOptions {
  readonly source: string;
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly init?: RequestInit;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `fetch` with an abort-based timeout and bounded exponential-backoff retry.
 * Retries network errors, timeouts and 5xx/429 responses; never retries a 4xx
 * (a 404 from iTunes means "no such app" — retrying won't help).
 */
export async function fetchWithRetry(
  url: string,
  { source, timeoutMs = 12_000, retries = 2, init }: FetchOptions,
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (res.ok) return res;

      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === retries) {
        throw new SourceError(
          source,
          `${source} responded ${res.status} ${res.statusText}`,
          retryable,
        );
      }
      lastError = new SourceError(source, `HTTP ${res.status}`, true);
    } catch (cause) {
      if (cause instanceof SourceError && !cause.retryable) throw cause;
      lastError = cause;
      if (attempt === retries) break;
    } finally {
      clearTimeout(timer);
    }
    await sleep(250 * 2 ** attempt);
  }

  throw new SourceError(
    source,
    `${source} unreachable after ${retries + 1} attempts`,
    true,
    lastError,
  );
}

/** `fetchWithRetry` plus JSON parsing, typed by the caller. */
export async function fetchJson<T>(
  url: string,
  opts: FetchOptions,
): Promise<T> {
  const res = await fetchWithRetry(url, opts);
  return (await res.json()) as T;
}
