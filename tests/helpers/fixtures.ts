import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { hashPassword } from '../../src/lib/passwords.js';
import type { UserRole } from '../../src/repos/users.js';

export interface CreatedUser {
  id: string;
  username: string;
  password: string;
  role: UserRole;
  display_name: string;
}

export async function createUser(
  pool: Pool,
  overrides: Partial<{
    role: UserRole;
    username: string;
    password: string;
    displayName: string;
    active: boolean;
    pseudonym: string;
    mustChangePassword: boolean;
    failedLoginCount: number;
    lockedUntil: Date | null;
  }> = {},
): Promise<CreatedUser> {
  const suffix = randomBytes(4).toString('hex');
  const role: UserRole = overrides.role ?? 'pupil';
  const username = overrides.username ?? `${role}_${suffix}`;
  const password = overrides.password ?? 'correct horse battery staple';
  const displayName = overrides.displayName ?? `Test ${role} ${suffix}`;
  const pseudonym = overrides.pseudonym ?? `PSEUDO-${suffix.toUpperCase()}`;
  const active = overrides.active ?? true;
  const mustChange = overrides.mustChangePassword ?? false;
  const failedCount = overrides.failedLoginCount ?? 0;
  const lockedUntil = overrides.lockedUntil ?? null;

  const passwordHash = await hashPassword(password);

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users
       (role, display_name, username, password_hash, must_change_password,
        failed_login_count, locked_until, active, pseudonym)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id::text`,
    [
      role,
      displayName,
      username,
      passwordHash,
      mustChange,
      failedCount,
      lockedUntil,
      active,
      pseudonym,
    ],
  );

  return { id: rows[0]!.id, username, password, role, display_name: displayName };
}
