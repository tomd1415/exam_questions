import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { UserRepo } from '../../src/repos/users.js';
import { SessionRepo } from '../../src/repos/sessions.js';
import { AuditRepo } from '../../src/repos/audit.js';
import { QuestionRepo } from '../../src/repos/questions.js';
import { AttemptRepo } from '../../src/repos/attempts.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createUser } from '../helpers/fixtures.js';

const pool = getSharedPool();
const users = new UserRepo(pool);
const sessions = new SessionRepo(pool);
const audit = new AuditRepo(pool);
const questions = new QuestionRepo(pool);
const attempts = new AttemptRepo(pool);

beforeEach(async () => {
  await cleanDb();
});

describe('UserRepo', () => {
  it('findByUsername returns null for unknown', async () => {
    expect(await users.findByUsername('does-not-exist')).toBeNull();
  });

  it('findByUsername / findById return the same user', async () => {
    const created = await createUser(pool, { role: 'pupil' });
    const byName = await users.findByUsername(created.username);
    const byId = await users.findById(created.id);
    expect(byName?.id).toBe(created.id);
    expect(byId?.username).toBe(created.username);
    expect(byName?.role).toBe('pupil');
  });

  it('findByUsername is case-insensitive (citext)', async () => {
    const created = await createUser(pool, { username: 'AlphaCase' });
    expect((await users.findByUsername('alphacase'))?.id).toBe(created.id);
    expect((await users.findByUsername('ALPHACASE'))?.id).toBe(created.id);
  });

  it('recordSuccessfulLogin clears lockout state', async () => {
    const created = await createUser(pool, {
      failedLoginCount: 3,
      lockedUntil: new Date(Date.now() + 60_000),
    });
    await users.recordSuccessfulLogin(created.id);
    const after = await users.findById(created.id);
    expect(after?.failed_login_count).toBe(0);
    expect(after?.locked_until).toBeNull();
    expect(after?.last_login_at).not.toBeNull();
  });

  it('recordFailedLogin sets count and lockout', async () => {
    const created = await createUser(pool);
    const until = new Date(Date.now() + 30_000);
    await users.recordFailedLogin(created.id, 5, until);
    const after = await users.findById(created.id);
    expect(after?.failed_login_count).toBe(5);
    expect(after?.locked_until?.toISOString()).toBe(until.toISOString());
  });
});

describe('SessionRepo', () => {
  async function makeSession(userId: string, expiresInMs = 60_000): Promise<string> {
    const id = randomBytes(16).toString('hex');
    await sessions.create({
      id,
      userId,
      expiresAt: new Date(Date.now() + expiresInMs),
      userAgent: 'vitest',
      ipHash: 'hash',
    });
    return id;
  }

  it('findValid returns the session before expiry', async () => {
    const u = await createUser(pool);
    const sid = await makeSession(u.id);
    const row = await sessions.findValid(sid);
    expect(row?.user_id).toBe(u.id);
    expect(row?.user_agent).toBe('vitest');
  });

  it('findValid returns null after expiry', async () => {
    const u = await createUser(pool);
    const sid = await makeSession(u.id, -1000);
    expect(await sessions.findValid(sid)).toBeNull();
  });

  it('touch advances last_seen_at', async () => {
    const u = await createUser(pool);
    const sid = await makeSession(u.id);
    const before = (await sessions.findValid(sid))!.last_seen_at;
    await new Promise((r) => setTimeout(r, 25));
    await sessions.touch(sid);
    const after = (await sessions.findValid(sid))!.last_seen_at;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it('destroy removes the row', async () => {
    const u = await createUser(pool);
    const sid = await makeSession(u.id);
    await sessions.destroy(sid);
    expect(await sessions.findValid(sid)).toBeNull();
  });

  it('deleteExpired clears only expired rows', async () => {
    const u = await createUser(pool);
    const live = await makeSession(u.id, 60_000);
    await makeSession(u.id, -1000);
    await makeSession(u.id, -2000);
    const removed = await sessions.deleteExpired();
    expect(removed).toBe(2);
    expect(await sessions.findValid(live)).not.toBeNull();
  });
});

describe('AuditRepo', () => {
  it('append writes a row visible to a SELECT', async () => {
    const u = await createUser(pool, { role: 'teacher' });
    await audit.append({
      actorUserId: u.id,
      actorRole: 'teacher',
      subjectUserId: u.id,
      eventType: 'auth.login.ok',
      details: { session_id_prefix: 'abcd1234' },
    });

    const { rows } = await pool.query<{
      event_type: string;
      details: { session_id_prefix?: string };
    }>(`SELECT event_type, details FROM audit_events WHERE actor_user_id = $1::bigint`, [u.id]);
    expect(rows[0]?.event_type).toBe('auth.login.ok');
    expect(rows[0]?.details.session_id_prefix).toBe('abcd1234');
  });
});

describe('QuestionRepo', () => {
  it('findById returns the seeded Phase 0 question with parts', async () => {
    const q = await questions.findById('1');
    expect(q).not.toBeNull();
    expect(q!.marks_total).toBe(2);
    expect(q!.topic_code).toBe('1.1');
    expect(q!.subtopic_code).toBe('1.1.1');
    expect(q!.command_word_code).toBe('describe');
    expect(q!.parts).toHaveLength(1);
    expect(q!.parts[0]?.part_label).toBe('(a)');
    expect(q!.parts[0]?.marks).toBe(2);
  });

  it('findById returns null for an unknown id', async () => {
    expect(await questions.findById('999999')).toBeNull();
  });
});

describe('AttemptRepo', () => {
  it('findDemoClassId returns the seeded class', async () => {
    const classId = await attempts.findDemoClassId();
    expect(classId).not.toBeNull();
    expect(/^\d+$/.test(classId!)).toBe(true);
  });

  it('saveSubmission persists attempt + question + parts atomically', async () => {
    const u = await createUser(pool);
    const classId = (await attempts.findDemoClassId())!;
    const q = (await questions.findById('1'))!;

    const saved = await attempts.saveSubmission({
      userId: u.id,
      classId,
      questionId: q.id,
      parts: q.parts.map((p) => ({ questionPartId: p.id, rawAnswer: 'arithmetic and logic' })),
    });

    expect(saved.attempt_id).toMatch(/^\d+$/);
    expect(saved.attempt_question_id).toMatch(/^\d+$/);
    expect(saved.part_ids).toHaveLength(1);

    const counts = await pool.query<{ a: string; aq: string; ap: string }>(
      `SELECT
         (SELECT count(*)::text FROM attempts WHERE user_id = $1::bigint) AS a,
         (SELECT count(*)::text FROM attempt_questions
            WHERE attempt_id = (SELECT id FROM attempts WHERE user_id = $1::bigint LIMIT 1)) AS aq,
         (SELECT count(*)::text FROM attempt_parts
            WHERE attempt_question_id = (
              SELECT id FROM attempt_questions
               WHERE attempt_id = (SELECT id FROM attempts WHERE user_id = $1::bigint LIMIT 1)
               LIMIT 1)) AS ap`,
      [u.id],
    );
    expect(counts.rows[0]).toEqual({ a: '1', aq: '1', ap: '1' });

    const submitted = await pool.query<{ submitted_at: Date | null }>(
      `SELECT submitted_at FROM attempts WHERE id = $1::bigint`,
      [saved.attempt_id],
    );
    expect(submitted.rows[0]?.submitted_at).not.toBeNull();
  });

  it('saveSubmission rolls back on FK violation', async () => {
    const u = await createUser(pool);
    const classId = (await attempts.findDemoClassId())!;

    await expect(
      attempts.saveSubmission({
        userId: u.id,
        classId,
        questionId: '999999',
        parts: [{ questionPartId: '1', rawAnswer: 'x' }],
      }),
    ).rejects.toThrow();

    const after = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM attempts WHERE user_id = $1::bigint`,
      [u.id],
    );
    expect(after.rows[0]!.count).toBe('0');
  });
});
