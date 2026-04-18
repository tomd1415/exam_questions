import type { Pool } from 'pg';

export type UserRole = 'pupil' | 'teacher' | 'admin';

export type RevealMode = 'per_question' | 'whole_attempt';

export const REVEAL_MODES: readonly RevealMode[] = ['per_question', 'whole_attempt'] as const;

export type FontPreference = 'system' | 'dyslexic';

export const FONT_PREFERENCES: readonly FontPreference[] = ['system', 'dyslexic'] as const;

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
  reveal_mode: RevealMode;
  font_preference: FontPreference;
  widget_tips_dismissed: Record<string, string>;
  created_at: Date;
  updated_at: Date;
}

export class UserRepo {
  constructor(private readonly db: Pool) {}

  async findByUsername(username: string): Promise<UserRow | null> {
    const { rows } = await this.db.query<UserRow>(
      `SELECT id::text, role, display_name, username, password_hash,
              must_change_password, failed_login_count, locked_until,
              last_login_at, active, pseudonym, reveal_mode, font_preference,
              widget_tips_dismissed, created_at, updated_at
         FROM users
        WHERE username = $1`,
      [username],
    );
    return rows[0] ?? null;
  }

  async findActivePupilByUsername(username: string): Promise<UserRow | null> {
    const { rows } = await this.db.query<UserRow>(
      `SELECT id::text, role, display_name, username, password_hash,
              must_change_password, failed_login_count, locked_until,
              last_login_at, active, pseudonym, reveal_mode, font_preference,
              widget_tips_dismissed, created_at, updated_at
         FROM users
        WHERE username = $1
          AND role = 'pupil'
          AND active = true`,
      [username],
    );
    return rows[0] ?? null;
  }

  async findById(id: string): Promise<UserRow | null> {
    const { rows } = await this.db.query<UserRow>(
      `SELECT id::text, role, display_name, username, password_hash,
              must_change_password, failed_login_count, locked_until,
              last_login_at, active, pseudonym, reveal_mode, font_preference,
              widget_tips_dismissed, created_at, updated_at
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

  async setRevealMode(userId: string, mode: RevealMode): Promise<void> {
    await this.db.query(
      `UPDATE users SET reveal_mode = $2, updated_at = now() WHERE id = $1::bigint`,
      [userId, mode],
    );
  }

  async setFontPreference(userId: string, font: FontPreference): Promise<void> {
    await this.db.query(
      `UPDATE users SET font_preference = $2, updated_at = now() WHERE id = $1::bigint`,
      [userId, font],
    );
  }

  /**
   * Records that the pupil has dismissed the help tip for one widget
   * type. Idempotent: re-dismissing overwrites the timestamp. The
   * `widgetKey` is taken from the widget registry; the route validates
   * it before calling.
   */
  async dismissWidgetTip(userId: string, widgetKey: string, at: Date): Promise<void> {
    await this.db.query(
      `UPDATE users
          SET widget_tips_dismissed = widget_tips_dismissed || jsonb_build_object($2::text, $3::text),
              updated_at            = now()
        WHERE id = $1::bigint`,
      [userId, widgetKey, at.toISOString()],
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
