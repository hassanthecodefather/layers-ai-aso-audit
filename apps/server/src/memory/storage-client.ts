import type { Result } from '../domain/result';
import type { ListingSnapshot } from '../domain/snapshot';
import type { LedgerRecommendation } from '../domain/recommendation';
import type { IdentityVersion } from '../domain/identity';

/**
 * The storage seam (Build Appendix §B). The whole "config change, not
 * migration" claim for the future LibSQL→Postgres swap rests on this contract:
 * **only domain types cross it** — no SQL dialect, no vendor schema, no row
 * shapes. The agent, workflow, and dedup code depend on this interface alone,
 * so swapping the engine is a wiring change, and the *same* conformance suite
 * (see `storage-client.test.ts`) is what §F/6a says Postgres must later pass.
 */
export interface StorageClient {
  /** Append an immutable audit snapshot. */
  putSnapshot(s: ListingSnapshot): Promise<Result<void>>;
  /** The most recent snapshot for an app+storefront, or null if none. */
  latestSnapshot(
    appId: string,
    country: string,
  ): Promise<Result<ListingSnapshot | null>>;

  /**
   * Insert or update a recommendation, deduped on `rec_key` (one live row per
   * logical recommendation): a re-raise bumps `last_seen_at` and refreshes the
   * evidence/wording rather than inserting a duplicate.
   */
  upsertRecommendation(r: LedgerRecommendation): Promise<Result<void>>;
  /**
   * Record that a recommendation appeared in a given audit snapshot (the
   * belief-accumulation write path → `aso_rec_occurrences`).
   */
  recordOccurrence(
    recId: string,
    snapshotId: string,
    wasDismissed: boolean,
  ): Promise<Result<void>>;
  /** The full live ledger for an app+storefront. */
  ledger(
    appId: string,
    country: string,
  ): Promise<Result<LedgerRecommendation[]>>;

  /** Append a new identity version (monotonic per app+storefront). */
  appendIdentity(v: IdentityVersion): Promise<Result<void>>;
  /** The most recent identity version, or null if none. */
  latestIdentity(
    appId: string,
    country: string,
  ): Promise<Result<IdentityVersion | null>>;

  /** Tombstone a human-rejected competitor (app-scoped, version-independent). */
  tombstoneCompetitor(
    appId: string,
    country: string,
    competitorAppId: string,
  ): Promise<Result<void>>;
  /** The app-scoped set of tombstoned competitor app ids. */
  tombstones(appId: string, country: string): Promise<Result<Set<string>>>;
}
