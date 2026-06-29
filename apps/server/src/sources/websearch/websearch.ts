import { ok, type Result } from '../../domain/result';

/**
 * The external-corroboration tier of the identity ladder (spec ID "No
 * footprint? A confidence ladder, not a cliff"). It is built behind its seam
 * now and stubbed: no web-search key exists yet, so `NoopWebSearch` honestly
 * reports `searched-and-empty` and never fabricates a footprint. When an
 * Exa/Tavily key lands, the real client drops in here (one file) and ID-lite's
 * ladder ceiling rises — no rework elsewhere.
 *
 * The tri-state is the whole point (spec ID "Absence is information"): a probe
 * that genuinely found nothing is a small, honest confidence penalty, and is
 * never allowed to masquerade as a lookup that broke.
 */
export type WebSearchProbe =
  | { state: 'corroborated'; sources: { title: string; url: string }[] }
  | { state: 'searched_and_empty' }
  | { state: 'errored'; reason: string };

export interface WebSearchProvider {
  readonly id: string;
  /** Whether a real search backend is configured. */
  readonly available: boolean;
  /** Probe for an off-store footprint corroborating `query`. Never throws. */
  probe(query: string): Promise<Result<WebSearchProbe>>;
}

/**
 * The keyless default: the lookup is defined to have run and found nothing.
 * `searched_and_empty` (not `errored`, not a fake corroboration) means ID-lite
 * simply starts one rung lower on the ladder — which the band logic already
 * models, since the footprint family just doesn't vote.
 */
export class NoopWebSearch implements WebSearchProvider {
  readonly id = 'noop-websearch';
  readonly available = false;

  async probe(_query: string): Promise<Result<WebSearchProbe>> {
    return ok({ state: 'searched_and_empty' });
  }
}

let singleton: WebSearchProvider | null = null;

/** The active web-search provider. Swap `NoopWebSearch` here when a key lands. */
export function getWebSearch(): WebSearchProvider {
  if (!singleton) singleton = new NoopWebSearch();
  return singleton;
}
