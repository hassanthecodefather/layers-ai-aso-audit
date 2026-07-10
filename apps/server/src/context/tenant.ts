import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage<string>();

/**
 * Run `fn` with `tenantId` bound in the async local context so that all
 * awaited calls within `fn` — including deep gateway fetches — can read it
 * without explicit argument threading.
 */
export function runWithTenant<T>(id: string, fn: () => T): T {
  return store.run(id, fn);
}

/** Returns the tenant ID set by the nearest enclosing `runWithTenant`, or undefined. */
export function currentTenantId(): string | undefined {
  return store.getStore();
}
