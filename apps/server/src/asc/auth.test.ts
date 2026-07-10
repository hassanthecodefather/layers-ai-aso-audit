import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { signAscToken } from './auth';

function testPem(): { pem: string; b64: string } {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  return { pem, b64: Buffer.from(pem).toString('base64') };
}

describe('signAscToken', () => {
  it('produces a 3-part JWT', () => {
    const { pem } = testPem();
    const token = signAscToken('KID1', 'ISS1', pem);
    expect(token.split('.')).toHaveLength(3);
  });

  it('encodes correct header claims', () => {
    const { pem } = testPem();
    const [h] = signAscToken('MY_KEY', 'MY_ISSUER', pem).split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    expect(header).toEqual({ alg: 'ES256', kid: 'MY_KEY', typ: 'JWT' });
  });

  it('encodes correct payload claims', () => {
    const { pem } = testPem();
    const [, p] = signAscToken('k', 'iss42', pem).split('.');
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(payload.iss).toBe('iss42');
    expect(payload.aud).toBe('appstoreconnect-v1');
    expect(payload.exp - payload.iat).toBe(1200);
  });

  it('accepts base64-encoded key and produces a valid JWT', () => {
    const { pem } = testPem();
    const b64 = Buffer.from(pem).toString('base64');
    const token = signAscToken('k', 'i', b64);
    expect(token.split('.')).toHaveLength(3);
  });
});
