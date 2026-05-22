import { ok, err, type Result } from './result';

/** A resolved reference to a single App Store listing. */
export interface AppRef {
  readonly appId: string;
  readonly country: string;
}

const APP_ID = /id(\d{3,})/i;
const STOREFRONT = /(?:apps|itunes)\.apple\.com\/([a-z]{2})(?:\/|$)/i;
const BARE_ID = /^\d{6,}$/;

/**
 * Parse anything a user might paste into the chat into an `{ appId, country }`.
 *
 * Accepts the canonical share URL
 * (`https://apps.apple.com/us/app/spotify.../id324684580`), the short form
 * (`apps.apple.com/app/id324684580`), legacy `itunes.apple.com` links, and a
 * bare numeric App ID. Country defaults to `us` when the URL omits a
 * storefront — Apple serves the US listing for storefront-less links.
 */
export function parseAppStoreUrl(input: string): Result<AppRef> {
  const text = input.trim();
  if (!text) return err('Paste an Apple App Store URL to get started.');

  if (BARE_ID.test(text)) {
    return ok({ appId: text, country: 'us' });
  }

  if (!/(?:apps|itunes)\.apple\.com/i.test(text)) {
    return err(
      "That doesn't look like an Apple App Store link. Paste something like " +
        'https://apps.apple.com/us/app/spotify/id324684580',
    );
  }

  const id = APP_ID.exec(text)?.[1];
  if (!id) {
    return err("Couldn't find an app ID (the `id000000000` part) in that URL.");
  }

  const country = (STOREFRONT.exec(text)?.[1] ?? 'us').toLowerCase();
  return ok({ appId: id, country });
}

/** Canonical listing URL for a given app — used in the audit output. */
export function appStoreUrl(ref: AppRef): string {
  return `https://apps.apple.com/${ref.country}/app/id${ref.appId}`;
}
