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
    const res = await this.#db.execute({
      sql: `SELECT id, user_id, token_hash, expires_at, created_at, revoked_at
            FROM aso_refresh_tokens
            WHERE token_hash = ? LIMIT 1`,
      args: [tokenHash],
    });
    const row = res.rows[0];
    if (!row) return null;

    const userId = row['user_id'] as string;

    // Already revoked — full family revocation (reuse detection)
    if (row['revoked_at'] !== null) {
      await this.revokeAllUserTokens(userId);
      return null;
    }

    // Expired
    if ((row['expires_at'] as string) < new Date().toISOString()) {
      return null;
    }

    // Mark revoked
    await this.#db.execute({
      sql: `UPDATE aso_refresh_tokens SET revoked_at = ? WHERE id = ?`,
      args: [new Date().toISOString(), row['id'] as string],
    });

    return {
      id: row['id'] as string,
      userId,
      tokenHash: row['token_hash'] as string,
      expiresAt: row['expires_at'] as string,
      createdAt: row['created_at'] as string,
    };
  }

  async revokeAllUserTokens(userId: string): Promise<void> {
    await this.#db.execute({
      sql: `UPDATE aso_refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`,
      args: [new Date().toISOString(), userId],
    });
  }
}
