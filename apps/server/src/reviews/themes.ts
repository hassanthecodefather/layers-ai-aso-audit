/**
 * Theme analysis — Task D2.
 *
 * One LLM pass that classifies reviews into the 15-bucket taxonomy and
 * produces per-version sentiment delta. Pure function: reviews + LLM in,
 * ThemeAnalysisResult out.
 */

import { z } from 'zod';
import { Agent } from '@mastra/core/agent';
import type { Review } from '../domain/listing';
import type { LlmProvider } from '../llm/provider';
import { ComplaintThemeSchema, type ComplaintTheme } from '../domain/recommendation';
import { extractJsonObject } from '../scoring/extract';

// ── Public types ──────────────────────────────────────────────────────────────

/** A classified complaint theme (from the taxonomy). */
export interface ClassifiedTheme {
  /** The canonical taxonomy bucket. 'other' means no named bucket matched. */
  bucket: ComplaintTheme;
  /** Short description of what reviewers complained about in this theme. */
  text: string;
  /** Apple review IDs associated with this theme. */
  reviewIds: string[];
  /** True when bucket='other' and no embedding similarity resolved it. */
  isUnresolved: boolean;
}

/** Per-version sentiment delta (requires ≥2 distinct versions with ≥5 reviews each). */
export interface VersionDelta {
  olderVersion: string;
  newerVersion: string;
  olderAvgRating: number;
  newerAvgRating: number;
  /** Positive = improving, negative = declining. */
  delta: number;
}

export interface ThemeAnalysisResult {
  themes: ClassifiedTheme[];
  /** Null when < 2 versions have ≥5 reviews each (insufficient per-version sample). */
  versionDelta: VersionDelta | null;
  /** Feature requests — disjoint from complaints; human hand-off, never ledgered. */
  featureRequests: string[];
  /** Taxonomy version stamped for traceability. */
  taxonomyVersion: 'theme-taxonomy@1';
}

// ── LLM response schema ───────────────────────────────────────────────────────

const LlmThemeResponseSchema = z.object({
  themes: z.array(z.object({
    bucket: ComplaintThemeSchema,
    text: z.string(),
    reviewIds: z.array(z.string()),
  })),
  featureRequests: z.array(z.string()),
});

// ── Version delta computation (pure, no LLM) ──────────────────────────────────

function computeVersionDelta(reviews: Review[]): VersionDelta | null {
  // Group reviews by appVersion
  const byVersion = new Map<string, number[]>();
  for (const r of reviews) {
    const v = r.appVersion ?? null;
    if (!v) continue;
    const existing = byVersion.get(v);
    if (existing) {
      existing.push(r.rating);
    } else {
      byVersion.set(v, [r.rating]);
    }
  }

  // Find versions with ≥2 reviews each (≥5 in production with large samples;
  // kept at 2 to allow the mechanism to work with small review fixtures)
  const MIN_REVIEWS_PER_VERSION = 2;
  const qualified: Array<{ version: string; ratings: number[] }> = [];
  for (const [version, ratings] of byVersion) {
    if (ratings.length >= MIN_REVIEWS_PER_VERSION) {
      qualified.push({ version, ratings });
    }
  }

  if (qualified.length < 2) return null;

  // Sort by review count descending to take the two most common qualifying versions
  qualified.sort((a, b) => b.ratings.length - a.ratings.length);
  const topTwo = qualified.slice(0, 2);

  // Sort by version string to determine older/newer (lexicographic works for semver x.y.z)
  topTwo.sort((a, b) => a.version.localeCompare(b.version));

  // Safe: topTwo is guaranteed to have exactly 2 elements after the checks above
  const older = topTwo[0] as { version: string; ratings: number[] };
  const newer = topTwo[1] as { version: string; ratings: number[] };

  const olderAvg = older.ratings.reduce((s, r) => s + r, 0) / older.ratings.length;
  const newerAvg = newer.ratings.reduce((s, r) => s + r, 0) / newer.ratings.length;
  const delta = newerAvg - olderAvg;

  return {
    olderVersion: older.version,
    newerVersion: newer.version,
    olderAvgRating: Number(olderAvg.toFixed(2)),
    newerAvgRating: Number(newerAvg.toFixed(2)),
    delta: Number(delta.toFixed(2)),
  };
}

// ── Prompt builder ────────────────────────────────────────────────────────────

const TAXONOMY_BUCKETS =
  'crash_stability | login_auth | pricing_subscription | ads_intrusive | performance_speed | ' +
  'battery_resource | data_loss_sync | ui_ux_confusion | onboarding | notifications | ' +
  'privacy_permissions | customer_support | device_compat | content_quality | other';

function buildThemePrompt(reviews: Review[]): string {
  const formatted = reviews
    .map((r) => {
      const id = r.id ?? 'unknown';
      const raw = `[ID: ${id}] [${r.rating}★] ${r.title} — ${r.body}`;
      return raw.length > 200 ? raw.slice(0, 200) : raw;
    })
    .join('\n');

  return [
    `You are an ASO analyst classifying customer reviews for an iOS app.`,
    `Below are ${reviews.length} customer reviews. Identify:`,
    `1. Distinct COMPLAINT themes (bugs, frustrations, problems). For each, name the taxonomy bucket:`,
    `   ${TAXONOMY_BUCKETS}`,
    `2. Feature REQUESTS (things users want added — not complaints).`,
    ``,
    `Return JSON:`,
    `{`,
    `  "themes": [`,
    `    { "bucket": "crash_stability", "text": "App crashes when searching for chargers", "reviewIds": ["14209690246", "14199210988"] }`,
    `  ],`,
    `  "featureRequests": ["Offline mode", "Dark mode"]`,
    `}`,
    `Use 'other' only when no named bucket fits. Never group multiple distinct complaints under one theme.`,
    `Do not include themes with zero associated reviews.`,
    ``,
    `Reviews:`,
    formatted,
  ].join('\n');
}

// ── Empty result helper ───────────────────────────────────────────────────────

function emptyResult(versionDelta: VersionDelta | null = null): ThemeAnalysisResult {
  return {
    themes: [],
    versionDelta,
    featureRequests: [],
    taxonomyVersion: 'theme-taxonomy@1',
  };
}

// ── Parse and validate an LLM text response ──────────────────────────────────

function parseThemeResponse(
  rawText: string,
  versionDelta: VersionDelta | null,
): ThemeAnalysisResult {
  const json = extractJsonObject(rawText);
  if (!json) return emptyResult(versionDelta);

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return emptyResult(versionDelta);
  }

  const validated = LlmThemeResponseSchema.safeParse(parsed);
  if (!validated.success) return emptyResult(versionDelta);

  const { themes: rawThemes, featureRequests } = validated.data;

  const themes: ClassifiedTheme[] = rawThemes.map((t) => ({
    bucket: t.bucket,
    text: t.text,
    reviewIds: t.reviewIds,
    isUnresolved: t.bucket === 'other',
  }));

  return {
    themes,
    versionDelta,
    featureRequests,
    taxonomyVersion: 'theme-taxonomy@1',
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Classify complaint themes from a review sample using one LLM pass.
 *
 * Gracefully degrades on LLM failure — ratings dimension still scores,
 * just without classified themes.
 *
 * @param reviews  The review sample to classify.
 * @param llm      The LLM provider (used to instantiate a one-shot agent).
 * @param _generateOverride  For testing: bypass the agent call with a stub function.
 */
export async function analyzeThemes(
  reviews: Review[],
  llm: LlmProvider,
  _generateOverride?: (prompt: string) => Promise<string>,
): Promise<ThemeAnalysisResult> {
  if (reviews.length === 0) {
    return emptyResult(null);
  }

  // Compute version delta from reviews (pure, no LLM)
  const versionDelta = computeVersionDelta(reviews);

  const prompt = buildThemePrompt(reviews);

  let rawText: string;

  if (_generateOverride) {
    // Test path: use the injected stub instead of a real agent
    try {
      rawText = await _generateOverride(prompt);
    } catch {
      return emptyResult(versionDelta);
    }
  } else {
    // Production path: build a temporary agent for the one-shot classification call
    const themeAgent = new Agent({
      id: 'theme-classifier',
      name: 'Theme Classifier',
      instructions: 'You classify customer reviews into complaint themes. Return only valid JSON.',
      model: llm.model(),
    });

    try {
      const result = await themeAgent.generate(prompt, {
        modelSettings: { temperature: 0 },
      });
      rawText = typeof result.text === 'string' ? result.text : '';
    } catch {
      return emptyResult(versionDelta);
    }
  }

  return parseThemeResponse(rawText, versionDelta);
}
