import { describe, it, expect } from 'vitest';
import { IdentityVersionSchema } from '../../domain/identity';
import { loadFixtureListing } from '../../identity/__fixtures__/load';
import {
  resolveAppIdentity,
  toIdentityVersion,
  buildFactSheet,
  parseClassificationText,
} from './resolve-identity';
import { extractIdentitySignals } from '../../identity/signals';
import type { IdentityClassifier } from './resolve-identity';

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
    expect(sheet).toContain('Developer: Rivian');
    expect(sheet).toContain('Bundle id org segment: rivian');
    expect(sheet).toContain('Marketing domain: rivian');
    expect(sheet).toContain('Declared store category: Travel');
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
