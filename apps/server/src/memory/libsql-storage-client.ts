import type { Client, InArgs, Row } from '@libsql/client';
import { ok, err, type Result } from '../domain/result';
import { ListingSnapshotSchema, type ListingSnapshot } from '../domain/snapshot';
import {
  LedgerRecommendationSchema,
  type LedgerRecommendation,
} from '../domain/recommendation';
import { IdentityVersionSchema, type IdentityVersion } from '../domain/identity';
import type { StorageClient } from './storage-client';

/**
 * The LibSQL `StorageClient` (Build Appendix §B). A raw `@libsql/client` over
 * the *same* database file Mastra uses, so our `aso_*` tables sit beside its
 * own — no ORM. JSON-bearing columns hold serialised domain objects; we
 * validate them with their zod schema on the way out, so a corrupt or
 * schema-drifted row fails loudly here rather than silently downstream.
 *
 * Crucially, nothing SQL leaks past this class: every method takes and returns
 * domain types only. That is the contract the LibSQL↔Postgres swap rests on.
 *
 * Phase 6a: every method gains `tenantId` as its first parameter. Every SQL
 * read/write is scoped to that tenant — cross-tenant access is impossible by
 * construction (the WHERE clause enforces it).
 */
export class LibSqlStorageClient implements StorageClient {
  readonly #db: Client;

  constructor(db: Client) {
    this.#db = db;
  }

  async #run(sql: string, args: InArgs = []): Promise<Result<Row[]>> {
    try {
      const res = await this.#db.execute({ sql, args });
      return ok(res.rows);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }

  // ── Snapshots ──────────────────────────────────────────────────────────
  async putSnapshot(tenantId: string, s: ListingSnapshot): Promise<Result<void>> {
    const r = await this.#run(
      `INSERT INTO aso_listing_snapshots
        (id, app_id, country, tenant_id, fetched_at, listing_json, signals_json,
         report_json, rubric_version, prompt_hash, model_id, vision_result_json,
         candidate_result_json, theme_result_json,
         function_competitor_seeds_json, competitor_mining_result_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        s.id,
        s.appId,
        s.country,
        tenantId,
        s.fetchedAt,
        JSON.stringify(s.listing),
        JSON.stringify(s.signals ?? null),
        JSON.stringify(s.report),
        s.rubricVersion,
        s.promptHash,
        s.modelId,
        JSON.stringify(s.visionResult ?? null),
        JSON.stringify(s.candidateResult ?? null),
        JSON.stringify(s.themeResult ?? null),
        s.functionCompetitorSeeds != null ? JSON.stringify(s.functionCompetitorSeeds) : null,
        JSON.stringify(s.competitorMiningResult ?? null),
      ],
    );
    return r.ok ? ok(undefined) : err(r.error);
  }

  async latestSnapshot(
    tenantId: string,
    appId: string,
    country: string,
  ): Promise<Result<ListingSnapshot | null>> {
    const r = await this.#run(
      `SELECT * FROM aso_listing_snapshots
        WHERE tenant_id = ? AND app_id = ? AND country = ?
        ORDER BY fetched_at DESC LIMIT 1`,
      [tenantId, appId, country],
    );
    if (!r.ok) return err(r.error);
    const [row] = r.value;
    if (!row) return ok(null);
    return this.#parseSnapshot(row);
  }

  #parseSnapshot(row: Row): Result<ListingSnapshot> {
    // Optional JSON blobs — may be absent in older rows (columns added later).
    const visionResultRaw = row.vision_result_json != null
      ? JSON.parse(String(row.vision_result_json))
      : undefined;
    const candidateResultRaw = row.candidate_result_json != null
      ? JSON.parse(String(row.candidate_result_json))
      : undefined;
    const themeResultRaw = row.theme_result_json != null
      ? JSON.parse(String(row.theme_result_json))
      : undefined;
    const functionCompetitorSeedsRaw = row.function_competitor_seeds_json != null
      ? JSON.parse(String(row.function_competitor_seeds_json))
      : undefined;
    const competitorMiningResultRaw = row.competitor_mining_result_json != null
      ? JSON.parse(String(row.competitor_mining_result_json))
      : undefined;

    const parsed = ListingSnapshotSchema.safeParse({
      id: row.id,
      appId: row.app_id,
      country: row.country,
      fetchedAt: row.fetched_at,
      listing: JSON.parse(String(row.listing_json)),
      signals: JSON.parse(String(row.signals_json)),
      report: JSON.parse(String(row.report_json)),
      rubricVersion: row.rubric_version,
      promptHash: row.prompt_hash,
      modelId: row.model_id,
      visionResult: visionResultRaw ?? undefined,
      candidateResult: candidateResultRaw ?? undefined,
      themeResult: themeResultRaw ?? undefined,
      functionCompetitorSeeds: functionCompetitorSeedsRaw ?? undefined,
      competitorMiningResult: competitorMiningResultRaw ?? undefined,
    });
    return parsed.success
      ? ok(parsed.data)
      : err(`corrupt snapshot row: ${parsed.error.message}`);
  }

  // ── Recommendations ──────────────────────────────────────────────────────
  async upsertRecommendation(tenantId: string, rec: LedgerRecommendation): Promise<Result<void>> {
    // Dedup on (tenant_id, app_id, country, rec_key): a re-raise refreshes the
    // mutable fields and bumps last_seen_at, but keeps the original row's
    // identity (id, first_seen_at) — the ledger holds one live row per logical rec.
    const r = await this.#run(
      `INSERT INTO aso_recommendations
        (id, app_id, country, tenant_id, rec_key, value_key, taxonomy_version,
         dimension, intent, target_field, title, body, before_text, after_text,
         evidence_json, status, superseded_by, first_seen_at, last_seen_at,
         applied_at, proof_regime)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(tenant_id, app_id, country, rec_key) DO UPDATE SET
         value_key        = excluded.value_key,
         taxonomy_version = excluded.taxonomy_version,
         dimension        = excluded.dimension,
         intent           = excluded.intent,
         target_field     = excluded.target_field,
         title            = excluded.title,
         body             = excluded.body,
         before_text      = excluded.before_text,
         after_text       = excluded.after_text,
         evidence_json    = excluded.evidence_json,
         status           = excluded.status,
         superseded_by    = excluded.superseded_by,
         last_seen_at     = excluded.last_seen_at,
         applied_at       = excluded.applied_at,
         proof_regime     = excluded.proof_regime`,
      [
        rec.id,
        rec.appId,
        rec.country,
        tenantId,
        rec.recKey,
        rec.valueKey,
        rec.taxonomyVersion ?? null,
        rec.dimension,
        rec.intent,
        rec.targetField ?? null,
        rec.title,
        rec.body,
        rec.beforeText ?? null,
        rec.afterText ?? null,
        JSON.stringify(rec.evidence),
        rec.status,
        rec.supersededBy ?? null,
        rec.firstSeenAt,
        rec.lastSeenAt,
        rec.appliedAt ?? null,
        rec.proofRegime,
      ],
    );
    return r.ok ? ok(undefined) : err(r.error);
  }

  async ledger(
    tenantId: string,
    appId: string,
    country: string,
  ): Promise<Result<LedgerRecommendation[]>> {
    const r = await this.#run(
      `SELECT * FROM aso_recommendations
        WHERE tenant_id = ? AND app_id = ? AND country = ?
        ORDER BY first_seen_at ASC, id ASC`,
      [tenantId, appId, country],
    );
    if (!r.ok) return err(r.error);
    const out: LedgerRecommendation[] = [];
    for (const row of r.value) {
      const parsed = this.#parseRec(row);
      if (!parsed.ok) return err(parsed.error);
      out.push(parsed.value);
    }
    return ok(out);
  }

  #parseRec(row: Row): Result<LedgerRecommendation> {
    const parsed = LedgerRecommendationSchema.safeParse({
      id: row.id,
      appId: row.app_id,
      country: row.country,
      recKey: row.rec_key,
      valueKey: row.value_key,
      taxonomyVersion: row.taxonomy_version,
      dimension: row.dimension,
      intent: row.intent,
      targetField: row.target_field,
      title: row.title,
      body: row.body,
      beforeText: row.before_text,
      afterText: row.after_text,
      evidence: JSON.parse(String(row.evidence_json)),
      status: row.status,
      supersededBy: row.superseded_by,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      appliedAt: row.applied_at,
      proofRegime: row.proof_regime,
    });
    return parsed.success
      ? ok(parsed.data)
      : err(`corrupt recommendation row: ${parsed.error.message}`);
  }

  async recordOccurrence(
    tenantId: string,
    recId: string,
    snapshotId: string,
    wasDismissed: boolean,
  ): Promise<Result<void>> {
    const r = await this.#run(
      `INSERT INTO aso_rec_occurrences (rec_id, snapshot_id, tenant_id, was_dismissed)
       VALUES (?,?,?,?)
       ON CONFLICT(rec_id, snapshot_id) DO UPDATE SET
         was_dismissed = MAX(was_dismissed, excluded.was_dismissed)`,
      [recId, snapshotId, tenantId, wasDismissed ? 1 : 0],
    );
    return r.ok ? ok(undefined) : err(r.error);
  }

  // ── Identity ─────────────────────────────────────────────────────────────
  async appendIdentity(tenantId: string, v: IdentityVersion): Promise<Result<void>> {
    const r = await this.#run(
      `INSERT INTO aso_identity_versions
        (id, app_id, country, tenant_id, version, stage, category, category_band,
         niche, niche_band, audience_json, tally_json, divergence, escalate,
         source, created_at, overrode_evidence_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        v.id,
        v.appId,
        v.country,
        tenantId,
        v.version,
        v.stage,
        v.category,
        v.categoryBand,
        v.niche ?? null,
        v.nicheBand ?? null,
        v.audience == null ? null : JSON.stringify(v.audience),
        JSON.stringify(v.tally),
        v.divergence,
        v.escalate ? 1 : 0,
        v.source,
        v.createdAt,
        JSON.stringify(v.overrodeEvidence ?? null),
      ],
    );
    return r.ok ? ok(undefined) : err(r.error);
  }

  async maxIdentityVersion(tenantId: string, appId: string, country: string): Promise<Result<number>> {
    const r = await this.#run(
      `SELECT COALESCE(MAX(version), -1) AS max_version
         FROM aso_identity_versions WHERE tenant_id = ? AND app_id = ? AND country = ?`,
      [tenantId, appId, country],
    );
    if (!r.ok) return err(r.error);
    return ok(Number(r.value[0]?.max_version ?? -1));
  }

  async latestIdentity(
    tenantId: string,
    appId: string,
    country: string,
  ): Promise<Result<IdentityVersion | null>> {
    // Priority rules:
    //  1. human_confirmed rows always beat resolved rows.
    //  2. Within non-human_confirmed rows, full stage beats lite (vision-augmented > text-only).
    //  3. Within human_confirmed rows, version DESC is the only tiebreaker — a newer
    //     lite human_confirmed row (e.g. after "Change identity") must beat an older
    //     full human_confirmed row even though full > lite for resolved rows.
    const r = await this.#run(
      `SELECT * FROM aso_identity_versions
        WHERE tenant_id = ? AND app_id = ? AND country = ?
        ORDER BY
          CASE WHEN source = 'human_confirmed' THEN 0 ELSE 1 END,
          CASE WHEN source != 'human_confirmed' AND stage = 'full' THEN 0 ELSE 1 END,
          version DESC
        LIMIT 1`,
      [tenantId, appId, country],
    );
    if (!r.ok) return err(r.error);
    const [row] = r.value;
    if (!row) return ok(null);
    return this.#parseIdentity(row);
  }

  #parseIdentity(row: Row): Result<IdentityVersion> {
    const parsed = IdentityVersionSchema.safeParse({
      id: row.id,
      appId: row.app_id,
      country: row.country,
      version: Number(row.version),
      stage: row.stage,
      category: row.category,
      categoryBand: row.category_band,
      niche: row.niche,
      nicheBand: row.niche_band,
      audience: row.audience_json == null ? null : JSON.parse(String(row.audience_json)),
      tally: JSON.parse(String(row.tally_json)),
      divergence: row.divergence,
      escalate: Number(row.escalate) === 1,
      source: row.source,
      overrodeEvidence: row.overrode_evidence_json != null
        ? JSON.parse(String(row.overrode_evidence_json))
        : null,
      createdAt: row.created_at,
    });
    return parsed.success
      ? ok(parsed.data)
      : err(`corrupt identity row: ${parsed.error.message}`);
  }

  // ── Competitor tombstones (app-scoped, version-independent) ───────────────
  async tombstoneCompetitor(
    tenantId: string,
    appId: string,
    country: string,
    competitorAppId: string,
  ): Promise<Result<void>> {
    const r = await this.#run(
      `INSERT OR IGNORE INTO aso_competitor_tombstones
        (app_id, country, tenant_id, competitor_app_id, rejected_at)
       VALUES (?,?,?,?,?)`,
      [appId, country, tenantId, competitorAppId, new Date().toISOString()],
    );
    return r.ok ? ok(undefined) : err(r.error);
  }

  async tombstones(
    tenantId: string,
    appId: string,
    country: string,
  ): Promise<Result<Set<string>>> {
    const r = await this.#run(
      `SELECT competitor_app_id FROM aso_competitor_tombstones
        WHERE tenant_id = ? AND app_id = ? AND country = ?`,
      [tenantId, appId, country],
    );
    if (!r.ok) return err(r.error);
    return ok(new Set(r.value.map((row) => String(row.competitor_app_id))));
  }
}
