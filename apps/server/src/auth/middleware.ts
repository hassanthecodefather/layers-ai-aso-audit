import { verifyAccessToken } from './token';

/** Minimal interface we need from the Hono context — avoids generic-variance issues. */
interface AuthContext {
  req: { header(name: string): string | undefined };
}

/**
 * Extract and verify the Bearer token from the Authorization header.
 * Returns the userId (tenantId) on success, or null if the header is missing
 * or the token is invalid/expired.
 *
 * Usage in route handlers:
 *   const tenantId = await getAuthenticatedTenantId(c);
 *   if (!tenantId) return c.json({ error: 'Unauthorized' }, 401);
 */
export async function getAuthenticatedTenantId(c: AuthContext): Promise<string | null> {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  if (!token) return null;
  const secret = process.env.ASO_JWT_SECRET?.trim() ?? '';
  if (!secret) return null;
  try {
    const { sub } = await verifyAccessToken(token, secret);
    return sub;
  } catch {
    return null;
  }
}
