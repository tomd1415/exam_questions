import { createHash, randomBytes } from 'node:crypto';
import { hashPassword, verifyPassword } from '../lib/passwords.js';
import type { SessionRepo } from '../repos/sessions.js';
import type { UserRepo, UserRow } from '../repos/users.js';
import type { AuditService } from './audit.js';

const FAILED_ATTEMPTS_BEFORE_LOCKOUT = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;

export type LoginResult =
  | { kind: 'ok'; user: UserRow; sessionId: string; expiresAt: Date }
  | { kind: 'invalid_credentials' }
  | { kind: 'account_locked'; until: Date }
  | { kind: 'account_inactive' };

export class AuthService {
  constructor(
    private readonly users: UserRepo,
    private readonly sessions: SessionRepo,
    private readonly audit: AuditService,
  ) {}

  async login(input: {
    username: string;
    password: string;
    userAgent: string;
    ipHash: string;
  }): Promise<LoginResult> {
    const user = await this.users.findByUsername(input.username);
    if (!user) {
      await this.audit.record({ userId: null, role: 'anonymous' }, 'auth.login.failed', {
        reason: 'unknown_username',
        username: input.username,
      });
      return { kind: 'invalid_credentials' };
    }

    if (!user.active) {
      await this.audit.record(
        { userId: null, role: 'anonymous' },
        'auth.login.blocked',
        { reason: 'inactive' },
        user.id,
      );
      return { kind: 'account_inactive' };
    }

    if (user.locked_until && user.locked_until > new Date()) {
      await this.audit.record(
        { userId: null, role: 'anonymous' },
        'auth.login.blocked',
        { reason: 'locked', until: user.locked_until.toISOString() },
        user.id,
      );
      return { kind: 'account_locked', until: user.locked_until };
    }

    const passwordOk = await verifyPassword(input.password, user.password_hash);
    if (!passwordOk) {
      const newCount = user.failed_login_count + 1;
      const lockoutUntil =
        newCount >= FAILED_ATTEMPTS_BEFORE_LOCKOUT
          ? new Date(Date.now() + LOCKOUT_DURATION_MS)
          : null;
      await this.users.recordFailedLogin(user.id, newCount, lockoutUntil);
      await this.audit.record(
        { userId: null, role: 'anonymous' },
        'auth.login.failed',
        { reason: 'bad_password', failed_count: newCount, locked: lockoutUntil !== null },
        user.id,
      );
      if (lockoutUntil) {
        return { kind: 'account_locked', until: lockoutUntil };
      }
      return { kind: 'invalid_credentials' };
    }

    const sessionId = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
    await this.sessions.create({
      id: sessionId,
      userId: user.id,
      expiresAt,
      userAgent: input.userAgent.slice(0, 512),
      ipHash: input.ipHash,
    });
    await this.users.recordSuccessfulLogin(user.id);
    await this.audit.record(
      { userId: user.id, role: user.role },
      'auth.login.ok',
      { session_id_prefix: sessionId.slice(0, 8) },
      user.id,
    );

    return { kind: 'ok', user, sessionId, expiresAt };
  }

  async logout(
    sessionId: string,
    actor: { userId: string | null; role: UserRow['role'] | 'anonymous' },
  ): Promise<void> {
    await this.sessions.destroy(sessionId);
    await this.audit.record(actor, 'auth.logout', {
      session_id_prefix: sessionId.slice(0, 8),
    });
  }

  async resolveSession(sessionId: string): Promise<UserRow | null> {
    const session = await this.sessions.findValid(sessionId);
    if (!session) return null;
    const user = await this.users.findById(session.user_id);
    if (!user?.active) return null;
    await this.sessions.touch(sessionId);
    return user;
  }
}

export function hashIp(ip: string, salt: string): string {
  return createHash('sha256').update(salt).update(':').update(ip).digest('hex');
}

export { hashPassword };
