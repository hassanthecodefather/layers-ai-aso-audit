import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type postgres from 'postgres';
import { ok, err } from '../domain/result';
import type { Result } from '../domain/result';
import type { AscError } from './types';

export interface AscCredentials {
  keyId: string;
  issuerId: string;
  privateKeyPem: string;
}

function encryptionKey(): Buffer {
  const raw = process.env.ASC_ENCRYPTION_KEY?.trim() ?? '';
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('ASC_ENCRYPTION_KEY must be a 32-byte base64 string');
  return buf;
}

function encrypt(plaintext: string): string {
  const key = encryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

function decrypt(stored: string): string {
  const parts = stored.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted credential format');
  const [ivB64, tagB64, ctB64] = parts;
  const key = encryptionKey();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64!, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64!, 'base64'));
  return decipher.update(Buffer.from(ctB64!, 'base64')) + decipher.final('utf8');
}

function normalizePem(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('-----BEGIN')) return trimmed;
  return Buffer.from(trimmed, 'base64').toString('utf8').trim();
}

export async function saveCredentials(
  sql: postgres.Sql,
  tenantId: string,
  creds: AscCredentials,
): Promise<Result<void, AscError>> {
  try {
    const pem = normalizePem(creds.privateKeyPem);
    const enc = encrypt(pem);
    const now = new Date().toISOString();
    await sql`
      INSERT INTO aso_asc_credentials (tenant_id, key_id, issuer_id, private_key_enc, created_at, updated_at)
      VALUES (${tenantId}, ${creds.keyId}, ${creds.issuerId}, ${enc}, ${now}, ${now})
      ON CONFLICT (tenant_id) DO UPDATE
        SET key_id         = EXCLUDED.key_id,
            issuer_id      = EXCLUDED.issuer_id,
            private_key_enc = EXCLUDED.private_key_enc,
            updated_at     = EXCLUDED.updated_at
    `;
    return ok(undefined);
  } catch (e) {
    return err({ kind: 'api_error', status: 500, detail: String(e) });
  }
}

export async function loadCredentials(
  sql: postgres.Sql,
  tenantId: string,
): Promise<Result<AscCredentials | null, AscError>> {
  try {
    const rows = await sql<{ key_id: string; issuer_id: string; private_key_enc: string }[]>`
      SELECT key_id, issuer_id, private_key_enc
      FROM aso_asc_credentials
      WHERE tenant_id = ${tenantId}
    `;
    if (rows.length === 0) return ok(null);
    const row = rows[0]!;
    return ok({
      keyId: row.key_id,
      issuerId: row.issuer_id,
      privateKeyPem: decrypt(row.private_key_enc),
    });
  } catch (e) {
    return err({ kind: 'api_error', status: 500, detail: String(e) });
  }
}

export async function deleteCredentials(
  sql: postgres.Sql,
  tenantId: string,
): Promise<Result<void, AscError>> {
  try {
    await sql`DELETE FROM aso_asc_credentials WHERE tenant_id = ${tenantId}`;
    return ok(undefined);
  } catch (e) {
    return err({ kind: 'api_error', status: 500, detail: String(e) });
  }
}
