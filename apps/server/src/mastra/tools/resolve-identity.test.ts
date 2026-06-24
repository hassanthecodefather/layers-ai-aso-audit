import { describe, it, expect } from 'vitest';
import { IdentityVersionSchema } from '../../domain/identity';
import { loadFixtureListing } from '../../identity/__fixtures__/load';
import {
  resolveAppIdentity,
  toIdentityVersion,
  buildFactSheet,
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
