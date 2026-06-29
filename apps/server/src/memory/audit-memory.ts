import type { AppListing } from '../domain/listing';
import type { AuditReport, Recommendation as ReportRec, DimensionId } from '../domain/audit';
import type { ListingSnapshot } from '../domain/snapshot';
import type { IdentityVersion } from '../domain/identity';
import type { ResolvedIdentity } from '../identity/resolve';
import {
  type LedgerRecommendation,
  type ProofRegime,
  type EvidenceRef,
  type IntentTag,
} from '../domain/recommendation';
import type { StorageClient } from './storage-client';
import { computeRecKey, valueKeyFor, findContradiction } from './dedup';
import { newId } from './ids';
import { toIdentityVersion } from '../mastra/tools/resolve-identity';

/**
 * The P1 memory service (spec P1 uplifts): turn a finished audit into ledger
 * rows, detect what the user has applied since last time, flag contradictions,
 * and persist an immutable snapshot + identity version. The dedup itself lives
 * in `dedup.ts`; this is the orchestration that makes "audit twice → reads the
 * first, marks applied, never repeats" true end-to-end.
 */

/** Per-dimension defaults for fields the model doesn't emit. */
const DIMENSION_MAP: Record<DimensionId, { targetField: string | null; proofRegime: ProofRegime }> = {
  title:        { targetField: 'title',        proofRegime: 'observable_now' },
  subtitle:     { targetField: 'subtitle',     proofRegime: 'observable_now' },
  keywordField: { targetField: 'keywordField', proofRegime: 'observable_now' },
  description:  { targetField: 'description',  proofRegime: 'correlational'  },
  screenshots:  { targetField: 'screenshots',  proofRegime: 'ppo_causal'     },
  previewVideo: { targetField: null,            proofRegime: 'ppo_causal'     },
  ratings:      { targetField: 'reviews',      proofRegime: 'correlational'  },
  icon:         { targetField: 'icon',          proofRegime: 'ppo_causal'     },
  conversion:   { targetField: null,            proofRegime: 'correlational'  },
  competitive:  { targetField: null,            proofRegime: 'correlational'  },
};

/** Intents that rewrite the app's *identity* — suppressed when ID is unconfirmed. */
const IDENTITY_REWRITING: ReadonlySet<IntentTag> = new Set<IntentTag>(['reposition_identity']);

/** Map one report recommendation to a ledger row (rec_key, value_key, evidence). */
export function toLedgerRec(
  rec: ReportRec,
  ctx: { appId: string; country: string; snapshotId: string; now: string },
): LedgerRecommendation {
  const map = DIMENSION_MAP[rec.dimension];
  // rec.intent and rec.referent are emitted by the model (closed enum + typed
  // discriminator), so rec_key never depends on free-text prose.
  const valueKey = valueKeyFor(rec.intent, rec.referent);
  const recKey = computeRecKey({
    dimension: rec.dimension,
    intent: rec.intent,
    targetField: map.targetField,
    referent: rec.referent,
  });
  const evidence: EvidenceRef[] = [
    map.targetField
      ? { kind: 'listing_field', field: map.targetField, snapshotId: ctx.snapshotId }
      : { kind: 'signal', signalId: rec.dimension, snapshotId: ctx.snapshotId },
  ];
  return {
    id: newId('rec'),
    appId: ctx.appId,
    country: ctx.country,
    recKey,
    valueKey,
    taxonomyVersion: null,
    dimension: rec.dimension,
    intent: rec.intent,
    targetField: map.targetField,
    title: rec.title,
    body: rec.rationale,
    beforeText: rec.before,
    afterText: rec.after,
    evidence,
    status: 'proposed',
    supersededBy: null,
    firstSeenAt: ctx.now,
    lastSeenAt: ctx.now,
    appliedAt: null,
    proofRegime: map.proofRegime,
  };
}

/** The text content of a listing field a rec's `after_text` would land in. */
function listingField(listing: AppListing, targetField: string | null): string | null {
  switch (targetField) {
    case 'title': return listing.name;
    case 'subtitle': return listing.subtitle;
    case 'description': return listing.description;
    default: return null;
  }
}

/**
 * Applied-detection (spec P1 / §C): a prior recommendation becomes `applied`
 * when the *new* listing now satisfies its `after_text` — a **match, not a
 * causal claim**. Returns the prior recs that just flipped, stamped applied.
 */
export function detectApplied(
  prior: readonly LedgerRecommendation[],
  newListing: AppListing,
  now: string,
): LedgerRecommendation[] {
  const flipped: LedgerRecommendation[] = [];
  for (const rec of prior) {
    if (rec.status !== 'proposed') continue;

    // Non-text applied detection (no afterText — check observable state change).
    // Only for intents whose result is deterministic: a video either exists or doesn't.
    if (rec.intent === 'add_preview_video' && newListing.hasPreviewVideo) {
      flipped.push({ ...rec, status: 'applied', appliedAt: now });
      continue;
    }
    // For screenshots/icon: not auto-detectable (creative changes need vision diff).
    // Skip — the user will confirm manually or the rec re-appears on the next audit.

    if (!rec.afterText) continue;
    const field = listingField(newListing, rec.targetField);
    if (field && field.toLowerCase().includes(rec.afterText.toLowerCase())) {
      flipped.push({ ...rec, status: 'applied', appliedAt: now });
    }
  }
  return flipped;
}

/** A plain change-diff between two snapshots (spec P1 "what moved since last audit"). */
export function changeDiff(prior: ListingSnapshot | null, current: ListingSnapshot): string[] {
  if (!prior) return ['First audit on record — no prior snapshot to compare.'];
  const lines: string[] = [];
  const delta = current.report.overallScore - prior.report.overallScore;
  if (delta !== 0) lines.push(`Overall score ${delta > 0 ? '+' : ''}${delta} since last audit.`);
  if (prior.listing.name !== current.listing.name) lines.push(`Title changed: "${prior.listing.name}" → "${current.listing.name}".`);
  if (prior.listing.subtitle !== current.listing.subtitle) lines.push(`Subtitle changed: "${prior.listing.subtitle ?? '∅'}" → "${current.listing.subtitle ?? '∅'}".`);
  const ratingDelta = (current.listing.averageRating ?? 0) - (prior.listing.averageRating ?? 0);
  if (Math.abs(ratingDelta) >= 0.05) lines.push(`Average rating ${ratingDelta > 0 ? '+' : ''}${ratingDelta.toFixed(2)}.`);
  if (lines.length === 0) lines.push('No material listing changes since last audit.');
  return lines;
}

/**
 * Build the prior-audit context string injected into the scoring prompt.
 * Injects only the resolved identity and the identity fact sheet — NOT the
 * live ledger or the change-diff. Generation is stateless (a pure function of
 * listing + identity); the ledger is read after generation, in the memory
 * reconciliation layer (persistAudit), where applied-detection and
 * contradiction-guard operate without polluting the model's input.
 */
export function buildPriorContext(input: {
  identity: ResolvedIdentity;
  priorSnapshot: ListingSnapshot | null;
  identityFactSheet: string;
}): string {
  const { identity } = input;
  const lines: string[] = [];
  lines.push('### Resolved identity (function-grounded)');
  lines.push(`Category: ${identity.category} (confidence: ${identity.categoryBand})`);
  if (identity.niche) lines.push(`Niche: ${identity.niche} (confidence: ${identity.nicheBand})`);
  if (identity.escalate && identity.source !== 'human_confirmed') {
    lines.push(
      `⚠ The store category and the app's true function diverge (cross-domain). Identity is unconfirmed — do not rewrite the listing's core positioning.`,
    );
  }
  lines.push('');
  lines.push('### Identity fact sheet');
  lines.push(input.identityFactSheet);
  return lines.join('\n');
}

export interface PersistInput {
  listing: AppListing;
  signals: unknown;
  report: AuditReport;
  resolved: ResolvedIdentity;
  identityFactSheet: string;
  rubricVersion: string;
  promptHash: string;
  modelId: string;
  now: string;
  /** B1: vision result to persist with the snapshot. Optional for backward compat. */
  visionResult?: unknown;
  /** B4: Pre-fetched prior snapshot (avoids a duplicate storage read). */
  priorSnapshot?: ListingSnapshot | null;
  /** B4: Pre-fetched prior ledger (avoids a duplicate storage read). */
  priorLedger?: LedgerRecommendation[];
}

/** Result of persisting an audit — surfaces what memory did, for the report. */
export interface PersistResult {
  snapshotId: string;
  applied: LedgerRecommendation[];
  contradictions: { candidate: string; conflictsWith: string }[];
  changeDiff: string[];
  identityVersion: number;
}

/**
 * Persist a finished audit: snapshot, identity version, applied-detection over
 * the prior ledger, then upsert this run's recommendations (deduped on
 * rec_key) with contradiction flagging and occurrence recording.
 */
export async function persistAudit(
  storage: StorageClient,
  input: PersistInput,
): Promise<PersistResult> {
  const { listing, report, resolved, now } = input;
  const appId = listing.appId;
  const country = listing.country;

  // B4: use pre-fetched values if provided (avoids duplicate storage reads).
  let priorSnapshot: ListingSnapshot | null;
  if (input.priorSnapshot !== undefined) {
    priorSnapshot = input.priorSnapshot;
  } else {
    const priorSnapshotR = await storage.latestSnapshot(appId, country);
    priorSnapshot = priorSnapshotR.ok ? priorSnapshotR.value : null;
  }

  let priorLedger: LedgerRecommendation[];
  if (input.priorLedger !== undefined) {
    priorLedger = input.priorLedger;
  } else {
    const priorLedgerR = await storage.ledger(appId, country);
    priorLedger = priorLedgerR.ok ? priorLedgerR.value : [];
  }

  // Use the true MAX version (not latestIdentity which prefers full rows) to
  // ensure monotonic version numbers even when the full-preferred read returns
  // an older full row as the semantic head.
  const maxVersionR = await storage.maxIdentityVersion(appId, country);
  const priorVersion = maxVersionR.ok ? maxVersionR.value : -1;

  // 1. Write the immutable snapshot first — evidence chips freeze to its id.
  const snapshotId = newId('snap');
  const snapshot: ListingSnapshot = {
    id: snapshotId,
    appId,
    country,
    fetchedAt: now,
    listing,
    signals: input.signals,
    report,
    rubricVersion: input.rubricVersion,
    promptHash: input.promptHash,
    modelId: input.modelId,
    visionResult: input.visionResult,
  };
  await storage.putSnapshot(snapshot);

  // 2. Append the identity version (stage=lite).
  const identityVersion = priorVersion + 1;
  const idRow: IdentityVersion = toIdentityVersion(appId, country, resolved, {
    version: identityVersion,
    createdAt: now,
  });
  await storage.appendIdentity(idRow);

  // 3. Applied-detection over the prior ledger against the new listing.
  const applied = detectApplied(priorLedger, listing, now);
  const appliedKeys = new Set(applied.map((r) => r.recKey));
  for (const rec of applied) {
    await storage.upsertRecommendation(rec);
    await storage.recordOccurrence(rec.id, snapshotId, false);
  }

  // 4. Upsert this run's recommendations, flagging contradictions.
  const contradictions: PersistResult['contradictions'] = [];
  const identityUnconfirmed = resolved.escalate;
  // Map recKey → stored id so occurrence recording always targets the canonical
  // row. upsertRecommendation uses ON CONFLICT — the winner keeps the original
  // id, not the freshly-minted one in rec. Without this map, a re-raised rec
  // would log its occurrence against an id that doesn't exist in aso_recommendations.
  const priorIdByRecKey = new Map(priorLedger.map((r) => [r.recKey, r.id]));
  for (const reportRec of report.quickWins.concat(report.highImpact, report.strategic)) {
    const rec = toLedgerRec(reportRec, { appId, country, snapshotId, now });
    // Suppress identity-rewriting recs when the identity is unconfirmed (spec ID).
    if (identityUnconfirmed && IDENTITY_REWRITING.has(rec.intent)) continue;
    // Don't re-open something we just detected as applied (the listing already
    // satisfies it) — applied beats a fresh re-proposal of the same rec_key.
    // Its occurrence was already recorded in step 3 against the live row.
    if (appliedKeys.has(rec.recKey)) continue;

    const conflict = findContradiction(priorLedger, rec);
    if (conflict) {
      contradictions.push({ candidate: rec.title, conflictsWith: conflict.title });
    }
    // Re-raising the *exact* rec a human already dismissed must NOT silently
    // re-open it (the upsert's `status = excluded.status` would flip
    // dismissed→proposed). Honour the dismissal: record that it recurred this
    // audit (against the live dismissed row) and leave its status untouched.
    if (conflict && conflict.recKey === rec.recKey && conflict.status === 'dismissed') {
      await storage.recordOccurrence(conflict.id, snapshotId, true);
      continue;
    }
    await storage.upsertRecommendation(rec);
    // Use the stored row's id — on re-raises the original row survives ON CONFLICT.
    await storage.recordOccurrence(priorIdByRecKey.get(rec.recKey) ?? rec.id, snapshotId, false);
  }

  return {
    snapshotId,
    applied,
    contradictions,
    changeDiff: changeDiff(priorSnapshot, snapshot),
    identityVersion,
  };
}
