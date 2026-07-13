import { getGateway } from '../cost/gateway';
import { signAscToken } from './auth';
import type { AscCredentials } from './credential-store';
import type { ProposedFields } from '../queue/listing-update-store';

const ASC_BASE = 'https://api.appstoreconnect.apple.com';

// ASC field name differs from our internal names for two fields:
//   title        → name
//   releaseNotes → whatsNew
function toAscAttributes(fields: ProposedFields): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (fields.title !== undefined) attrs.name = fields.title;
  if (fields.subtitle !== undefined) attrs.subtitle = fields.subtitle;
  if (fields.keywords !== undefined) attrs.keywords = fields.keywords;
  if (fields.description !== undefined) attrs.description = fields.description;
  if (fields.promotionalText !== undefined) attrs.promotionalText = fields.promotionalText;
  if (fields.releaseNotes !== undefined) attrs.whatsNew = fields.releaseNotes;
  return attrs;
}

export async function pushListingUpdate(
  creds: AscCredentials,
  localizationId: string,
  fields: ProposedFields,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const token = signAscToken(creds.keyId, creds.issuerId, creds.privateKeyPem);
    const url = `${ASC_BASE}/v1/appStoreVersionLocalizations/${encodeURIComponent(localizationId)}`;
    const body = JSON.stringify({
      data: {
        type: 'appStoreVersionLocalizations',
        id: localizationId,
        attributes: toAscAttributes(fields),
      },
    });
    const res = await getGateway().fetch(
      url,
      { kind: 'app', upstream: 'asc' },
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body,
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `ASC returned ${res.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
