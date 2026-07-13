import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGatewayFetch = vi.fn();
vi.mock('../cost/gateway', () => ({
  getGateway: () => ({ fetch: mockGatewayFetch }),
}));

vi.mock('./auth', () => ({
  signAscToken: vi.fn().mockReturnValue('mock-jwt-token'),
}));

describe('pushListingUpdate', () => {
  const creds = { keyId: 'K1', issuerId: 'I1', privateKeyPem: '-----BEGIN...' };

  beforeEach(() => {
    vi.resetModules();
    mockGatewayFetch.mockReset();
  });

  it('returns ok:true on 200 response', async () => {
    mockGatewayFetch.mockResolvedValue(new Response('{}', { status: 200 }));
    const { pushListingUpdate } = await import('./listing-writer');
    const result = await pushListingUpdate(creds, 'loc_123', { title: 'New Title' });
    expect(result).toEqual({ ok: true });
  });

  it('sends only the provided fields as attributes', async () => {
    mockGatewayFetch.mockResolvedValue(new Response('{}', { status: 200 }));
    const { pushListingUpdate } = await import('./listing-writer');
    await pushListingUpdate(creds, 'loc_123', { title: 'T', keywords: 'a,b,c' });
    const call = mockGatewayFetch.mock.calls[0];
    const body = JSON.parse(call[2]?.body as string);
    expect(body.data.attributes).toEqual({ name: 'T', keywords: 'a,b,c' });
    expect(body.data.attributes.description).toBeUndefined();
  });

  it('maps title→name and releaseNotes→whatsNew', async () => {
    mockGatewayFetch.mockResolvedValue(new Response('{}', { status: 200 }));
    const { pushListingUpdate } = await import('./listing-writer');
    await pushListingUpdate(creds, 'loc_123', { title: 'T', releaseNotes: 'Bug fixes' });
    const call = mockGatewayFetch.mock.calls[0];
    const body = JSON.parse(call[2]?.body as string);
    expect(body.data.attributes.name).toBe('T');
    expect(body.data.attributes.whatsNew).toBe('Bug fixes');
    expect(body.data.attributes.title).toBeUndefined();
    expect(body.data.attributes.releaseNotes).toBeUndefined();
  });

  it('returns ok:false on non-2xx response', async () => {
    mockGatewayFetch.mockResolvedValue(new Response('Forbidden', { status: 403 }));
    const { pushListingUpdate } = await import('./listing-writer');
    const result = await pushListingUpdate(creds, 'loc_123', { title: 'T' });
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain('403');
  });

  it('returns ok:false when fetch throws', async () => {
    mockGatewayFetch.mockRejectedValue(new Error('network error'));
    const { pushListingUpdate } = await import('./listing-writer');
    const result = await pushListingUpdate(creds, 'loc_123', { title: 'T' });
    expect(result.ok).toBe(false);
  });
});
