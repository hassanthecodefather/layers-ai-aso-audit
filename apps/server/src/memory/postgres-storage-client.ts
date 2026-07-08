import postgres from 'postgres';
import { ok, err, type Result } from '../domain/result';
import { ListingSnapshotSchema, type ListingSnapshot } from '../domain/snapshot';
import {
  LedgerRecommendationSchema,
  type LedgerRecommendation,
} from '../domain/recommendation';
import { IdentityVersionSchema, type IdentityVersion } from '../domain/identity';
import type { StorageClient } from './storage-client';

export class PostgresStorageClient implements StorageClient {
  constructor(private readonly sql: postgres.Sql) {}

  // ── Snapshots ──────────────────────────────────────────────────────────────

  async putSnapshot(tenantId: string, s: ListingSnapshot): Promise<Result<void>> {
    try {
      await this.sql`
        INSERT INTO aso_listing_snapshots
          (id, app_id, country, tenant_id, fetched_at, listing_json, signals_json,
           report_json, rubric_version, prompt_hash, model_id, vision_result_json,
           candidate_result_json, theme_result_json,
           function_competitor_seeds_json, competitor_mining_result_json)
        VALUES (
          ${s.id}, ${s.appId}, ${s.country}, ${tenantId}, ${s.fetchedAt},
          ${JSON.stringify(s.listing)}, ${JSON.stringify(s.signals ?? null)},
          ${JSON.stringify(s.report)}, ${s.rubricVersion}, ${s.promptHash}, ${s.modelId},
          ${s.visionResult != null ? JSON.stringify(s.visionResult) : null},
          ${s.candidateResult != null ? JSON.stringify(s.candidateResult) : null},
          ${s.themeResult != null ? JSON.stringify(s.themeResult) : null},
          ${s.functionCompetitorSeeds != null ? JSON.stringify(s.functionCompetitorSeeds) : null},
          ${s.competitorMiningResult != null ? JSON.stringify(s.competitorMiningResult) : null}
        )
      `;
      return ok(undefined);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }

  async latestSnapshot(
    tenantId: string,
    appId: string,
    country: string,
  ): Promise<Result<ListingSnapshot | null>> {
    try {
      const rows = await this.sql`
        SELECT * FROM aso_listing_snapshots
        WHERE tenant_id = ${tenantId} AND app_id = ${appId} AND country = ${country}
        ORDER BY fetched_at DESC LIMIT 1
      `;
      if (!rows[0]) return ok(null);
      return this.#parseSnapshot(rows[0]);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }

  // ── Recommendations ────────────────────────────────────────────────────────

  async upsertRecommendation(tenantId: string, r: LedgerRecommendation): Promise<Result<void>> {
    try {
      await this.sql`
        INSERT INTO aso_recommendations
          (id, app_id, country, tenant_id, rec_key, value_key, taxonomy_version,
           dimension, intent, target_field, title, body, before_text, after_text,
           evidence_json, status, superseded_by, first_seen_at, last_seen_at,
           applied_at, proof_regime)
        VALUES (
          ${r.id}, ${r.appId}, ${r.country}, ${tenantId}, ${r.recKey}, ${r.valueKey},
          ${r.taxonomyVersion ?? null}, ${r.dimension}, ${r.intent},
          ${r.targetField ?? null}, ${r.title}, ${r.body},
          ${r.beforeText ?? null}, ${r.afterText ?? null},
          ${JSON.stringify(r.evidence)}, ${r.status}, ${r.supersededBy ?? null},
          ${r.firstSeenAt}, ${r.lastSeenAt}, ${r.appliedAt ?? null}, ${r.proofRegime}
        )
        ON CONFLICT (tenant_id, app_id, country, rec_key) DO UPDATE SET
          title            = EXCLUDED.title,
          body             = EXCLUDED.body,
          before_text      = EXCLUDED.before_text,
          after_text       = EXCLUDED.after_text,
          evidence_json    = EXCLUDED.evidence_json,
          last_seen_at     = EXCLUDED.last_seen_at,
          status           = EXCLUDED.status,
          value_key        = EXCLUDED.value_key,
          taxonomy_version = EXCLUDED.taxonomy_version
      `;
      return ok(undefined);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }

  async recordOccurrence(
    tenantId: string,
    recId: string,
    snapshotId: string,
    wasDismissed: boolean,
  ): Promise<Result<void>> {
    try {
      await this.sql`
        INSERT INTO aso_rec_occurrences (rec_id, snapshot_id, tenant_id, was_dismissed)
        VALUES (${recId}, ${snapshotId}, ${tenantId}, ${wasDismissed ? 1 : 0})
        ON CONFLICT (rec_id, snapshot_id) DO NOTHING
      `;
      return ok(undefined);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }

  async ledger(
    tenantId: string,
    appId: string,
    country: string,
  ): Promise<Result<LedgerRecommendation[]>> {
    try {
      const rows = await this.sql`
        SELECT * FROM aso_recommendations
        WHERE tenant_id = ${tenantId} AND app_id = ${appId} AND country = ${country}
        ORDER BY first_seen_at ASC
      `;
      const results: LedgerRecommendation[] = [];
      for (const row of rows) {
        const parsed = this.#parseRecommendation(row);
        if (!parsed.ok) return err(parsed.error);
        results.push(parsed.value);
      }
      return ok(results);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }

  // ── Identity ───────────────────────────────────────────────────────────────

  async appendIdentity(tenantId: string, v: IdentityVersion): Promise<Result<void>> {
    try {
      await this.sql`
        INSERT INTO aso_identity_versions
          (id, app_id, country, tenant_id, version, stage, category, category_band,
           niche, niche_band, audience_json, tally_json, divergence, escalate,
           source, created_at, overrode_evidence_json)
        VALUES (
          ${v.id}, ${v.appId}, ${v.country}, ${tenantId}, ${v.version},
          ${v.stage}, ${v.category}, ${v.categoryBand},
          ${v.niche ?? null}, ${v.nicheBand ?? null},
          ${v.audience != null ? JSON.stringify(v.audience) : null},
          ${JSON.stringify(v.tally)}, ${v.divergence}, ${v.escalate ? 1 : 0},
          ${v.source}, ${v.createdAt},
          ${v.overrodeEvidence != null ? JSON.stringify(v.overrodeEvidence) : null}
        )
      `;
      return ok(undefined);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }

  async latestIdentity(
    tenantId: string,
    appId: string,
    country: string,
  ): Promise<Result<IdentityVersion | null>> {
    try {
      // Priority rules (mirrors LibSQL implementation):
      //  1. human_confirmed rows always beat resolved rows.
      //  2. Within non-human_confirmed rows, full stage beats lite.
      //  3. Within human_confirmed rows, version DESC is the tiebreaker.
      const rows = await this.sql`
        SELECT * FROM aso_identity_versions
        WHERE tenant_id = ${tenantId} AND app_id = ${appId} AND country = ${country}
        ORDER BY
          CASE WHEN source = 'human_confirmed' THEN 0 ELSE 1 END,
          CASE WHEN source != 'human_confirmed' AND stage = 'full' THEN 0 ELSE 1 END,
          version DESC
        LIMIT 1
      `;
      if (!rows[0]) return ok(null);
      return this.#parseIdentity(rows[0]);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }

  async maxIdentityVersion(
    tenantId: string,
    appId: string,
    country: string,
  ): Promise<Result<number>> {
    try {
      const rows = await this.sql`
        SELECT COALESCE(MAX(version), -1) AS max_version FROM aso_identity_versions
        WHERE tenant_id = ${tenantId} AND app_id = ${appId} AND country = ${country}
      `;
      return ok(Number(rows[0]?.max_version ?? -1));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }

  // ── Tombstones ─────────────────────────────────────────────────────────────

  async tombstoneCompetitor(
    tenantId: string,
    appId: string,
    country: string,
    competitorAppId: string,
  ): Promise<Result<void>> {
    try {
      await this.sql`
        INSERT INTO aso_competitor_tombstones
          (tenant_id, app_id, country, competitor_app_id, rejected_at)
        VALUES (${tenantId}, ${appId}, ${country}, ${competitorAppId}, ${new Date().toISOString()})
        ON CONFLICT (tenant_id, app_id, country, competitor_app_id) DO NOTHING
      `;
      return ok(undefined);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }

  async tombstones(
    tenantId: string,
    appId: string,
    country: string,
  ): Promise<Result<Set<string>>> {
    try {
      const rows = await this.sql`
        SELECT competitor_app_id FROM aso_competitor_tombstones
        WHERE tenant_id = ${tenantId} AND app_id = ${appId} AND country = ${country}
      `;
      return ok(new Set(rows.map((r) => String(r.competitor_app_id))));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }

  // ── Private parsers ────────────────────────────────────────────────────────

  #parseSnapshot(row: postgres.Row): Result<ListingSnapshot> {
    const visionResultRaw =
      row.vision_result_json != null ? JSON.parse(String(row.vision_result_json)) : undefined;
    const candidateResultRaw =
      row.candidate_result_json != null
        ? JSON.parse(String(row.candidate_result_json))
        : undefined;
    const themeResultRaw =
      row.theme_result_json != null ? JSON.parse(String(row.theme_result_json)) : undefined;
    const functionCompetitorSeedsRaw =
      row.function_competitor_seeds_json != null
        ? JSON.parse(String(row.function_competitor_seeds_json))
        : undefined;
    const competitorMiningResultRaw =
      row.competitor_mining_result_json != null
        ? JSON.parse(String(row.competitor_mining_result_json))
        : undefined;

    const parsed = ListingSnapshotSchema.safeParse({
      id: String(row.id),
      appId: String(row.app_id),
      country: String(row.country),
      fetchedAt: String(row.fetched_at),
      listing: JSON.parse(String(row.listing_json)),
      signals: row.signals_json != null ? JSON.parse(String(row.signals_json)) : undefined,
      report: JSON.parse(String(row.report_json)),
      rubricVersion: String(row.rubric_version),
      promptHash: String(row.prompt_hash),
      modelId: String(row.model_id),
      visionResult: visionResultRaw,
      candidateResult: candidateResultRaw,
      themeResult: themeResultRaw,
      functionCompetitorSeeds: functionCompetitorSeedsRaw,
      competitorMiningResult: competitorMiningResultRaw,
    });
    return parsed.success ? ok(parsed.data) : err(parsed.error.message);
  }

  #parseRecommendation(row: postgres.Row): Result<LedgerRecommendation> {
    const parsed = LedgerRecommendationSchema.safeParse({
      id: String(row.id),
      appId: String(row.app_id),
      country: String(row.country),
      recKey: String(row.rec_key),
      valueKey: String(row.value_key),
      taxonomyVersion: row.taxonomy_version != null ? String(row.taxonomy_version) : null,
      dimension: String(row.dimension),
      intent: String(row.intent),
      targetField: row.target_field != null ? String(row.target_field) : null,
      title: String(row.title),
      body: String(row.body),
      beforeText: row.before_text != null ? String(row.before_text) : null,
      afterText: row.after_text != null ? String(row.after_text) : null,
      evidence: JSON.parse(String(row.evidence_json)),
      status: String(row.status),
      supersededBy: row.superseded_by != null ? String(row.superseded_by) : null,
      firstSeenAt: String(row.first_seen_at),
      lastSeenAt: String(row.last_seen_at),
      appliedAt: row.applied_at != null ? String(row.applied_at) : null,
      proofRegime: String(row.proof_regime),
    });
    return parsed.success ? ok(parsed.data) : err(parsed.error.message);
  }

  #parseIdentity(row: postgres.Row): Result<IdentityVersion> {
    const parsed = IdentityVersionSchema.safeParse({
      id: String(row.id),
      appId: String(row.app_id),
      country: String(row.country),
      version: Number(row.version),
      stage: String(row.stage),
      category: String(row.category),
      categoryBand: String(row.category_band),
      niche: row.niche != null ? String(row.niche) : null,
      nicheBand: row.niche_band != null ? String(row.niche_band) : null,
      audience: row.audience_json != null ? JSON.parse(String(row.audience_json)) : null,
      tally: JSON.parse(String(row.tally_json)),
      divergence: String(row.divergence),
      escalate: Boolean(row.escalate),
      source: String(row.source),
      createdAt: String(row.created_at),
      overrodeEvidence:
        row.overrode_evidence_json != null
          ? JSON.parse(String(row.overrode_evidence_json))
          : null,
    });
    return parsed.success ? ok(parsed.data) : err(parsed.error.message);
  }
}
