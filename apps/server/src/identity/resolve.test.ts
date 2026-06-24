import { describe, it, expect } from 'vitest';
import { extractIdentitySignals } from './signals';
import { resolveIdentity, type IdentityClassification } from './resolve';
import { domainOf, divergenceBetween } from './domains';
import { loadFixtureListing } from './__fixtures__/load';

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

  it('every tally entry resolves to a citable source tier and freshness', () => {
    const r = resolveFixture('spotify');
    for (const entry of r.tally) {
      expect(entry.sourceTier).toBeTruthy();
      expect(entry.fetchedAt).toBe('2026-06-24T00:00:00.000Z');
    }
  });
});
