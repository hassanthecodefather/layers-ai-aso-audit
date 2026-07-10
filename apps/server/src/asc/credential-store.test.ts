import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import { runPgMigrations } from '../memory/pg-migrate';
import { saveCredentials, loadCredentials, deleteCredentials } from './credential-store';

const TEST_URL =
  process.env.DATABASE_TEST_URL ?? 'postgresql://aso:aso@localhost:5432/aso_audit_test';

describe('credential-store', () => {
  let sql: postgres.Sql;
  const schema = `asc_cred_test_${Date.now()}`;

  beforeAll(async () => {
    sql = postgres(TEST_URL, { connection: { search_path: schema } });
    await sql`CREATE SCHEMA IF NOT EXISTS ${sql(schema)}`;
    await runPgMigrations(sql);
    process.env.ASC_ENCRYPTION_KEY = Buffer.alloc(32, 'k').toString('base64');
  });

  afterAll(async () => {
    await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`;
    await sql.end();
  });

  it('saves and loads credentials with round-trip encryption', async () => {
    const creds = { keyId: 'K1', issuerId: 'I1', privateKeyPem: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----' };
    const saved = await saveCredentials(sql, 'tenant-1', creds);
    expect(saved.ok).toBe(true);

    const loaded = await loadCredentials(sql, 'tenant-1');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value).toEqual(creds);
  });

  it('returns null for a tenant with no credentials', async () => {
    const result = await loadCredentials(sql, 'tenant-unknown');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it('upserts on second save (same tenant)', async () => {
    await saveCredentials(sql, 'tenant-upsert', { keyId: 'K1', issuerId: 'I1', privateKeyPem: '-----BEGIN PRIVATE KEY-----\nv1\n-----END PRIVATE KEY-----' });
    await saveCredentials(sql, 'tenant-upsert', { keyId: 'K2', issuerId: 'I2', privateKeyPem: '-----BEGIN PRIVATE KEY-----\nv2\n-----END PRIVATE KEY-----' });

    const loaded = await loadCredentials(sql, 'tenant-upsert');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value?.keyId).toBe('K2');
  });

  it('normalizes base64-encoded PEM key on save', async () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nbase64test\n-----END PRIVATE KEY-----';
    const b64 = Buffer.from(pem).toString('base64');
    await saveCredentials(sql, 'tenant-b64', { keyId: 'K', issuerId: 'I', privateKeyPem: b64 });

    const loaded = await loadCredentials(sql, 'tenant-b64');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value?.privateKeyPem).toBe(pem);
  });

  it('deletes credentials', async () => {
    await saveCredentials(sql, 'tenant-del', { keyId: 'K', issuerId: 'I', privateKeyPem: '-----BEGIN PRIVATE KEY-----\n\n-----END PRIVATE KEY-----' });
    await deleteCredentials(sql, 'tenant-del');
    const loaded = await loadCredentials(sql, 'tenant-del');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value).toBeNull();
  });
});
