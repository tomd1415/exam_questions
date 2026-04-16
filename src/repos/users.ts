import type { Pool } from 'pg';

export type UserRole = 'pupil' | 'teacher' | 'admin';

export interface UserRow {
  id: string;
  role: UserRole;
  display_name: string;
  username: string;
  password_hash: string;
  must_change_password: boolean;
  failed_login_count: number;
  locked_until: Date | null;
  last_login_at: Date | null;
  active: boolean;
  pseudonym: string;
  created_at: Date;
  updated_at: Date;
}

export class UserRepo {
  constructor(private readonly db: Pool) {}

  async findByUsername(username: string): Promise<UserRow | null> {
    const { rows } = await this.db.query<UserRow>(
      `SELECT id::text, role, display_name, username, password_hash,
              must_change_password, failed_login_count, locked_until,
              last_login_at, active, pseudonym, created_at, updated_at
         FROM users
        WHERE username = $1`,
      [username],
    );
    return rows[0] ?? null;
  }

  async findById(id: string): Promise<UserRow | null> {
    const { rows } = await this.db.query<UserRow>(
      `SELECT id::text, role, display_name, username, password_hash,
              must_change_password, failed_login_count, locked_until,
              last_login_at, active, pseudonym, created_at, updated_at
         FROM users
        WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async recordSuccessfulLogin(id: string): Promise<void> {
    await this.db.query(
      `UPDATE users
          SET failed_login_count = 0,
              locked_until       = NULL,
              last_login_at      = now(),
              updated_at         = now()
        WHERE id = $1`,
      [id],
    );
  }

  async recordFailedLogin(
    id: string,
    nowFailedCount: number,
    lockoutUntil: Date | null,
  ): Promise<void> {
    await this.db.query(
      `UPDATE users
          SET failed_login_count = $2,
              locked_until       = $3,
              updated_at         = now()
        WHERE id = $1`,
      [id, nowFailedCount, lockoutUntil],
    );
  }
}
