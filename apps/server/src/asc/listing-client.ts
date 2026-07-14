import { signAscToken } from './auth';
import { getGateway } from '../cost/gateway';
import type { AscCredentials } from './credential-store';

const ASC_BASE = 'https://api.appstoreconnect.apple.com';

export type AscListingData = {
  keywords: string | null;
  promotionalText: string | null;
  localizationId: string | null;
  /** iPhone screenshot count from ASC, or null when not available. */
  iphoneScreenshotCount: number | null;
};

export async function fetchAscListingData(
  creds: AscCredentials,
  appId: string,
  bundleId?: string | null,
): Promise<AscListingData | null> {
  try {
    const token = signAscToken(creds.keyId, creds.issuerId, creds.privateKeyPem);
    const headers = { Authorization: `Bearer ${token}` };
    const gateway = getGateway();

    // The ASC API path /v1/apps/{id} uses an opaque resource ID that differs
    // from the iTunes trackId (Adam ID) for many apps. Resolve it via
    // filter[bundleId] when available — it's the only reliable cross-reference
    // Apple exposes. Fall back to using appId directly (works when the IDs
    // happen to match, e.g. older apps).
    let resolvedId: string = appId;
    if (bundleId) {
      const lookupUrl = `${ASC_BASE}/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=1`;
      const lookupRes = await gateway.fetch(lookupUrl, { kind: 'app', upstream: 'asc' }, { headers });
      if (!lookupRes.ok) return null;
      const lookupData = await lookupRes.json().catch(() => null) as
        { data?: { id: string }[] } | null;
      const resolved = lookupData?.data?.[0]?.id;
      if (!resolved) return null;
      resolvedId = resolved;
    }

    // Prefer the live version (READY_FOR_SALE) for keywords; fall back to the
    // most recent version in any state so that in-progress drafts surface too.
    const liveVersionsUrl =
      `${ASC_BASE}/v1/apps/${encodeURIComponent(resolvedId)}/appStoreVersions` +
      `?filter[appStoreState]=READY_FOR_SALE&filter[platform]=IOS&limit=1`;
    const liveRes = await gateway.fetch(liveVersionsUrl, { kind: 'app', upstream: 'asc' }, { headers });
    if (!liveRes.ok) return null;

    const liveData = await liveRes.json().catch(() => null) as
      { data?: { id: string }[] } | null;
    let versionId = liveData?.data?.[0]?.id;

    if (!versionId) {
      // No live version — try any iOS version (draft or pending review).
      const anyVersionsUrl =
        `${ASC_BASE}/v1/apps/${encodeURIComponent(resolvedId)}/appStoreVersions` +
        `?filter[platform]=IOS&limit=1`;
      const anyRes = await gateway.fetch(anyVersionsUrl, { kind: 'app', upstream: 'asc' }, { headers });
      if (!anyRes.ok) return null;
      const anyData = await anyRes.json().catch(() => null) as
        { data?: { id: string }[] } | null;
      versionId = anyData?.data?.[0]?.id;
    }

    if (!versionId) return null;

    const locUrl =
      `${ASC_BASE}/v1/appStoreVersions/${encodeURIComponent(versionId)}/appStoreVersionLocalizations`;
    const locRes = await gateway.fetch(locUrl, { kind: 'app', upstream: 'asc' }, { headers });
    if (!locRes.ok) return null;

    const locData = await locRes.json().catch(() => null) as {
      data?: { id: string; attributes: { locale: string; keywords: string | null; promotionalText: string | null } }[]
    } | null;
    if (!Array.isArray(locData?.data) || locData.data.length === 0) return null;

    const enUs = locData.data.find((d) => d.attributes.locale === 'en-US');
    const loc = enUs ?? locData.data[0]!;

    // Fetch iPhone screenshot count — best-effort, never blocks the main result.
    // Detects iPhone sets dynamically (APP_IPHONE_* prefix) and picks the one
    // with the largest numeric suffix (most modern size, e.g. 67 > 65 > 61).
    // This works for any current or future iPhone display type Apple may add.
    // iPad and other non-phone types are skipped so the count reflects iPhone
    // slots only (matching what the audit scores against a 10-slot max).
    let iphoneScreenshotCount: number | null = null;
    try {
      const setsUrl =
        `${ASC_BASE}/v1/appStoreVersionLocalizations/${encodeURIComponent(loc.id)}/appScreenshotSets` +
        `?include=appScreenshots&limit=20`;
      const setsRes = await gateway.fetch(setsUrl, { kind: 'app', upstream: 'asc' }, { headers });
      if (setsRes.ok) {
        const setsData = await setsRes.json().catch(() => null) as {
          data?: {
            attributes: { screenshotDisplayType: string };
            relationships?: { appScreenshots?: { data?: unknown[] } };
          }[];
        } | null;
        // Filter to iPhone sets, sort descending by the numeric size suffix so
        // the most modern (largest screen) set is preferred.
        const iphoneSets = (setsData?.data ?? [])
          .filter((s) => s.attributes.screenshotDisplayType.startsWith('APP_IPHONE_'))
          .sort((a, b) => {
            const n = (t: string) => parseInt(t.replace('APP_IPHONE_', ''), 10) || 0;
            return n(b.attributes.screenshotDisplayType) - n(a.attributes.screenshotDisplayType);
          });
        const best = iphoneSets[0];
        if (best) {
          iphoneScreenshotCount = best.relationships?.appScreenshots?.data?.length ?? 0;
        }
      }
    } catch {
      // Screenshot count is non-critical; don't abort the whole fetch.
    }

    return {
      keywords: loc.attributes.keywords ?? null,
      promotionalText: loc.attributes.promotionalText ?? null,
      localizationId: loc.id ?? null,
      iphoneScreenshotCount,
    };
  } catch {
    return null;
  }
}
