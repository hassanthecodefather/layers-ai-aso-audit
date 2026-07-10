import { registerApiRoute } from '@mastra/core/server';
import { randomUUID } from 'node:crypto';
import { hashPassword, verifyPassword } from './password';
import { signAccessToken, generateRefreshToken, hashRefreshToken } from './token';
import { getUserStore } from '../memory';

const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const REFRESH_COOKIE = 'aso_refresh';

function jwtSecret(): string {
  const s = process.env.ASO_JWT_SECRET?.trim() ?? '';
  if (!s) throw new Error('ASO_JWT_SECRET is not set');
  if (s.length < 32) throw new Error('ASO_JWT_SECRET must be at least 32 characters');
  return s;
}

function isValidEmail(email: string): boolean {
  const atIdx = email.indexOf('@');
  if (atIdx < 1) return false;
  const afterAt = email.slice(atIdx + 1);
  return afterAt.includes('.');
}

const SECURE_COOKIE = process.env.NODE_ENV === 'production';

function setRefreshCookie(c: any, token: string): void {
  const secureFlag = SECURE_COOKIE ? '; Secure' : '';
  c.header(
    'Set-Cookie',
    `${REFRESH_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/auth; Max-Age=604800${secureFlag}`,
  );
}

function clearRefreshCookie(c: any): void {
  c.header(
    'Set-Cookie',
    `${REFRESH_COOKIE}=; HttpOnly; SameSite=Strict; Path=/auth; Max-Age=0`,
  );
}

export const authRoutes = [
  registerApiRoute('/auth/signup', {
    method: 'POST',
    handler: async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const email = typeof body.email === 'string' ? body.email.toLowerCase().trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';

      if (!isValidEmail(email)) return c.json({ error: 'Invalid email address.' }, 400);
      if (password.length < 8) return c.json({ error: 'Password must be at least 8 characters.' }, 400);

      const store = await getUserStore();
      const existing = await store.findUserByEmail(email);
      if (existing) return c.json({ error: 'Email already registered.' }, 409);

      const userId = randomUUID();
      const passwordHash = await hashPassword(password);
      const now = new Date().toISOString();
      try {
        await store.createUser({ id: userId, email, passwordHash, createdAt: now });
      } catch (e) {
        // Concurrent signup race: both requests passed findUserByEmail before either
        // INSERT committed. Map the UNIQUE constraint violation to 409.
        // SQLite/LibSQL: message contains 'UNIQUE constraint failed'
        // LibSQL HTTP mode: message contains 'unique constraint'
        // Postgres (postgres.js): error.code === '23505' (unique_violation)
        const msg = e instanceof Error ? e.message : String(e);
        const code = (e as { code?: string })?.code;
        if (
          code === '23505' ||
          msg.includes('UNIQUE constraint failed') ||
          msg.includes('unique constraint')
        ) {
          return c.json({ error: 'Email already registered.' }, 409);
        }
        throw e;
      }

      const accessToken = await signAccessToken(userId, jwtSecret());
      const rawRefresh = generateRefreshToken();
      const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString();
      await store.createRefreshToken({
        id: randomUUID(),
        userId,
        tokenHash: hashRefreshToken(rawRefresh),
        expiresAt,
        createdAt: now,
      });

      setRefreshCookie(c, rawRefresh);
      return c.json({ userId, accessToken }, 201);
    },
  }),

  registerApiRoute('/auth/login', {
    method: 'POST',
    handler: async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const email = typeof body.email === 'string' ? body.email.toLowerCase().trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';

      if (!email || !password) return c.json({ error: 'Email and password are required.' }, 400);
      const INVALID = 'Invalid email or password.';

      const store = await getUserStore();
      const user = await store.findUserByEmail(email);
      if (!user) {
        await verifyPassword(password, '$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
        return c.json({ error: INVALID }, 401);
      }

      const valid = await verifyPassword(password, user.passwordHash);
      if (!valid) return c.json({ error: INVALID }, 401);

      const accessToken = await signAccessToken(user.id, jwtSecret());
      const rawRefresh = generateRefreshToken();
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString();
      await store.createRefreshToken({
        id: randomUUID(),
        userId: user.id,
        tokenHash: hashRefreshToken(rawRefresh),
        expiresAt,
        createdAt: now,
      });

      setRefreshCookie(c, rawRefresh);
      return c.json({ userId: user.id, accessToken });
    },
  }),

  registerApiRoute('/auth/refresh', {
    method: 'POST',
    handler: async (c) => {
      const cookieHeader = c.req.header('Cookie') ?? '';
      const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${REFRESH_COOKIE}=([^;]+)`));
      const rawRefresh = match?.[1];
      if (!rawRefresh) return c.json({ error: 'No refresh token.' }, 401);

      const store = await getUserStore();
      const tokenRow = await store.findAndConsumeRefreshToken(hashRefreshToken(rawRefresh));
      if (!tokenRow) return c.json({ error: 'Invalid or expired refresh token.' }, 401);

      const accessToken = await signAccessToken(tokenRow.userId, jwtSecret());
      const newRawRefresh = generateRefreshToken();
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString();
      await store.createRefreshToken({
        id: randomUUID(),
        userId: tokenRow.userId,
        tokenHash: hashRefreshToken(newRawRefresh),
        expiresAt,
        createdAt: now,
      });

      setRefreshCookie(c, newRawRefresh);
      return c.json({ accessToken });
    },
  }),

  registerApiRoute('/auth/logout', {
    method: 'POST',
    handler: async (c) => {
      const cookieHeader = c.req.header('Cookie') ?? '';
      const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${REFRESH_COOKIE}=([^;]+)`));
      const rawRefresh = match?.[1];

      if (rawRefresh) {
        const store = await getUserStore();
        await store.findAndConsumeRefreshToken(hashRefreshToken(rawRefresh));
      }

      clearRefreshCookie(c);
      return c.json({});
    },
  }),
];
