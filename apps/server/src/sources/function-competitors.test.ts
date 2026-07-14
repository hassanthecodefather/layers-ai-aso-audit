import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchFunctionGroundedCompetitors, fetchEvidenceCompetitors, selectFunctionCompetitors, seedKeywords } from './function-competitors';
import type { AppRef } from '../domain/app-url';
import type { ResolvedIdentity } from '../identity/resolve';
import type { AppKittieClient, AppKittieTopApp } from '../keywords/appkittie-client';
import type { StorageClient } from '../memory/storage-client';
import type { Competitor, AppListing } from '../domain/listing';
import type { ListingSnapshot } from '../domain/snapshot';

// ── Mock iTunes batch lookup ────────────────────────────────────────────────────

vi.mock('./itunes', () => ({
  batchLookupCompetitors: vi.fn(),
}));

import { batchLookupCompetitors } from './itunes';

// ── Helpers ───────────────────────────────────────────────────────────────────

const REF: AppRef = { appId: '123456', country: 'us' };

function makeResolved(overrides: Partial<ResolvedIdentity> = {}): ResolvedIdentity {
  return {
    category: 'Electric vehicle companion',
    categoryBand: 'high',
    niche: 'EV charging',
    nicheBand: 'medium',
    divergence: 'none',
    escalate: false,
    tally: [],
    source: 'resolved',
    functionTerms: [],
    overrodeEvidence: null,
    ...overrides,
  };
}

function makeAppKittie(topApps: AppKittieTopApp[]): AppKittieClient {
  return {
    getTopApps: vi.fn().mockResolvedValue(topApps),
    getVolume: vi.fn(),
  } as unknown as AppKittieClient;
}

function makeStorage(tombstoneSet: Set<string> = new Set()): StorageClient {
  return {
    tombstones: vi.fn().mockResolvedValue({ ok: true, value: tombstoneSet }),
    putSnapshot: vi.fn(),
    latestSnapshot: vi.fn(),
    upsertRecommendation: vi.fn(),
    recordOccurrence: vi.fn(),
    ledger: vi.fn(),
    appendIdentity: vi.fn(),
    latestIdentity: vi.fn(),
    maxIdentityVersion: vi.fn(),
    tombstoneCompetitor: vi.fn(),
  } as unknown as StorageClient;
}

function makeCompetitor(appId: string, name: string, description?: string): Competitor {
  return {
    appId,
    name,
    developer: 'Test Dev',
    primaryGenre: 'Utilities',
    averageRating: 4.0,
    ratingCount: 100,
    formattedPrice: 'Free',
    screenshotCount: 3,
    hasPreviewVideo: false,
    ...(description !== undefined ? { description } : {}),
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

// ── Test 1: returns function-matched competitors ───────────────────────────────

describe('fetchFunctionGroundedCompetitors', () => {
  it('returns competitors from AppKittie topApps seeded by identity niche + category', async () => {
    const topApps: AppKittieTopApp[] = [
      { appStoreId: '111', title: 'ChargePoint' },
      { appStoreId: '222', title: 'Electrify America' },
    ];
    const mockAppKittie = makeAppKittie(topApps);
    const mockStorage = makeStorage();
    const mockCompetitors = [
      makeCompetitor('111', 'ChargePoint'),
      makeCompetitor('222', 'Electrify America'),
    ];
    vi.mocked(batchLookupCompetitors).mockResolvedValue(mockCompetitors);

    const result = await fetchFunctionGroundedCompetitors(
      REF,
      makeResolved(),
      mockAppKittie,
      mockStorage,
      'test-tenant',
    );

    expect(result).toEqual(mockCompetitors);
    expect(batchLookupCompetitors).toHaveBeenCalledWith(
      ['111', '222'],
      'us',
      '123456',
      6,
    );
  });

  // ── Test 2: tombstoned peers are excluded ─────────────────────────────────────

  it('excludes tombstoned competitor IDs', async () => {
    const topApps: AppKittieTopApp[] = [
      { appStoreId: '111', title: 'ChargePoint' },
      { appStoreId: '999', title: 'Rejected App' },
      { appStoreId: '222', title: 'Electrify America' },
    ];
    const mockAppKittie = makeAppKittie(topApps);
    // '999' is tombstoned
    const mockStorage = makeStorage(new Set(['999']));
    const mockCompetitors = [makeCompetitor('111', 'ChargePoint'), makeCompetitor('222', 'Electrify America')];
    vi.mocked(batchLookupCompetitors).mockResolvedValue(mockCompetitors);

    await fetchFunctionGroundedCompetitors(REF, makeResolved(), mockAppKittie, mockStorage, 'test-tenant');

    // batchLookupCompetitors should NOT have been called with '999'
    const calledIds = vi.mocked(batchLookupCompetitors).mock.calls[0]![0] as string[];
    expect(calledIds).not.toContain('999');
    expect(calledIds).toContain('111');
    expect(calledIds).toContain('222');
  });

  // ── Test 3: falls back to [] when AppKittie returns no topApps ────────────────

  it('returns [] when AppKittie returns empty topApps', async () => {
    const mockAppKittie = makeAppKittie([]);
    const mockStorage = makeStorage();

    const result = await fetchFunctionGroundedCompetitors(
      REF,
      makeResolved(),
      mockAppKittie,
      mockStorage,
      'test-tenant',
    );

    expect(result).toEqual([]);
    expect(batchLookupCompetitors).not.toHaveBeenCalled();
  });

  // ── Test 4: seeds from niche first, category second ───────────────────────────

  it('seeds from niche first, category second', async () => {
    const resolved = makeResolved({
      niche: 'EV charging',
      category: 'Electric vehicle companion',
    });
    const mockAppKittie = {
      getTopApps: vi.fn().mockResolvedValue([]),
      getVolume: vi.fn(),
    } as unknown as AppKittieClient;
    const mockStorage = makeStorage();

    await fetchFunctionGroundedCompetitors(REF, resolved, mockAppKittie, mockStorage, 'test-tenant');

    const calls = vi.mocked(mockAppKittie.getTopApps).mock.calls;
    // First call should be the niche
    expect(calls[0]![0]).toBe('EV charging');
    // Second call should be the category
    expect(calls[1]![0]).toBe('Electric vehicle companion');
    // No more than MAX_SEEDS=2 calls
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  // ── Test 5: returns [] when all topApps are tombstoned ────────────────────────

  it('returns [] when all collected IDs are tombstoned', async () => {
    const topApps: AppKittieTopApp[] = [
      { appStoreId: '111' },
      { appStoreId: '222' },
    ];
    const mockAppKittie = makeAppKittie(topApps);
    const mockStorage = makeStorage(new Set(['111', '222']));

    const result = await fetchFunctionGroundedCompetitors(
      REF,
      makeResolved(),
      mockAppKittie,
      mockStorage,
      'test-tenant',
    );

    expect(result).toEqual([]);
    expect(batchLookupCompetitors).not.toHaveBeenCalled();
  });

  // ── Test 6: deduplicates IDs across multiple seed queries ─────────────────────

  it('deduplicates topApp IDs across multiple seed queries', async () => {
    const mockAppKittie = {
      getTopApps: vi.fn()
        .mockResolvedValueOnce([{ appStoreId: '111' }, { appStoreId: '222' }])
        .mockResolvedValueOnce([{ appStoreId: '222' }, { appStoreId: '333' }]), // '222' is a duplicate
      getVolume: vi.fn(),
    } as unknown as AppKittieClient;
    const mockStorage = makeStorage();
    vi.mocked(batchLookupCompetitors).mockResolvedValue([]);

    await fetchFunctionGroundedCompetitors(REF, makeResolved(), mockAppKittie, mockStorage, 'test-tenant');

    const calledIds = vi.mocked(batchLookupCompetitors).mock.calls[0]![0] as string[];
    // '222' should appear only once
    expect(calledIds.filter((id) => id === '222').length).toBe(1);
    expect(calledIds).toEqual(['111', '222', '333']);
  });

  // ── Test 7: uses niche-only when niche fills MAX_SEEDS ────────────────────────

  it('only queries category when niche is absent', async () => {
    const resolved = makeResolved({ niche: null, category: 'Electric vehicle companion' });
    const mockAppKittie = {
      getTopApps: vi.fn().mockResolvedValue([]),
      getVolume: vi.fn(),
    } as unknown as AppKittieClient;
    const mockStorage = makeStorage();

    await fetchFunctionGroundedCompetitors(REF, resolved, mockAppKittie, mockStorage, 'test-tenant');

    const calls = vi.mocked(mockAppKittie.getTopApps).mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0]![0]).toBe('Electric vehicle companion');
  });

  // ── Test 8: tombstones storage failure falls back gracefully ──────────────────

  it('falls back to empty tombstone set when storage.tombstones fails', async () => {
    const topApps: AppKittieTopApp[] = [{ appStoreId: '111' }];
    const mockAppKittie = makeAppKittie(topApps);
    const mockStorage = {
      tombstones: vi.fn().mockResolvedValue({ ok: false, error: 'DB error' }),
    } as unknown as StorageClient;
    const mockCompetitors = [makeCompetitor('111', 'ChargePoint')];
    vi.mocked(batchLookupCompetitors).mockResolvedValue(mockCompetitors);

    const result = await fetchFunctionGroundedCompetitors(REF, makeResolved(), mockAppKittie, mockStorage, 'test-tenant');

    // Should still return competitors — tombstone failure doesn't abort
    expect(result).toEqual(mockCompetitors);
  });
});

// ── selectFunctionCompetitors reuse tests ────────────────────────────────────

function makeSnapshot(
  competitors: Competitor[],
  functionCompetitorSeeds?: string[],
): ListingSnapshot {
  return {
    id: 'snap_1',
    appId: '123456',
    country: 'us',
    fetchedAt: '2026-01-01T00:00:00Z',
    listing: { competitors } as unknown as AppListing,
    signals: {},
    report: {} as ListingSnapshot['report'],
    rubricVersion: 'v1',
    promptHash: 'abc123',
    modelId: 'gemini',
    functionCompetitorSeeds,
  };
}

describe('selectFunctionCompetitors', () => {
  it('returns null when priorSnapshot is null', () => {
    expect(selectFunctionCompetitors(makeResolved(), null)).toBeNull();
  });

  it('returns null when priorSnapshot has no functionCompetitorSeeds', () => {
    const snap = makeSnapshot([makeCompetitor('111', 'ChargePoint')]);
    expect(selectFunctionCompetitors(makeResolved(), snap)).toBeNull();
  });

  it('returns null when seeds changed (niche changed)', () => {
    const snap = makeSnapshot(
      [makeCompetitor('111', 'ChargePoint')],
      ['old niche', 'Electric vehicle companion'],
    );
    const resolved = makeResolved({ niche: 'EV charging', category: 'Electric vehicle companion' });
    expect(selectFunctionCompetitors(resolved, snap)).toBeNull();
  });

  it('returns prior competitors when seeds match', () => {
    const competitors = [makeCompetitor('111', 'ChargePoint'), makeCompetitor('222', 'PlugShare')];
    const seeds = ['EV charging', 'Electric vehicle companion'];
    const snap = makeSnapshot(competitors, seeds);
    const resolved = makeResolved({ niche: 'EV charging', category: 'Electric vehicle companion' });

    expect(selectFunctionCompetitors(resolved, snap)).toEqual(competitors);
  });

  it('returns prior competitors when seeds match in different order', () => {
    const competitors = [makeCompetitor('111', 'ChargePoint')];
    // Seeds stored in reversed order — sort should still match
    const snap = makeSnapshot(competitors, ['Electric vehicle companion', 'EV charging']);
    const resolved = makeResolved({ niche: 'EV charging', category: 'Electric vehicle companion' });

    expect(selectFunctionCompetitors(resolved, snap)).toEqual(competitors);
  });

  it('returns null when seeds match but prior competitors are empty', () => {
    const seeds = ['EV charging', 'Electric vehicle companion'];
    const snap = makeSnapshot([], seeds);
    const resolved = makeResolved({ niche: 'EV charging', category: 'Electric vehicle companion' });

    expect(selectFunctionCompetitors(resolved, snap)).toBeNull();
  });
});

// ── seedKeywords unit tests ──────────────────────────────────────────────────

describe('seedKeywords', () => {
  it('seedKeywords prefers functionTerms and dedups case-insensitively', () => {
    const seeds = seedKeywords({
      niche: 'EV companion', category: 'ev companion', functionTerms: ['truck', 'charge'],
    } as any);
    // functionTerms come first; niche and category are identical case-insensitively so only one survives.
    expect(seeds.length).toBe(2);
    expect(seeds[0]).toBe('truck');
    expect(seeds[1]).toBe('charge');
    expect(new Set(seeds.map((s) => s.toLowerCase())).size).toBe(seeds.length);
  });

  it('seedKeywords uses functionTerms first when niche is null', () => {
    const seeds = seedKeywords({ niche: null, category: 'Utilities', functionTerms: ['scanner', 'pdf'] } as any);
    // functionTerms fill both slots; category never reached with MAX_SEEDS=2
    expect(seeds[0]).toBe('scanner');
    expect(seeds[1]).toBe('pdf');
  });

  it('seedKeywords falls back to niche/category when functionTerms is empty (regression guard)', () => {
    const seeds = seedKeywords({ niche: 'EV companion', category: 'Electric vehicle companion', functionTerms: [] } as any);
    expect(seeds).toEqual(['EV companion', 'Electric vehicle companion']);
  });
});

// ── fetchEvidenceCompetitors tests ───────────────────────────────────────────

describe('fetchEvidenceCompetitors', () => {
  it('fetchEvidenceCompetitors seeds from the marker and returns up to `limit` peers', async () => {
    const mockAppKittie = makeAppKittie([
      { appStoreId: '111', title: 'for-Electric vehicle companion' },
      { appStoreId: '222', title: 'App2' },
      { appStoreId: '333', title: 'App3' },
      { appStoreId: '444', title: 'App4' },
    ]);
    const mockStorage = makeStorage();
    const mockCompetitors = [
      makeCompetitor('111', 'for-Electric vehicle companion'),
      makeCompetitor('222', 'App2'),
      makeCompetitor('333', 'App3'),
    ];
    vi.mocked(batchLookupCompetitors).mockResolvedValue(mockCompetitors);

    const out = await fetchEvidenceCompetitors(
      { appId: '999', country: 'us' } as any,
      { category: 'Electric vehicle companion', niche: 'EV companion', functionTerms: [] },
      mockAppKittie,
      mockStorage,
      'test-tenant',
      3,
    );

    expect(out.length).toBeLessThanOrEqual(3);
  });
});
