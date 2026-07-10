import { signAscToken } from './auth';
import { getGateway } from '../cost/gateway';
import type { AscCredentials } from './credential-store';

const ASC_BASE = 'https://api.appstoreconnect.apple.com';

export type AscListingData = {
  keywords: string | null;
  promotionalText: string | null;
};

const NULL_RESULT: AscListingData = { keywords: null, promotionalText: null };

export async function fetchAscListingData(
  creds: AscCredentials,
  appId: string,
): Promise<AscListingData> {
  try {
    const token = signAscToken(creds.keyId, creds.issuerId, creds.privateKeyPem);
    const headers = { Authorization: `Bearer ${token}` };
    const gateway = getGateway();

    const versionsUrl =
      `${ASC_BASE}/v1/apps/${encodeURIComponent(appId)}/appStoreVersions` +
      `?filter[appStoreState]=READY_FOR_SALE&filter[platform]=IOS&limit=1`;
    const versionsRes = await gateway.fetch(versionsUrl, { kind: 'app', upstream: 'asc' }, { headers });
    if (!versionsRes.ok) return NULL_RESULT;

    const versionsData = await versionsRes.json().catch(() => null) as
      { data?: { id: string }[] } | null;
    const versionId = versionsData?.data?.[0]?.id;
    if (!versionId) return NULL_RESULT;

    const locUrl =
      `${ASC_BASE}/v1/appStoreVersions/${encodeURIComponent(versionId)}/appStoreVersionLocalizations`;
    const locRes = await gateway.fetch(locUrl, { kind: 'app', upstream: 'asc' }, { headers });
    if (!locRes.ok) return NULL_RESULT;

    const locData = await locRes.json().catch(() => null) as {
      data?: { attributes: { locale: string; keywords: string | null; promotionalText: string | null } }[]
    } | null;
    if (!Array.isArray(locData?.data) || locData.data.length === 0) return NULL_RESULT;

    const enUs = locData.data.find((d) => d.attributes.locale === 'en-US');
    const loc = enUs ?? locData.data[0]!;

    return {
      keywords: loc.attributes.keywords ?? null,
      promotionalText: loc.attributes.promotionalText ?? null,
    };
  } catch {
    return NULL_RESULT;
  }
}
