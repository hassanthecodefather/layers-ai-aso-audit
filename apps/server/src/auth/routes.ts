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
  return s;
}

function isValidEmail(email: string): boolean {
  const atIdx = email.indexOf('@');
  if (atIdx < 1) return false;
  const afterAt = email.slice(atIdx + 1);
  return afterAt.includes('.');
}

function setRefreshCookie(c: any, token: string): void {
  const expires = new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toUTCString();
  c.header(
    'Set-Cookie',
    `${REFRESH_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/auth; Expires=${expires}`,
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
      await store.createUser({ id: userId, email, passwordHash, createdAt: now });

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
      return c.json({ userId, accessToken });
    },
  }),

  registerApiRoute('/auth/login', {
    method: 'POST',
    handler: async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const email = typeof body.email === 'string' ? body.email.toLowerCase().trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';

      const INVALID = 'Invalid email or password.';
      if (!email || !password) return c.json({ error: INVALID }, 401);

      const store = await getUserStore();
      const user = await store.findUserByEmail(email);
      if (!user) return c.json({ error: INVALID }, 401);

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
