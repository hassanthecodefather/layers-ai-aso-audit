import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from './password';
import { signAccessToken, verifyAccessToken, generateRefreshToken, hashRefreshToken } from './token';
import { openDb, runMigrations } from '../memory/migrate';
import { UserStore } from './user-store';
import { getAuthenticatedTenantId } from './middleware';

describe('password', () => {
  it('hashPassword returns a bcrypt hash', async () => {
    const hash = await hashPassword('correct-horse');
    expect(hash).toMatch(/^\$2[aby]\$/);
  });

  it('verifyPassword returns true for correct password', async () => {
    const hash = await hashPassword('correct-horse');
    expect(await verifyPassword('correct-horse', hash)).toBe(true);
  });

  it('verifyPassword returns false for wrong password', async () => {
    const hash = await hashPassword('correct-horse');
    expect(await verifyPassword('wrong-password', hash)).toBe(false);
  });
});

describe('token', () => {
  const SECRET = 'test-secret-that-is-32-chars-long!!';

  it('signAccessToken + verifyAccessToken round-trip', async () => {
    const token = await signAccessToken('user-123', SECRET);
    const payload = await verifyAccessToken(token, SECRET);
    expect(payload.sub).toBe('user-123');
  });

  it('verifyAccessToken throws on tampered token', async () => {
    const token = await signAccessToken('user-123', SECRET);
    const tampered = token.slice(0, -5) + 'ZZZZZ';
    await expect(verifyAccessToken(tampered, SECRET)).rejects.toThrow();
  });

  it('generateRefreshToken returns 64-char hex string', () => {
    const token = generateRefreshToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashRefreshToken returns deterministic sha256 hex', () => {
    const token = generateRefreshToken();
    const h1 = hashRefreshToken(token);
    const h2 = hashRefreshToken(token);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('UserStore', () => {
  async function makeStore() {
    const db = openDb(':memory:');
    await runMigrations(db);
    return { store: new UserStore(db), db };
  }

  it('createUser and findUserByEmail round-trip', async () => {
    const { store, db } = await makeStore();
    await store.createUser({ id: 'u1', email: 'a@b.com', passwordHash: 'hash', createdAt: '2026-01-01T00:00:00Z' });
    const user = await store.findUserByEmail('a@b.com');
    expect(user?.id).toBe('u1');
    expect(user?.email).toBe('a@b.com');
    db.close();
  });

  it('findUserByEmail returns null for unknown email', async () => {
    const { store, db } = await makeStore();
    const user = await store.findUserByEmail('no@no.com');
    expect(user).toBeNull();
    db.close();
  });

  it('createRefreshToken and findAndConsumeRefreshToken rotate correctly', async () => {
    const { store, db } = await makeStore();
    await store.createUser({ id: 'u1', email: 'a@b.com', passwordHash: 'h', createdAt: '2026-01-01T00:00:00Z' });
    const rawToken = generateRefreshToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await store.createRefreshToken({ id: 'rt1', userId: 'u1', tokenHash: hashRefreshToken(rawToken), expiresAt, createdAt: '2026-01-01T00:00:00Z' });

    // First use: valid
    const result = await store.findAndConsumeRefreshToken(hashRefreshToken(rawToken));
    expect(result?.userId).toBe('u1');

    // Second use: revoked → returns null
    const result2 = await store.findAndConsumeRefreshToken(hashRefreshToken(rawToken));
    expect(result2).toBeNull();
    db.close();
  });

  it('revokeAllUserTokens removes all tokens for user', async () => {
    const { store, db } = await makeStore();
    await store.createUser({ id: 'u1', email: 'a@b.com', passwordHash: 'h', createdAt: '2026-01-01T00:00:00Z' });
    const t1 = generateRefreshToken();
    const t2 = generateRefreshToken();
    const exp = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await store.createRefreshToken({ id: 'rt1', userId: 'u1', tokenHash: hashRefreshToken(t1), expiresAt: exp, createdAt: '2026-01-01T00:00:00Z' });
    await store.createRefreshToken({ id: 'rt2', userId: 'u1', tokenHash: hashRefreshToken(t2), expiresAt: exp, createdAt: '2026-01-01T00:00:00Z' });
    await store.revokeAllUserTokens('u1');
    expect(await store.findAndConsumeRefreshToken(hashRefreshToken(t1))).toBeNull();
    expect(await store.findAndConsumeRefreshToken(hashRefreshToken(t2))).toBeNull();
    db.close();
  });
});

describe('getAuthenticatedTenantId', () => {
  const SECRET = 'test-secret-that-is-32-chars-long!!';

  it('returns tenantId for valid Bearer token', async () => {
    process.env.ASO_JWT_SECRET = SECRET;
    const token = await signAccessToken('user-abc', SECRET);
    const mockContext = {
      req: { header: (name: string) => name === 'Authorization' ? `Bearer ${token}` : undefined },
    } as any;
    const result = await getAuthenticatedTenantId(mockContext);
    expect(result).toBe('user-abc');
  });

  it('returns null for missing Authorization header', async () => {
    process.env.ASO_JWT_SECRET = SECRET;
    const mockContext = {
      req: { header: () => undefined },
    } as any;
    expect(await getAuthenticatedTenantId(mockContext)).toBeNull();
  });

  it('returns null for invalid token', async () => {
    process.env.ASO_JWT_SECRET = SECRET;
    const mockContext = {
      req: { header: () => 'Bearer not.a.valid.token' },
    } as any;
    expect(await getAuthenticatedTenantId(mockContext)).toBeNull();
  });
});
