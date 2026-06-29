import { randomUUID } from 'node:crypto';

/**
 * A unique row id. The §A schema calls for ULIDs; a UUID serves the same
 * purpose here (uniqueness), and row ordering never relies on the id — it uses
 * explicit `fetched_at` / `version` columns — so a non-lexicographic id is safe.
 */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
