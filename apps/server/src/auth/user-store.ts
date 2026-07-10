import type { Client } from '@libsql/client';

export interface UserRow {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
}

export interface RefreshTokenRow {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
}

export class UserStore {
  readonly #db: Client;

  constructor(db: Client) {
    this.#db = db;
  }

  async createUser(u: UserRow): Promise<void> {
    await this.#db.execute({
      sql: `INSERT INTO aso_users (id, email, password_hash, created_at) VALUES (?,?,?,?)`,
      args: [u.id, u.email, u.passwordHash, u.createdAt],
    });
  }

  async findUserByEmail(email: string): Promise<UserRow | null> {
    const res = await this.#db.execute({
      sql: `SELECT id, email, password_hash, created_at FROM aso_users WHERE email = ? LIMIT 1`,
      args: [email],
    });
    const row = res.rows[0];
    if (!row) return null;
    return {
      id: row['id'] as string,
      email: row['email'] as string,
      passwordHash: row['password_hash'] as string,
      createdAt: row['created_at'] as string,
    };
  }

  async createRefreshToken(t: RefreshTokenRow): Promise<void> {
    await this.#db.execute({
      sql: `INSERT INTO aso_refresh_tokens (id, user_id, token_hash, expires_at, created_at)
            VALUES (?,?,?,?,?)`,
      args: [t.id, t.userId, t.tokenHash, t.expiresAt, t.createdAt],
    });
  }

  /**
   * Look up a refresh token by its hash and atomically mark it revoked.
   * Returns the token row if valid and not yet revoked; null if missing,
   * revoked, or expired. If the token is already revoked (reuse detected),
   * also revokes all tokens for that user (family revocation).
   */
  async findAndConsumeRefreshToken(tokenHash: string): Promise<RefreshTokenRow | null> {
    // Single atomic UPDATE…RETURNING: only one concurrent caller can match
    // the WHERE revoked_at IS NULL condition — the second caller's UPDATE affects
    // 0 rows (compare-and-swap semantics, no multi-statement transaction needed).
    const now = new Date().toISOString();
    const res = await this.#db.execute({
      sql: `UPDATE aso_refresh_tokens
            SET revoked_at = ?
            WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?
            RETURNING id, user_id, token_hash, expires_at, created_at`,
      args: [now, tokenHash, now],
    });

    if (res.rows.length > 0) {
      const row = res.rows[0]!;
      return {
        id: row['id'] as string,
        userId: row['user_id'] as string,
        tokenHash: row['token_hash'] as string,
        expiresAt: row['expires_at'] as string,
        createdAt: row['created_at'] as string,
      };
    }

    // Zero rows updated: token is missing, expired, or already revoked.
    //
    // Distinguish genuine reuse (old rotated token replayed) from a concurrent
    // refresh (two tabs called /refresh simultaneously; one won the UPDATE, the
    // other sees 0 rows for a token that was just revoked moments ago).
    //
    // Grace window: if revoked_at is within the last REUSE_GRACE_MS we treat the
    // caller as the losing half of a concurrent pair — return null without family
    // revocation. Only tokens revoked before the window are real reuse attacks.
    const REUSE_GRACE_MS = 30_000;
    const graceCutoff = new Date(Date.now() - REUSE_GRACE_MS).toISOString();
    const check = await this.#db.execute({
      sql: `SELECT user_id FROM aso_refresh_tokens
            WHERE token_hash = ? AND revoked_at IS NOT NULL AND revoked_at < ? LIMIT 1`,
      args: [tokenHash, graceCutoff],
    });
    if (check.rows.length > 0) {
      await this.revokeAllUserTokens(check.rows[0]!['user_id'] as string);
    }

    return null;
  }

  async revokeAllUserTokens(userId: string): Promise<void> {
    await this.#db.execute({
      sql: `UPDATE aso_refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`,
      args: [new Date().toISOString(), userId],
    });
  }
}
