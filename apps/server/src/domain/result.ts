/**
 * A tiny `Result` type. The data layer fails often and predictably (an app
 * ID that doesn't exist, a scraper that times out) — those are expected
 * outcomes, not exceptions, so they belong in the return type where the
 * compiler forces the caller to handle them.
 */
export type Result<T, E = string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is { ok: true; value: T } => r.ok;
