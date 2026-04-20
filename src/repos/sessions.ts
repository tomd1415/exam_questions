import type { Pool } from 'pg';

export interface SessionRow {
  id: string;
  user_id: string;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  user_agent: string;
  ip_hash: string;
}

export class SessionRepo {
  constructor(private readonly db: Pool) {}

  async create(row: {
    id: string;
    userId: string;
    expiresAt: Date;
    userAgent: string;
    ipHash: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO sessions (id, user_id, expires_at, user_agent, ip_hash)
       VALUES ($1, $2, $3, $4, $5)`,
      [row.id, row.userId, row.expiresAt, row.userAgent, row.ipHash],
    );
  }

  async findValid(id: string): Promise<SessionRow | null> {
    const { rows } = await this.db.query<SessionRow>(
      `SELECT id, user_id::text, created_at, last_seen_at, expires_at, user_agent, ip_hash
         FROM sessions
        WHERE id = $1
          AND expires_at > now()`,
      [id],
    );
    return rows[0] ?? null;
  }

  async touch(id: string): Promise<void> {
    await this.db.query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [id]);
  }

  async destroy(id: string): Promise<void> {
    await this.db.query(`DELETE FROM sessions WHERE id = $1`, [id]);
  }

  /**
   * Deletes every session row for a given user. Used on pupil login so
   * that signing in on a new device silently kicks the old one — one
   * pupil, one active session. Returns the number of rows removed so
   * the caller can surface it in audit logs.
   */
  async deleteAllForUser(userId: string): Promise<number> {
    const { rowCount } = await this.db.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
    return rowCount ?? 0;
  }

  async deleteExpired(): Promise<number> {
    const { rowCount } = await this.db.query(`DELETE FROM sessions WHERE expires_at <= now()`);
    return rowCount ?? 0;
  }
}
