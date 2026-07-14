import { describe, it, expect, afterEach } from 'vitest';
import { IdentityVersionSchema } from '../../domain/identity';
import { loadFixtureListing } from '../../identity/__fixtures__/load';
import {
  resolveAppIdentity,
  toIdentityVersion,
  buildFactSheet,
  buildClassifierInput,
  parseClassificationText,
} from './resolve-identity';
import { extractIdentitySignals } from '../../identity/signals';
import type { IdentityClassifier } from './resolve-identity';
import { setWebSearch, resetWebSearch } from '../../sources/websearch/websearch';
import type { WebSearchProvider } from '../../sources/websearch/websearch';
import { ok } from '../../domain/result';

/**
 * The ID-lite tool composition (signals → classify → resolve → stamp). The
 * classifier is stubbed so this stays deterministic and offline; the §F
 * "identity row written (stage=lite)" criterion is asserted on the produced
 * row's shape here, and end-to-end through storage in the workflow test.
 */
const stubClassifier: IdentityClassifier = async () => ({
  functionCategory: 'Electric vehicle companion',
  functionNiche: 'EV companion',
  functionTerms: ['truck', 'vehicle', 'charge'],
});

describe('resolveAppIdentity + toIdentityVersion (ID-lite)', () => {
  it('produces a valid stage=lite identity row that escalates for Rivian', async () => {
    const listing = loadFixtureListing('rivian');
    const resolved = await resolveAppIdentity(listing, stubClassifier, {
      fetchedAt: '2026-06-24T00:00:00.000Z',
    });
    expect(resolved.escalate).toBe(true);
    expect(resolved.divergence).toBe('cross_domain');

    const row = toIdentityVersion('1570215232', 'us', resolved, {
      version: 0,
      createdAt: '2026-06-24T00:00:00.000Z',
    });
    // It is a schema-valid, append-ready row.
    expect(IdentityVersionSchema.safeParse(row).success).toBe(true);
    expect(row.stage).toBe('lite');
    expect(row.source).toBe('resolved');
    expect(row.version).toBe(0);
    expect(row.escalate).toBe(true);
    expect(row.audience).toBeNull(); // ID-full attaches audience later
  });

  it('builds a fact sheet that cites each deterministic signal', () => {
    const sheet = buildFactSheet(extractIdentitySignals(loadFixtureListing('rivian')));
    expect(sheet).toContain('App name:');
    expect(sheet).toContain('Developer: Rivian');
    expect(sheet).toContain('Bundle id org segment: rivian');
    expect(sheet).toContain('Marketing domain: rivian');
    expect(sheet).toContain('Declared store category: Travel');
  });
});

describe('buildClassifierInput', () => {
  it('returns the fact sheet unchanged when probe is undefined', () => {
    expect(buildClassifierInput('FACTS', undefined)).toBe('FACTS');
  });

  it('returns the fact sheet unchanged when probe is searched_and_empty', () => {
    expect(buildClassifierInput('FACTS', { state: 'searched_and_empty' })).toBe('FACTS');
  });

  it('returns the fact sheet unchanged when probe is errored', () => {
    expect(buildClassifierInput('FACTS', { state: 'errored', reason: 'timeout' })).toBe('FACTS');
  });

  it('returns the fact sheet unchanged when corroborated sources all have empty snippets', () => {
    const probe = {
      state: 'corroborated' as const,
      sources: [
        { title: 'Article', url: 'https://example.com', snippet: '' },
        { title: 'Post', url: 'https://blog.example.com', snippet: '   ' },
      ],
    };
    expect(buildClassifierInput('FACTS', probe)).toBe('FACTS');
  });

  it('prepends a web evidence block when corroborated with snippets', () => {
    const probe = {
      state: 'corroborated' as const,
      sources: [
        { title: 'Rivian Review', url: 'https://techcrunch.com/rivian', snippet: 'EV companion app' },
      ],
    };
    const result = buildClassifierInput('FACTS', probe);
    expect(result).toContain('Web evidence');
    expect(result).toContain('Rivian Review');
    expect(result).toContain('techcrunch.com');
    expect(result).toContain('EV companion app');
    expect(result).toContain('FACTS');
  });

  it('caps at 3 sources even when more are available', () => {
    const probe = {
      state: 'corroborated' as const,
      sources: [
        { title: 'S1', url: 'https://a.com', snippet: 'alpha' },
        { title: 'S2', url: 'https://b.com', snippet: 'beta' },
        { title: 'S3', url: 'https://c.com', snippet: 'gamma' },
        { title: 'S4', url: 'https://d.com', snippet: 'delta' },
        { title: 'S5', url: 'https://e.com', snippet: 'epsilon' },
      ],
    };
    const result = buildClassifierInput('FACTS', probe);
    expect(result).toContain('alpha');
    expect(result).toContain('beta');
    expect(result).toContain('gamma');
    expect(result).not.toContain('delta');
    expect(result).not.toContain('epsilon');
  });
});

describe('resolveAppIdentity — web search enrichment', () => {
  afterEach(() => resetWebSearch());

  it('passes enriched input (with web evidence) to the classifier when probe is corroborated', async () => {
    const fakeSearch: WebSearchProvider = {
      id: 'fake',
      available: true,
      probe: async () => ok({
        state: 'corroborated',
        sources: [{ title: 'Rivian Coverage', url: 'https://techcrunch.com/rivian', snippet: 'EV truck app' }],
      }),
    };
    setWebSearch(fakeSearch);

    let capturedInput = '';
    const capturingClassifier: IdentityClassifier = async (input) => {
      capturedInput = input;
      return { functionCategory: 'EV companion', functionNiche: null, functionTerms: [] };
    };

    const listing = loadFixtureListing('rivian');
    await resolveAppIdentity(listing, capturingClassifier);

    expect(capturedInput).toContain('Web evidence');
    expect(capturedInput).toContain('EV truck app');
    expect(capturedInput).toContain('techcrunch.com');
  });

  it('passes the plain fact sheet to the classifier when probe returns searched_and_empty', async () => {
    const fakeSearch: WebSearchProvider = {
      id: 'fake',
      available: false,
      probe: async () => ok({ state: 'searched_and_empty' }),
    };
    setWebSearch(fakeSearch);

    let capturedInput = '';
    const capturingClassifier: IdentityClassifier = async (input) => {
      capturedInput = input;
      return { functionCategory: 'EV companion', functionNiche: null, functionTerms: [] };
    };

    const listing = loadFixtureListing('rivian');
    await resolveAppIdentity(listing, capturingClassifier);

    expect(capturedInput).not.toContain('Web evidence');
    expect(capturedInput).toContain('Developer:');
  });
});

describe('parseClassificationText (fails safe, never throws)', () => {
  it('parses a clean JSON classification', () => {
    const out = parseClassificationText('{"functionCategory":"Music streaming","functionNiche":"music","functionTerms":["song"]}');
    expect(out.functionCategory).toBe('Music streaming');
    expect(out.functionTerms).toEqual(['song']);
  });

  it('parses JSON embedded in prose / code fences', () => {
    const out = parseClassificationText('Here you go:\n```json\n{"functionCategory":"X","functionNiche":null,"functionTerms":[]}\n```');
    expect(out.functionCategory).toBe('X');
  });

  it('returns Unknown (does not throw) on a brace-balanced but invalid JSON body', () => {
    // Trailing comma + single quotes — exactly what extractJsonObject brace-matches
    // but JSON.parse rejects. The pre-fix code threw here, crashing the identify step.
    const out = parseClassificationText("{'functionCategory': 'X', 'functionTerms': [],}");
    expect(out.functionCategory).toBe('Unknown');
    expect(out.functionTerms).toEqual([]);
  });

  it('returns Unknown when there is no JSON object at all', () => {
    expect(parseClassificationText('the model refused to answer').functionCategory).toBe('Unknown');
  });

  it('returns Unknown when JSON is valid but the wrong shape', () => {
    expect(parseClassificationText('{"foo":1}').functionCategory).toBe('Unknown');
  });
});
