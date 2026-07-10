import { createSign } from 'node:crypto';

function resolveKey(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('-----BEGIN')) return trimmed;
  return Buffer.from(trimmed, 'base64').toString('utf8').trim();
}

export function signAscToken(
  keyId: string,
  issuerId: string,
  privateKeyPem: string,
): string {
  const key = resolveKey(privateKeyPem);
  const iat = Math.floor(Date.now() / 1000);

  const header = Buffer.from(
    JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }),
  ).toString('base64url');

  const payload = Buffer.from(
    JSON.stringify({ iss: issuerId, iat, exp: iat + 1200, aud: 'appstoreconnect-v1' }),
  ).toString('base64url');

  const unsigned = `${header}.${payload}`;
  const sign = createSign('SHA256');
  sign.update(unsigned);
  // ES256 requires IEEE P1363 (raw r||s), not DER
  const sig = sign.sign({ key, dsaEncoding: 'ieee-p1363' });
  return `${unsigned}.${sig.toString('base64url')}`;
}
