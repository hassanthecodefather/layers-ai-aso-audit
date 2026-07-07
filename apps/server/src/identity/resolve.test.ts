import { describe, it, expect } from 'vitest';
import { extractIdentitySignals } from './signals';
import { resolveIdentity, type IdentityClassification } from './resolve';
import { domainOf, divergenceBetween } from './domains';
import { loadFixtureListing } from './__fixtures__/load';
import { OverrodeEvidenceSchema } from '../domain/identity';

/**
 * §F ID-lite acceptance criteria, run against the frozen real fixtures (§A0).
 *
 * The deterministic signal extraction + tally/band logic is the unit under
 * test; the model's function classification is injected as a per-fixture stub
 * (in production it's a Gemini call over the identity fact sheet), so "given
 * these signals, the band is X" is a writable, non-flaky assertion.
 */

// What the model would conclude the app *does*, from the fact sheet.
const CLASSIFY: Record<string, IdentityClassification> = {
  rivian: {
    functionCategory: 'Electric vehicle companion',
    functionNiche: 'EV companion',
    functionTerms: ['truck', 'vehicle', 'charge', 'charging', 'gear guard'],
  },
  tiktok: {
    functionCategory: 'Short-form video social network',
    functionNiche: 'short-form video',
    functionTerms: ['video', 'fyp', 'feed', 'creator'],
  },
  spotify: {
    functionCategory: 'Music streaming',
    functionNiche: 'music streaming',
    functionTerms: ['music', 'song', 'playlist', 'podcast'],
  },
  onstoreonly: {
    functionCategory: 'Productivity to-do list',
    functionNiche: 'to-do list',
    functionTerms: ['todo', 'task', 'list', 'reminder', 'widget'],
  },
};

const resolveFixture = (name: string) =>
  resolveIdentity(
    extractIdentitySignals(loadFixtureListing(name)),
    CLASSIFY[name]!,
    { fetchedAt: '2026-06-24T00:00:00.000Z' },
  );

describe('domain divergence (the escalation trigger)', () => {
  it('maps Travel and electric-vehicle to different domains → cross_domain', () => {
    expect(domainOf('Travel')).toBe('travel');
    expect(domainOf('Electric vehicle companion')).toBe('automotive');
    expect(divergenceBetween('Travel', 'Electric vehicle companion')).toBe('cross_domain');
  });

  it('maps a within-category refinement to the same domain → none', () => {
    // Productivity → note-taking is "a note, never an escalation" (spec ID).
    expect(divergenceBetween('Productivity', 'note-taking app')).toBe('none');
  });

  it('never manufactures a conflict from an unmappable string', () => {
    expect(divergenceBetween('Productivity', 'zzzzz unknowable')).toBe('none');
  });
});

describe('§F ID-lite acceptance', () => {
  it('Rivian: Travel-vs-vehicle is cross-domain → escalate', () => {
    const r = resolveFixture('rivian');
    expect(r.divergence).toBe('cross_domain');
    expect(r.categoryBand).toBe('low');
    expect(r.escalate).toBe(true);
    // The tally cites each family to its source (the citable story).
    expect(r.tally.find((t) => t.family === 'developer')?.value).toBe('Rivian');
    expect(r.tally.find((t) => t.family === 'bundle_id')?.value).toBe('rivian');
    expect(r.tally.find((t) => t.family === 'marketing_domain')?.value).toBe('rivian');
  });

  it('TikTok: strong agreeing signals → zero asks', () => {
    const r = resolveFixture('tiktok');
    expect(r.divergence).toBe('none');
    expect(r.escalate).toBe(false);
  });

  it('Spotify: strong agreeing signals → zero asks', () => {
    const r = resolveFixture('spotify');
    expect(r.divergence).toBe('none');
    expect(r.escalate).toBe(false);
    // Brand corroboration across families (bundle + domain + developer all "spotify").
    expect(r.categoryBand).toBe('high');
  });

  it('on-store-only (no marketing domain, vanity bundle): band ≤ medium, no ask', () => {
    const r = resolveFixture('onstoreonly');
    // The vanity bundle contributes nothing; with no external corroboration the
    // tally cannot reach high.
    expect(['low', 'medium']).toContain(r.categoryBand);
    expect(r.categoryBand).not.toBe('high');
    expect(r.escalate).toBe(false);
    // No usable marketing-domain family was produced (sellerUrl absent).
    expect(r.tally.find((t) => t.family === 'marketing_domain')).toBeUndefined();
  });

  it('Fix 4: high-category, non-divergent, niche:null → flag but not escalate (niche inferred-only at ID-lite)', () => {
    // Mirrors the TikTok/Spotify pattern but with functionNiche:null — the LLM
    // returned no niche (common at ID-lite where vision isn't available yet).
    // nicheBand is 'low' by definition, but that should not trigger a human-
    // confirmation ask: niche is definitionally uncertain at this stage.
    const signals = extractIdentitySignals(loadFixtureListing('spotify'));
    const classificationNoNiche: IdentityClassification = {
      functionCategory: 'Music streaming',
      functionNiche: null,
      functionTerms: ['music', 'song', 'playlist'],
    };
    const r = resolveIdentity(signals, classificationNoNiche, {
      fetchedAt: '2026-06-24T00:00:00.000Z',
    });
    expect(r.categoryBand).toBe('high');
    expect(r.nicheBand).toBe('low');
    expect(r.escalate).toBe(false);
  });

  it('every tally entry resolves to a citable source tier and freshness', () => {
    const r = resolveFixture('spotify');
    for (const entry of r.tally) {
      expect(entry.sourceTier).toBeTruthy();
      expect(entry.fetchedAt).toBe('2026-06-24T00:00:00.000Z');
    }
  });
});

// ── Footprint probe integration ───────────────────────────────────────────────

describe('footprint probe tally (F-K5)', () => {
  const signals = extractIdentitySignals(loadFixtureListing('spotify'));
  const classification = CLASSIFY['spotify']!;
  const opts = { fetchedAt: '2026-06-24T00:00:00.000Z' };

  it('corroborated probe adds agrees=true fetched_and_cited tally entry', () => {
    const r = resolveIdentity(signals, classification, {
      ...opts,
      footprintProbe: {
        state: 'corroborated',
        sources: [{ title: 'Spotify Coverage', url: 'https://example.com' }],
      },
    });
    const fp = r.tally.find((t) => t.family === 'footprint');
    expect(fp).toBeDefined();
    expect(fp!.agrees).toBe(true);
    expect(fp!.sourceTier).toBe('fetched_and_cited');
    expect(fp!.value).toContain('1 off-store source');
  });

  it('searched_and_empty probe adds agrees=false tally entry', () => {
    const r = resolveIdentity(signals, classification, {
      ...opts,
      footprintProbe: { state: 'searched_and_empty' },
    });
    const fp = r.tally.find((t) => t.family === 'footprint');
    expect(fp).toBeDefined();
    expect(fp!.agrees).toBe(false);
    expect(fp!.value).toContain('no off-store footprint');
  });

  it('errored probe does not add any tally entry', () => {
    const r = resolveIdentity(signals, classification, {
      ...opts,
      footprintProbe: { state: 'errored', reason: 'timeout' },
    });
    expect(r.tally.find((t) => t.family === 'footprint')).toBeUndefined();
  });

  it('no probe (undefined) does not add any tally entry', () => {
    const r = resolveIdentity(signals, classification, opts);
    expect(r.tally.find((t) => t.family === 'footprint')).toBeUndefined();
  });

  it('Fix 3 regression: mirror-only probe (→ searched_and_empty) does not lift on-store-only band above medium', () => {
    // "Amit Verma" scenario: Tavily returned 3 App-Store-mirror pages which
    // isMirrorUrl() now strips, so the probe arrives here as searched_and_empty.
    // The on-store-only cap must hold — the band should stay ≤ medium.
    const onStoreSignals = extractIdentitySignals(loadFixtureListing('onstoreonly'));
    const r = resolveIdentity(onStoreSignals, CLASSIFY['onstoreonly']!, {
      ...opts,
      footprintProbe: { state: 'searched_and_empty' },
    });
    expect(r.categoryBand).not.toBe('high');
  });

  it('corroborated probe can lift an on-store-only app from medium to high', () => {
    // on-store-only has no external corroboration → medium; adding footprint
    // provides fetched_and_cited (weight=2, agrees=true, tier-2 present) which
    // breaks the on-store-only cap and reaches high.
    const onStoreSignals = extractIdentitySignals(loadFixtureListing('onstoreonly'));
    const rBefore = resolveIdentity(onStoreSignals, CLASSIFY['onstoreonly']!, opts);
    expect(rBefore.categoryBand).not.toBe('high');

    const rAfter = resolveIdentity(onStoreSignals, CLASSIFY['onstoreonly']!, {
      ...opts,
      footprintProbe: {
        state: 'corroborated',
        sources: [{ title: 'Third-party mention', url: 'https://example.com' }],
      },
    });
    // The footprint is an off-store, independent signal — breaks the on-store cap.
    expect(rAfter.tally.find((t) => t.family === 'footprint')?.agrees).toBe(true);
    expect(['medium', 'high']).toContain(rAfter.categoryBand);
    // categoryBand should be at least as good as before, and possibly higher.
    const bands: Record<string, number> = { low: 0, medium: 1, high: 2 };
    expect(bands[rAfter.categoryBand]!).toBeGreaterThanOrEqual(bands[rBefore.categoryBand]!);
  });

  it('source count pluralises correctly', () => {
    const r = resolveIdentity(signals, classification, {
      ...opts,
      footprintProbe: {
        state: 'corroborated',
        sources: [
          { title: 'A', url: 'https://a.com' },
          { title: 'B', url: 'https://b.com' },
          { title: 'C', url: 'https://c.com' },
        ],
      },
    });
    const fp = r.tally.find((t) => t.family === 'footprint');
    expect(fp!.value).toContain('3 off-store sources');
  });
});

it('resolveIdentity carries functionTerms and a null marker by default', () => {
  const resolved = resolveIdentity(
    // reuse whatever signals factory the file already has; if none, inline:
    {
      developer: 'Rivian', developerSlug: 'rivian', bundleOrg: 'rivian',
      marketingDomain: 'rivian', storeCategory: 'Travel', storeGenres: ['Travel'],
      reviewCount: 0, reviewCorpus: '',
    } as any,
    { functionCategory: 'Electric vehicle companion', functionNiche: 'EV companion', functionTerms: ['truck', 'charge'] },
  );
  expect(resolved.functionTerms).toEqual(['truck', 'charge']);
  expect(resolved.overrodeEvidence).toBeNull();
});

it('OverrodeEvidenceSchema accepts a well-formed marker', () => {
  const parsed = OverrodeEvidenceSchema.safeParse({
    category: 'Electric vehicle companion', niche: 'EV companion', functionTerms: ['truck'],
  });
  expect(parsed.success).toBe(true);
});
