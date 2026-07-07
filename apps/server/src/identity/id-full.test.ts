/**
 * §F P2 Acceptance Tests for ID-full (Task B2).
 *
 * TDD: write RED first, then implement to GREEN.
 */

import { describe, it, expect } from 'vitest';
import type { ResolvedIdentity } from './resolve';
import type { AppListing } from '../domain/listing';
import type { CreativeMatchResult, IdentityVisionClient } from './id-full';
import { runIdFull } from './id-full';

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Minimal AppListing stub for B2 tests (only iconUrl + screenshotUrls matter). */
const stubListing: AppListing = {
  appId: 'com.rivian.app',
  country: 'us',
  url: 'https://apps.apple.com/us/app/rivian/id1234567890',
  name: 'Rivian',
  developer: 'Rivian Automotive',
  iconUrl: 'https://cdn.example.com/icon.png',
  primaryGenre: 'Utilities',
  genres: ['Utilities'],
  price: 0,
  formattedPrice: 'Free',
  bundleId: 'com.rivian.app',
  sellerUrl: 'https://rivian.com',
  subtitle: null,
  promotionalText: null,
  description: 'Control your Rivian.',
  releaseNotes: null,
  version: '1.0',
  screenshotUrls: ['https://cdn.example.com/screen1.png'],
  ipadScreenshotUrls: [],
  hasPreviewVideo: false,
  crawledScreenshotCount: 0,
  averageRating: 4.5,
  ratingCount: 100,
  currentVersionRating: null,
  currentVersionRatingCount: null,
  contentRating: '4+',
  releaseDate: '2020-01-01',
  currentVersionReleaseDate: '2024-01-01',
  reviews: [],
  competitors: [],
  provenance: { itunes: true, crawler: false, reviews: false, competitors: false, observedFromCache: false },
};

/** A resolved ID-lite identity that escalated due to low niche band (not cross_domain). */
const litePriorEscalated: ResolvedIdentity = {
  category: 'Electric vehicle companion',
  categoryBand: 'high',
  niche: null,
  nicheBand: 'low',
  divergence: 'none',
  escalate: true,  // escalated because categoryBand=high + nicheBand=low
  tally: [
    {
      family: 'developer',
      value: 'Rivian Automotive',
      sourceTier: 'observed_on_store',
      agrees: true,
      fetchedAt: '2024-01-01T00:00:00.000Z',
    },
  ],
  source: 'resolved',
  functionTerms: [],
  overrodeEvidence: null,
};

/** A resolved ID-lite identity that did NOT escalate. */
const litePriorNormal: ResolvedIdentity = {
  category: 'Electric vehicle companion',
  categoryBand: 'high',
  niche: 'Rivian owners',
  nicheBand: 'medium',
  divergence: 'none',
  escalate: false,
  tally: [
    {
      family: 'developer',
      value: 'Rivian Automotive',
      sourceTier: 'observed_on_store',
      agrees: true,
      fetchedAt: '2024-01-01T00:00:00.000Z',
    },
  ],
  source: 'resolved',
  functionTerms: [],
  overrodeEvidence: null,
};

/** A resolved ID-lite identity escalated with cross_domain divergence. */
const litePriorEscalatedCrossDomain: ResolvedIdentity = {
  category: 'Electric vehicle companion',
  categoryBand: 'high',
  niche: null,
  nicheBand: 'low',
  divergence: 'cross_domain',
  escalate: true,  // escalated due to structural divergence
  tally: [
    {
      family: 'developer',
      value: 'Rivian Automotive',
      sourceTier: 'observed_on_store',
      agrees: true,
      fetchedAt: '2024-01-01T00:00:00.000Z',
    },
  ],
  source: 'resolved',
  functionTerms: [],
  overrodeEvidence: null,
};

/** Canned creative-match result: everything checks out. */
const creativeMatchOk: CreativeMatchResult = {
  creativeMatchesFunction: true,
  confidence: 'observed',
  resolvedNiche: 'EV companion',
  nicheBand: 'high',
  audience: {
    description: 'Rivian vehicle owners',
    segments: ['EV owners', 'Rivian customers'],
  },
};

/** Canned creative-match result: mismatch. */
const creativeMatchMismatch: CreativeMatchResult = {
  creativeMatchesFunction: false,
  confidence: 'inferred',
  resolvedNiche: null,
  nicheBand: 'low',
  audience: {
    description: 'General users',
    segments: [],
  },
};

/** Stub that returns a canned result. */
class StubIdentityVisionClient implements IdentityVisionClient {
  readonly #result: CreativeMatchResult;
  constructor(result: CreativeMatchResult) {
    this.#result = result;
  }
  async analyzeCreativeMatch(
    _iconUrl: string | null,
    _firstScreenshotUrl: string | null,
    _functionCategory: string,
  ): Promise<CreativeMatchResult> {
    return this.#result;
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runIdFull', () => {
  const now = '2024-06-29T00:00:00.000Z';

  it('P2-1: stage=full without mutating deterministic fields', async () => {
    const client = new StubIdentityVisionClient(creativeMatchOk);
    const result = await runIdFull(stubListing, litePriorNormal, client, 1, now);

    // Stage must be 'full'
    expect(result.identityVersion.stage).toBe('full');

    // Deterministic fields must be verbatim copies from litePrior
    expect(result.identityVersion.category).toBe(litePriorNormal.category);
    expect(result.identityVersion.categoryBand).toBe(litePriorNormal.categoryBand);
    expect(result.identityVersion.niche).toBe(litePriorNormal.niche);
    expect(result.identityVersion.tally).toEqual(litePriorNormal.tally);
    expect(result.identityVersion.divergence).toBe(litePriorNormal.divergence);
    expect(result.identityVersion.source).toBe(litePriorNormal.source);
  });

  it('P2-2: audience is non-null with at least a description string', async () => {
    const client = new StubIdentityVisionClient(creativeMatchOk);
    const result = await runIdFull(stubListing, litePriorNormal, client, 1, now);

    expect(result.identityVersion.audience).not.toBeNull();
    const audience = result.identityVersion.audience as { description: string; segments: string[] };
    expect(typeof audience.description).toBe('string');
    expect(audience.description.length).toBeGreaterThan(0);
  });

  it('P2-3: creative mismatch → visionEscalation=true', async () => {
    const client = new StubIdentityVisionClient(creativeMatchMismatch);
    const result = await runIdFull(stubListing, litePriorNormal, client, 1, now);

    expect(result.visionEscalation).toBe(true);
    expect(result.identityVersion.escalate).toBe(true);
  });

  it('P2-4: creative match on previously-escalated identity → de-escalation (escalate=false)', async () => {
    // litePriorEscalated: escalated because categoryBand=high + nicheBand=low
    // divergence=none → not cross_domain → de-escalation is permitted
    const client = new StubIdentityVisionClient(creativeMatchOk);
    const result = await runIdFull(stubListing, litePriorEscalated, client, 1, now);

    // Vision confirmed creative matches function → resolve the ambiguity
    expect(result.identityVersion.escalate).toBe(false);
    // nicheBand should be updated to vision's reading
    expect(result.identityVersion.nicheBand).toBe('high');
  });

  it('cross_domain divergence prevents de-escalation even when creative matches', async () => {
    // litePrior: escalate=true, divergence='cross_domain'
    // stub returns: creativeMatchesFunction=true
    // expected: identityVersion.escalate === true (guard blocked de-escalation)
    //           visionEscalation === false (creative matched, no new escalation)
    const client = new StubIdentityVisionClient(creativeMatchOk);
    const result = await runIdFull(stubListing, litePriorEscalatedCrossDomain, client, 1, now);

    expect(result.identityVersion.escalate).toBe(true);
    expect(result.visionEscalation).toBe(false);
  });
});
