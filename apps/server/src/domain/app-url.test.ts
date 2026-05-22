import { describe, it, expect } from 'vitest';
import { parseAppStoreUrl, appStoreUrl } from './app-url';

describe('parseAppStoreUrl', () => {
  it('parses a canonical share URL with slug and storefront', () => {
    const result = parseAppStoreUrl(
      'https://apps.apple.com/us/app/spotify-music-and-podcasts/id324684580',
    );
    expect(result).toEqual({
      ok: true,
      value: { appId: '324684580', country: 'us' },
    });
  });

  it('extracts a non-US storefront', () => {
    const result = parseAppStoreUrl('https://apps.apple.com/gb/app/id835599320');
    expect(result.ok && result.value.country).toBe('gb');
  });

  it('handles the short URL form without a country, defaulting to us', () => {
    const result = parseAppStoreUrl('https://apps.apple.com/app/id324684580');
    expect(result).toEqual({
      ok: true,
      value: { appId: '324684580', country: 'us' },
    });
  });

  it('accepts a bare numeric app ID', () => {
    const result = parseAppStoreUrl('324684580');
    expect(result).toEqual({
      ok: true,
      value: { appId: '324684580', country: 'us' },
    });
  });

  it('accepts legacy itunes.apple.com links', () => {
    const result = parseAppStoreUrl(
      'https://itunes.apple.com/us/app/foo/id123456789',
    );
    expect(result.ok && result.value.appId).toBe('123456789');
  });

  it('tolerates surrounding whitespace and query strings', () => {
    const result = parseAppStoreUrl(
      '  https://apps.apple.com/de/app/x/id55512345?l=en  ',
    );
    expect(result).toEqual({
      ok: true,
      value: { appId: '55512345', country: 'de' },
    });
  });

  it('rejects a non-App-Store URL', () => {
    const result = parseAppStoreUrl('https://example.com/app/id123456789');
    expect(result.ok).toBe(false);
  });

  it('rejects an App Store URL with no app ID', () => {
    const result = parseAppStoreUrl('https://apps.apple.com/us/app/spotify');
    expect(result.ok).toBe(false);
  });

  it('rejects empty input', () => {
    expect(parseAppStoreUrl('   ').ok).toBe(false);
  });
});

describe('appStoreUrl', () => {
  it('builds a canonical listing URL', () => {
    expect(appStoreUrl({ appId: '324684580', country: 'us' })).toBe(
      'https://apps.apple.com/us/app/id324684580',
    );
  });
});
