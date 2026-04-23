import type { Pool } from 'pg';
import { hashPassword } from '../lib/passwords.js';

// Creates an admin user on fresh DBs so a production-style deploy does
// not leave the Debian VM without a way to log in. Called from app.ts
// once migrations + prompt drafts have been seeded.
//
// Idempotent by design: runs only when no user with role='admin'
// exists. Once an admin is on the DB (even if their password has since
// changed), this function is a no-op. That way a human admin changing
// their password cannot be silently overwritten by a restart.
//
// Credentials come from ADMIN_USERNAME and ADMIN_INITIAL_PASSWORD via
// config.ts — the env validator already enforces min-length on the
// password and a non-empty username. The bootstrap user is created
// with must_change_password=true so the "change on first login" flow
// kicks in immediately.
export async function seedAdminFromEnv(
  pool: Pool,
  creds: { username: string; initialPassword: string },
): Promise<{ created: boolean; reason?: 'already_exists' | 'username_taken_by_non_admin' }> {
  const existing = await pool.query<{ role: string }>(
    `SELECT role FROM users WHERE username = $1`,
    [creds.username],
  );
  if (existing.rowCount && existing.rowCount > 0) {
    const role = existing.rows[0]!.role;
    if (role === 'admin') return { created: false, reason: 'already_exists' };
    // Safety: do not clobber a pupil/teacher who happens to share the
    // configured username. The deployer should pick a different
    // ADMIN_USERNAME rather than have us overwrite a real account.
    return { created: false, reason: 'username_taken_by_non_admin' };
  }

  const anyAdmin = await pool.query<{ id: string }>(
    `SELECT id::text FROM users WHERE role = 'admin' LIMIT 1`,
  );
  if (anyAdmin.rowCount && anyAdmin.rowCount > 0) {
    // A differently-named admin already exists; nothing to do.
    return { created: false, reason: 'already_exists' };
  }

  const passwordHash = await hashPassword(creds.initialPassword);
  await pool.query(
    `INSERT INTO users
       (role, display_name, username, password_hash, must_change_password, pseudonym, active)
     VALUES ('admin', 'Site Admin', $1, $2, true, 'ADM-SEED', true)`,
    [creds.username, passwordHash],
  );
  return { created: true };
}
