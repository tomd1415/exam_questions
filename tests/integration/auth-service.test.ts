import { describe, it, expect, beforeEach } from 'vitest';
import { UserRepo } from '../../src/repos/users.js';
import { SessionRepo } from '../../src/repos/sessions.js';
import { AuditRepo } from '../../src/repos/audit.js';
import { AuditService } from '../../src/services/audit.js';
import { AuthService } from '../../src/services/auth.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createUser } from '../helpers/fixtures.js';

const pool = getSharedPool();
const auth = new AuthService(
  new UserRepo(pool),
  new SessionRepo(pool),
  new AuditService(new AuditRepo(pool)),
);

const baseInput = { userAgent: 'vitest-ua', ipHash: 'iphash-test' };

beforeEach(async () => {
  await cleanDb();
});

async function lastAuditEvent(): Promise<{ event_type: string; details: Record<string, unknown> }> {
  const { rows } = await pool.query<{
    event_type: string;
    details: Record<string, unknown>;
  }>(`SELECT event_type, details FROM audit_events ORDER BY id DESC LIMIT 1`);
  return rows[0]!;
}

describe('AuthService.login', () => {
  it('returns ok with a session for correct credentials', async () => {
    const u = await createUser(pool, { username: 'alice', password: 'pw-12345-ok' });
    const result = await auth.login({
      username: 'alice',
      password: 'pw-12345-ok',
      ...baseInput,
    });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.user.id).toBe(u.id);
    expect(result.sessionId).toMatch(/^[0-9a-f]{64}$/);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const { rowCount } = await pool.query(`SELECT 1 FROM sessions WHERE id = $1`, [
      result.sessionId,
    ]);
    expect(rowCount).toBe(1);

    const last = await lastAuditEvent();
    expect(last.event_type).toBe('auth.login.ok');
  });

  it('records auth.login.failed on unknown username', async () => {
    const result = await auth.login({
      username: 'no-such-user',
      password: 'whatever',
      ...baseInput,
    });
    expect(result.kind).toBe('invalid_credentials');

    const last = await lastAuditEvent();
    expect(last.event_type).toBe('auth.login.failed');
    expect(last.details['reason']).toBe('unknown_username');
  });

  it('records auth.login.failed and bumps counter on bad password', async () => {
    const u = await createUser(pool, { username: 'bob', password: 'right-pw' });
    const result = await auth.login({
      username: 'bob',
      password: 'wrong-pw',
      ...baseInput,
    });
    expect(result.kind).toBe('invalid_credentials');

    const after = await pool.query<{ failed_login_count: number }>(
      `SELECT failed_login_count FROM users WHERE id = $1::bigint`,
      [u.id],
    );
    expect(after.rows[0]?.failed_login_count).toBe(1);

    const last = await lastAuditEvent();
    expect(last.event_type).toBe('auth.login.failed');
    expect(last.details['reason']).toBe('bad_password');
  });

  it('locks the account after 5 consecutive failures', async () => {
    const u = await createUser(pool, { username: 'carol', password: 'right-pw' });
    let lastResult;
    for (let i = 0; i < 5; i++) {
      lastResult = await auth.login({
        username: 'carol',
        password: 'wrong-pw',
        ...baseInput,
      });
    }
    expect(lastResult?.kind).toBe('account_locked');

    const after = await pool.query<{
      failed_login_count: number;
      locked_until: Date | null;
    }>(`SELECT failed_login_count, locked_until FROM users WHERE id = $1::bigint`, [u.id]);
    expect(after.rows[0]?.failed_login_count).toBe(5);
    expect(after.rows[0]?.locked_until).not.toBeNull();
    expect(after.rows[0]!.locked_until!.getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses a locked account with the correct password until lockout passes', async () => {
    await createUser(pool, {
      username: 'dave',
      password: 'right-pw',
      lockedUntil: new Date(Date.now() + 60_000),
    });
    const result = await auth.login({
      username: 'dave',
      password: 'right-pw',
      ...baseInput,
    });
    expect(result.kind).toBe('account_locked');

    const last = await lastAuditEvent();
    expect(last.event_type).toBe('auth.login.blocked');
    expect(last.details['reason']).toBe('locked');
  });

  it('returns account_inactive for inactive users', async () => {
    await createUser(pool, { username: 'eve', password: 'right-pw', active: false });
    const result = await auth.login({
      username: 'eve',
      password: 'right-pw',
      ...baseInput,
    });
    expect(result.kind).toBe('account_inactive');

    const last = await lastAuditEvent();
    expect(last.event_type).toBe('auth.login.blocked');
    expect(last.details['reason']).toBe('inactive');
  });

  it('clears lockout state on a successful login', async () => {
    const u = await createUser(pool, {
      username: 'frank',
      password: 'right-pw',
      failedLoginCount: 4,
    });
    const result = await auth.login({
      username: 'frank',
      password: 'right-pw',
      ...baseInput,
    });
    expect(result.kind).toBe('ok');
    const after = await pool.query<{
      failed_login_count: number;
      locked_until: Date | null;
    }>(`SELECT failed_login_count, locked_until FROM users WHERE id = $1::bigint`, [u.id]);
    expect(after.rows[0]?.failed_login_count).toBe(0);
    expect(after.rows[0]?.locked_until).toBeNull();
  });
});

describe('AuthService.resolveSession', () => {
  it('returns the user for a valid session', async () => {
    const u = await createUser(pool, { username: 'gina', password: 'pw-1234567' });
    const login = await auth.login({
      username: 'gina',
      password: 'pw-1234567',
      ...baseInput,
    });
    if (login.kind !== 'ok') throw new Error('expected ok');
    const resolved = await auth.resolveSession(login.sessionId);
    expect(resolved?.id).toBe(u.id);
  });

  it('returns null for an unknown session id', async () => {
    expect(await auth.resolveSession('does-not-exist')).toBeNull();
  });

  it('returns null when the underlying user is now inactive', async () => {
    const u = await createUser(pool, { username: 'henry', password: 'pw-1234567' });
    const login = await auth.login({
      username: 'henry',
      password: 'pw-1234567',
      ...baseInput,
    });
    if (login.kind !== 'ok') throw new Error('expected ok');

    await pool.query(`UPDATE users SET active = false WHERE id = $1::bigint`, [u.id]);
    expect(await auth.resolveSession(login.sessionId)).toBeNull();
  });
});

describe('AuthService.logout', () => {
  it('destroys the session and writes an audit row', async () => {
    const u = await createUser(pool, { username: 'iris', password: 'pw-1234567' });
    const login = await auth.login({
      username: 'iris',
      password: 'pw-1234567',
      ...baseInput,
    });
    if (login.kind !== 'ok') throw new Error('expected ok');

    await auth.logout(login.sessionId, { userId: u.id, role: 'pupil' });

    const { rowCount } = await pool.query(`SELECT 1 FROM sessions WHERE id = $1`, [
      login.sessionId,
    ]);
    expect(rowCount).toBe(0);

    const last = await lastAuditEvent();
    expect(last.event_type).toBe('auth.logout');
  });
});
