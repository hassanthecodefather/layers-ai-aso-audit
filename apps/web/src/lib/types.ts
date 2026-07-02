/**
 * View-model types for the audit report.
 *
 * These mirror the server's domain types (`apps/server/src/domain`). They are
 * intentionally redeclared rather than imported across the workspace boundary:
 * the web app consumes the audit as JSON over HTTP, so it depends on the
 * *wire shape*, not on server code. Keeping them separate means the UI builds
 * with no coupling to the server's dependency tree.
 */

export interface ResolvedIdentity {
  category: string;
  categoryBand: 'high' | 'medium' | 'low';
  niche: string | null;
  nicheBand: 'high' | 'medium' | 'low' | null;
  divergence: string;
  escalate: boolean;
  source: string;
}

export interface IdentityDecision {
  action: 'confirm' | 'correct';
  category?: string;
  niche?: string | null;
}

export interface AppSummary {
  appId: string;
  country: string;
  url: string;
  name: string;
  developer: string;
  iconUrl: string | null;
  primaryGenre: string | null;
  averageRating: number | null;
  ratingCount: number | null;
}

export type Confidence = 'observed' | 'inferred' | 'unavailable';

export interface ScoredDimension {
  id: string;
  label: string;
  weight: number;
  score: number;
  weightedPoints: number;
  confidence: Confidence;
  findings: string;
  evidence: string[];
}

export type RecommendationCategory = 'quick-win' | 'high-impact' | 'strategic';

export interface Recommendation {
  category: RecommendationCategory;
  dimension: string;
  intent: string;
  referent: { kind: string; value?: string; bucket?: string; text?: string };
  title: string;
  rationale: string;
  evidence: string;
  before: string | null;
  after: string | null;
  proofRegime?: 'observable_now' | 'correlational' | 'funnel_asc' | 'ppo_causal';
}

export interface CompetitorRow {
  name: string;
  rating: string;
  positioning: string;
  edge: string;
}

export interface VersionDelta {
  olderVersion: string;
  newerVersion: string;
  olderAvgRating: number;
  newerAvgRating: number;
  delta: number;
}

export interface ThemeRow {
  bucket: string;
  text: string;
  reviewCount: number;
  isUnresolved: boolean;
}

export interface ThemeResult {
  themes: ThemeRow[];
  versionDelta: VersionDelta | null;
  featureRequests: string[];
  sampleSize: number;
  taxonomyVersion: 'theme-taxonomy@1';
}

export interface AuditReport {
  app: AppSummary;
  generatedAt: string;
  headline: string;
  overallScore: number;
  dimensions: ScoredDimension[];
  quickWins: Recommendation[];
  highImpact: Recommendation[];
  strategic: Recommendation[];
  competitorComparison: { summary: string; rows: CompetitorRow[] };
  limitations: string[];
  themeResult?: ThemeResult | null;
}

export interface ProgressEvent {
  phase: string;
  message: string;
}
