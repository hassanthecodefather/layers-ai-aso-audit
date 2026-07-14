import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./auth', () => ({ signAscToken: () => 'fake.jwt.token' }));

const mockGatewayFetch = vi.fn();
vi.mock('../cost/gateway', () => ({
  getGateway: () => ({ fetch: mockGatewayFetch }),
}));

const CREDS = { keyId: 'K1', issuerId: 'I1', privateKeyPem: '---BEGIN EC PRIVATE KEY---\nfake\n---END EC PRIVATE KEY---' };

const VERSION_RESP = (id: string) =>
  new Response(JSON.stringify({ data: [{ id, attributes: {} }] }), { status: 200 });

const LOCALIZATION_RESP = (keywords: string | null, promo: string | null, locId = 'loc-1') =>
  new Response(JSON.stringify({
    data: [{ id: locId, attributes: { locale: 'en-US', keywords, promotionalText: promo } }],
  }), { status: 200 });

const SCREENSHOT_SETS_RESP = (type: string, count: number) =>
  new Response(JSON.stringify({
    data: [{
      attributes: { screenshotDisplayType: type },
      relationships: { appScreenshots: { data: Array.from({ length: count }, (_, i) => ({ id: `ss-${i}` })) } },
    }],
  }), { status: 200 });

const EMPTY_SCREENSHOT_SETS = new Response(JSON.stringify({ data: [] }), { status: 200 });

describe('fetchAscListingData', () => {
  beforeEach(() => { mockGatewayFetch.mockReset(); });

  it('returns keywords and promotionalText from en-US locale', async () => {
    const { fetchAscListingData } = await import('./listing-client');
    mockGatewayFetch
      .mockResolvedValueOnce(VERSION_RESP('ver-123'))
      .mockResolvedValueOnce(LOCALIZATION_RESP('remote start,car key', 'Open your car from anywhere.', 'loc_en_us'))
      .mockResolvedValueOnce(EMPTY_SCREENSHOT_SETS);

    const result = await fetchAscListingData(CREDS, '12345');
    expect(result).toEqual({
      keywords: 'remote start,car key',
      promotionalText: 'Open your car from anywhere.',
      localizationId: 'loc_en_us',
      iphoneScreenshotCount: null,
    });
  });

  it('falls back to first locale when en-US is absent', async () => {
    const { fetchAscListingData } = await import('./listing-client');
    mockGatewayFetch
      .mockResolvedValueOnce(VERSION_RESP('ver-123'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: 'loc_de_de', attributes: { locale: 'de-DE', keywords: 'fernstart,autoschlüssel', promotionalText: null } }],
      }), { status: 200 }))
      .mockResolvedValueOnce(EMPTY_SCREENSHOT_SETS);

    const result = await fetchAscListingData(CREDS, '12345');
    expect(result).toEqual({
      keywords: 'fernstart,autoschlüssel',
      promotionalText: null,
      localizationId: 'loc_de_de',
      iphoneScreenshotCount: null,
    });
  });

  it('returns null on non-2xx response', async () => {
    const { fetchAscListingData } = await import('./listing-client');
    mockGatewayFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    const result = await fetchAscListingData(CREDS, '12345');
    expect(result).toBeNull();
  });

  it('falls back to any iOS version when no READY_FOR_SALE version exists', async () => {
    const { fetchAscListingData } = await import('./listing-client');
    mockGatewayFetch
      // READY_FOR_SALE → empty
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      // any iOS version → draft version
      .mockResolvedValueOnce(VERSION_RESP('draft-ver'))
      // localizations
      .mockResolvedValueOnce(LOCALIZATION_RESP(null, null, 'loc-draft'))
      // screenshot sets
      .mockResolvedValueOnce(EMPTY_SCREENSHOT_SETS);

    const result = await fetchAscListingData(CREDS, '12345');
    expect(result).toEqual({ keywords: null, promotionalText: null, localizationId: 'loc-draft', iphoneScreenshotCount: null });
  });

  it('returns null when both READY_FOR_SALE and fallback version lookups return empty', async () => {
    const { fetchAscListingData } = await import('./listing-client');
    mockGatewayFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));

    const result = await fetchAscListingData(CREDS, '12345');
    expect(result).toBeNull();
  });

  it('uses bundleId to resolve ASC resource ID before fetching versions', async () => {
    const { fetchAscListingData } = await import('./listing-client');
    mockGatewayFetch
      // bundleId lookup → returns internal ASC ID
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'asc-internal-99' }] }), { status: 200 }))
      // READY_FOR_SALE versions for resolved ID
      .mockResolvedValueOnce(VERSION_RESP('ver-abc'))
      // localizations
      .mockResolvedValueOnce(LOCALIZATION_RESP('companion,grief', null, 'loc-abc'))
      // screenshot sets
      .mockResolvedValueOnce(EMPTY_SCREENSHOT_SETS);

    const result = await fetchAscListingData(CREDS, '12345', 'com.example.app');
    expect(result).toEqual({ keywords: 'companion,grief', promotionalText: null, localizationId: 'loc-abc', iphoneScreenshotCount: null });

    // First call must be the bundleId filter lookup
    const firstCall = mockGatewayFetch.mock.calls[0][0] as string;
    expect(firstCall).toContain('filter[bundleId]=com.example.app');
    // Subsequent calls must use the resolved ID, not the original appId
    const secondCall = mockGatewayFetch.mock.calls[1][0] as string;
    expect(secondCall).toContain('asc-internal-99');
    expect(secondCall).not.toContain('12345');
  });

  it('returns null when bundleId lookup HTTP fails', async () => {
    const { fetchAscListingData } = await import('./listing-client');
    mockGatewayFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

    const result = await fetchAscListingData(CREDS, '12345', 'com.example.app');
    expect(result).toBeNull();
  });

  it('returns null when bundleId lookup returns no app', async () => {
    const { fetchAscListingData } = await import('./listing-client');
    mockGatewayFetch
      // bundleId lookup → empty → falls back to raw appId
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      // READY_FOR_SALE with raw appId → empty
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      // any iOS version → empty
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));

    const result = await fetchAscListingData(CREDS, '12345', 'com.example.app');
    expect(result).toBeNull();
  });

  it('returns iphoneScreenshotCount from APP_IPHONE_67 screenshot set', async () => {
    const { fetchAscListingData } = await import('./listing-client');
    mockGatewayFetch
      .mockResolvedValueOnce(VERSION_RESP('ver-123'))
      .mockResolvedValueOnce(LOCALIZATION_RESP('reader,drama', null, 'loc-en'))
      .mockResolvedValueOnce(SCREENSHOT_SETS_RESP('APP_IPHONE_67', 7));

    const result = await fetchAscListingData(CREDS, '12345');
    expect(result?.iphoneScreenshotCount).toBe(7);
  });

  it('prefers APP_IPHONE_67 over APP_IPHONE_65 for screenshot count', async () => {
    const { fetchAscListingData } = await import('./listing-client');
    mockGatewayFetch
      .mockResolvedValueOnce(VERSION_RESP('ver-123'))
      .mockResolvedValueOnce(LOCALIZATION_RESP('reader,drama', null, 'loc-en'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [
          {
            attributes: { screenshotDisplayType: 'APP_IPHONE_65' },
            relationships: { appScreenshots: { data: [{ id: 'ss-1' }, { id: 'ss-2' }, { id: 'ss-3' }] } },
          },
          {
            attributes: { screenshotDisplayType: 'APP_IPHONE_67' },
            relationships: { appScreenshots: { data: [{ id: 'ss-a' }, { id: 'ss-b' }, { id: 'ss-c' }, { id: 'ss-d' }, { id: 'ss-e' }, { id: 'ss-f' }, { id: 'ss-g' }] } },
          },
        ],
      }), { status: 200 }));

    const result = await fetchAscListingData(CREDS, '12345');
    expect(result?.iphoneScreenshotCount).toBe(7);
  });

  it('returns iphoneScreenshotCount null when screenshot sets fetch fails', async () => {
    const { fetchAscListingData } = await import('./listing-client');
    mockGatewayFetch
      .mockResolvedValueOnce(VERSION_RESP('ver-123'))
      .mockResolvedValueOnce(LOCALIZATION_RESP('reader,drama', null, 'loc-en'))
      .mockResolvedValueOnce(new Response('Server Error', { status: 500 }));

    const result = await fetchAscListingData(CREDS, '12345');
    expect(result).not.toBeNull();
    expect(result?.iphoneScreenshotCount).toBeNull();
    expect(result?.keywords).toBe('reader,drama');
  });

  it('skips iPad screenshot sets and returns null when no iPhone set exists', async () => {
    const { fetchAscListingData } = await import('./listing-client');
    mockGatewayFetch
      .mockResolvedValueOnce(VERSION_RESP('ver-123'))
      .mockResolvedValueOnce(LOCALIZATION_RESP('reader,drama', null, 'loc-en'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{
          attributes: { screenshotDisplayType: 'APP_IPAD_PRO_3GEN_129' },
          relationships: { appScreenshots: { data: [{ id: 'ss-1' }] } },
        }],
      }), { status: 200 }));

    const result = await fetchAscListingData(CREDS, '12345');
    expect(result?.iphoneScreenshotCount).toBeNull();
  });
});
