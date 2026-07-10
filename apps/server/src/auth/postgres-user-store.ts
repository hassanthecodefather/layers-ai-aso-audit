import type postgres from 'postgres';
import type { UserRow, RefreshTokenRow } from './user-store';

export class PostgresUserStore {
  readonly #sql: postgres.Sql;

  constructor(sql: postgres.Sql) {
    this.#sql = sql;
  }

  async createUser(u: UserRow): Promise<void> {
    await this.#sql`
      INSERT INTO aso_users (id, email, password_hash, created_at)
      VALUES (${u.id}, ${u.email}, ${u.passwordHash}, ${u.createdAt})
    `;
  }

  async findUserByEmail(email: string): Promise<UserRow | null> {
    const [row] = await this.#sql<UserRow[]>`
      SELECT id, email, password_hash AS "passwordHash", created_at AS "createdAt"
      FROM aso_users
      WHERE email = ${email}
      LIMIT 1
    `;
    return row ?? null;
  }

  async createRefreshToken(t: RefreshTokenRow): Promise<void> {
    await this.#sql`
      INSERT INTO aso_refresh_tokens (id, user_id, token_hash, expires_at, created_at)
      VALUES (${t.id}, ${t.userId}, ${t.tokenHash}, ${t.expiresAt}, ${t.createdAt})
    `;
  }

  async findAndConsumeRefreshToken(tokenHash: string): Promise<RefreshTokenRow | null> {
    const now = new Date().toISOString();
    const [row] = await this.#sql<RefreshTokenRow[]>`
      UPDATE aso_refresh_tokens
      SET revoked_at = ${now}
      WHERE token_hash = ${tokenHash}
        AND revoked_at IS NULL
        AND expires_at > ${now}
      RETURNING id, user_id AS "userId", token_hash AS "tokenHash",
                expires_at AS "expiresAt", created_at AS "createdAt"
    `;

    if (row) return row;

    const REUSE_GRACE_MS = 30_000;
    const graceCutoff = new Date(Date.now() - REUSE_GRACE_MS).toISOString();
    const [stale] = await this.#sql<[{ userId: string }?]>`
      SELECT user_id AS "userId"
      FROM aso_refresh_tokens
      WHERE token_hash = ${tokenHash}
        AND revoked_at IS NOT NULL
        AND revoked_at < ${graceCutoff}
      LIMIT 1
    `;
    if (stale) {
      await this.revokeAllUserTokens(stale.userId);
    }

    return null;
  }

  async revokeAllUserTokens(userId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.#sql`
      UPDATE aso_refresh_tokens
      SET revoked_at = ${now}
      WHERE user_id = ${userId} AND revoked_at IS NULL
    `;
  }
}
