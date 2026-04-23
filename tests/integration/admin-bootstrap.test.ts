import { randomBytes } from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import { seedAdminFromEnv } from '../../src/services/admin_bootstrap.js';
import { verifyPassword } from '../../src/lib/passwords.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';

// Guards the "fresh Debian VM" deploy path: the app must be able to
// bootstrap the single configured admin on first boot without the
// deployer having to SSH in and run user:create. Also guards against
// the three ways a naive implementation silently does the wrong
// thing: overwriting an existing admin password, overwriting a
// non-admin who happens to share the username, and creating duplicate
// admins on repeat boots.

const pool = getSharedPool();

function newCreds(): { username: string; initialPassword: string } {
  return {
    username: `admin_${randomBytes(3).toString('hex')}`,
    initialPassword: `init-${randomBytes(8).toString('hex')}`,
  };
}

describe('seedAdminFromEnv', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  it('creates the admin on a fresh DB with must_change_password=true', async () => {
    const creds = newCreds();
    const result = await seedAdminFromEnv(pool, creds);
    expect(result.created).toBe(true);

    const { rows } = await pool.query<{
      role: string;
      username: string;
      password_hash: string;
      must_change_password: boolean;
      active: boolean;
      pseudonym: string;
    }>(
      `SELECT role, username, password_hash, must_change_password, active, pseudonym
          FROM users WHERE username = $1`,
      [creds.username],
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.role).toBe('admin');
    expect(row.must_change_password).toBe(true);
    expect(row.active).toBe(true);
    expect(row.pseudonym).toMatch(/^ADM-/);
    expect(await verifyPassword(creds.initialPassword, row.password_hash)).toBe(true);
  });

  it('is idempotent — a second call does nothing', async () => {
    const creds = newCreds();
    await seedAdminFromEnv(pool, creds);
    const again = await seedAdminFromEnv(pool, creds);
    expect(again.created).toBe(false);
    expect(again.reason).toBe('already_exists');

    const { rowCount } = await pool.query(`SELECT 1 FROM users WHERE username = $1`, [
      creds.username,
    ]);
    expect(rowCount).toBe(1);
  });

  it('does not overwrite an admin whose password has been changed since bootstrap', async () => {
    const creds = newCreds();
    await seedAdminFromEnv(pool, creds);
    // Simulate the real admin rotating their password.
    await pool.query(
      `UPDATE users SET password_hash = 'rotated-hash-placeholder', must_change_password = false
         WHERE username = $1`,
      [creds.username],
    );
    const again = await seedAdminFromEnv(pool, { ...creds, initialPassword: 'different-password' });
    expect(again.created).toBe(false);

    const { rows } = await pool.query<{ password_hash: string; must_change_password: boolean }>(
      `SELECT password_hash, must_change_password FROM users WHERE username = $1`,
      [creds.username],
    );
    expect(rows[0]!.password_hash).toBe('rotated-hash-placeholder');
    expect(rows[0]!.must_change_password).toBe(false);
  });

  it('refuses to clobber a non-admin who happens to share the configured username', async () => {
    const creds = newCreds();
    // A pupil lands first with the same username (e.g. via user:create
    // while ADMIN_USERNAME was unset on the deployer box).
    await pool.query(
      `INSERT INTO users (role, display_name, username, password_hash, pseudonym)
         VALUES ('pupil', 'Pupil Name', $1, 'placeholder-hash', $2)`,
      [creds.username, `PUP-${randomBytes(3).toString('hex')}`],
    );
    const result = await seedAdminFromEnv(pool, creds);
    expect(result.created).toBe(false);
    expect(result.reason).toBe('username_taken_by_non_admin');

    const { rows } = await pool.query<{ role: string }>(
      `SELECT role FROM users WHERE username = $1`,
      [creds.username],
    );
    expect(rows[0]!.role).toBe('pupil');
  });

  it("skips when a differently-named admin already exists (don't stack admins)", async () => {
    // A human admin was created by hand under a different username.
    await pool.query(
      `INSERT INTO users (role, display_name, username, password_hash, pseudonym)
         VALUES ('admin', 'Existing Admin', 'preexisting_admin', 'placeholder-hash', 'ADM-PRE')`,
    );
    const creds = newCreds();
    const result = await seedAdminFromEnv(pool, creds);
    expect(result.created).toBe(false);
    expect(result.reason).toBe('already_exists');

    const { rowCount } = await pool.query(`SELECT 1 FROM users WHERE role = 'admin'`);
    expect(rowCount).toBe(1);
  });
});
