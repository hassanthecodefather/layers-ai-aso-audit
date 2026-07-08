import { SignJWT, jwtVerify } from 'jose';
import { randomBytes, createHash } from 'node:crypto';

const JWT_ALG = 'HS256';

export async function signAccessToken(userId: string, secret: string): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: JWT_ALG })
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(key);
}

export async function verifyAccessToken(token: string, secret: string): Promise<{ sub: string }> {
  const key = new TextEncoder().encode(secret);
  const { payload } = await jwtVerify(token, key);
  if (!payload.sub) throw new Error('Missing sub claim');
  return { sub: payload.sub };
}

export function generateRefreshToken(): string {
  return randomBytes(32).toString('hex');
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
