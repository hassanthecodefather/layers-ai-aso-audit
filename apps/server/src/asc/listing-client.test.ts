import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./auth', () => ({ signAscToken: () => 'fake.jwt.token' }));

const mockGatewayFetch = vi.fn();
vi.mock('../cost/gateway', () => ({
  getGateway: () => ({ fetch: mockGatewayFetch }),
}));

const CREDS = { keyId: 'K1', issuerId: 'I1', privateKeyPem: '---BEGIN EC PRIVATE KEY---\nfake\n---END EC PRIVATE KEY---' };

describe('fetchAscListingData', () => {
  beforeEach(() => { mockGatewayFetch.mockReset(); });

  it('returns keywords and promotionalText from en-US locale', async () => {
    const { fetchAscListingData } = await import('./listing-client');
    mockGatewayFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: 'ver-123', attributes: {} }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [
          { attributes: { locale: 'en-US', keywords: 'remote start,car key', promotionalText: 'Open your car from anywhere.' } },
        ],
      }), { status: 200 }));

    const result = await fetchAscListingData(CREDS, '12345');
    expect(result.keywords).toBe('remote start,car key');
    expect(result.promotionalText).toBe('Open your car from anywhere.');
  });

  it('falls back to first locale when en-US is absent', async () => {
    const { fetchAscListingData } = await import('./listing-client');
    mockGatewayFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: 'ver-123', attributes: {} }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [
          { attributes: { locale: 'de-DE', keywords: 'fernstart,autoschlüssel', promotionalText: null } },
        ],
      }), { status: 200 }));

    const result = await fetchAscListingData(CREDS, '12345');
    expect(result.keywords).toBe('fernstart,autoschlüssel');
    expect(result.promotionalText).toBeNull();
  });

  it('returns nulls when no READY_FOR_SALE version exists', async () => {
    const { fetchAscListingData } = await import('./listing-client');
    mockGatewayFetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const result = await fetchAscListingData(CREDS, '12345');
    expect(result).toEqual({ keywords: null, promotionalText: null });
  });

  it('returns nulls on non-2xx response', async () => {
    const { fetchAscListingData } = await import('./listing-client');
    mockGatewayFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    const result = await fetchAscListingData(CREDS, '12345');
    expect(result).toEqual({ keywords: null, promotionalText: null });
  });
});
