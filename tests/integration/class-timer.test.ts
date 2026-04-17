import { describe, it, expect, beforeEach } from 'vitest';
import { AttemptRepo } from '../../src/repos/attempts.js';
import { ClassRepo } from '../../src/repos/classes.js';
import { AuditRepo } from '../../src/repos/audit.js';
import { AuditService } from '../../src/services/audit.js';
import { AttemptService } from '../../src/services/attempts.js';
import { ClassService, ClassAccessError } from '../../src/services/classes.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createQuestion, createUser } from '../helpers/fixtures.js';

const pool = getSharedPool();
const attemptRepo = new AttemptRepo(pool);
const classRepo = new ClassRepo(pool);
const auditService = new AuditService(new AuditRepo(pool));
const attemptService = new AttemptService(attemptRepo, classRepo, auditService);
const classService = new ClassService(classRepo, auditService);

beforeEach(async () => {
  await cleanDb();
});

async function setupTimedClass(timerMinutes: number | null = 30): Promise<{
  teacher: { id: string };
  pupil: { id: string };
  classId: string;
}> {
  const teacher = await createUser(pool, { role: 'teacher' });
  const pupil = await createUser(pool, { role: 'pupil' });
  const cls = await classRepo.createClass({
    name: 'Timer test',
    teacherId: teacher.id,
    academicYear: '2025/26',
  });
  await classRepo.addEnrolment(cls.id, pupil.id);
  await classRepo.assignTopic(cls.id, '1.2', teacher.id);
  if (timerMinutes !== null) {
    await classService.setClassTimer({ id: teacher.id, role: 'teacher' }, cls.id, timerMinutes);
  }
  await createQuestion(pool, teacher.id, {
    topicCode: '1.2',
    active: true,
    approvalStatus: 'approved',
    parts: [
      {
        label: '(a)',
        prompt: 'Pick one.',
        marks: 1,
        expectedResponseType: 'multiple_choice',
        markPoints: [{ text: 'CPU', marks: 1 }],
      },
    ],
  });
  return { teacher, pupil, classId: cls.id };
}

describe('ClassService.setClassTimer', () => {
  it('persists the timer on the class row and writes an audit event', async () => {
    const teacher = await createUser(pool, { role: 'teacher' });
    const cls = await classRepo.createClass({
      name: 'T',
      teacherId: teacher.id,
      academicYear: '2025/26',
    });

    const updated = await classService.setClassTimer(
      { id: teacher.id, role: 'teacher' },
      cls.id,
      45,
    );
    expect(updated.timer_minutes).toBe(45);

    const fromDb = await classRepo.findById(cls.id);
    expect(fromDb?.timer_minutes).toBe(45);

    const audit = await pool.query<{ event_type: string; details: Record<string, unknown> }>(
      `SELECT event_type, details FROM audit_events
        WHERE actor_user_id = $1::bigint AND event_type = 'class.timer_set'`,
      [teacher.id],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]!.details).toMatchObject({ class_id: cls.id, timer_minutes: 45 });
  });

  it('clears the timer when passed null', async () => {
    const teacher = await createUser(pool, { role: 'teacher' });
    const cls = await classRepo.createClass({
      name: 'T',
      teacherId: teacher.id,
      academicYear: '2025/26',
    });
    await classService.setClassTimer({ id: teacher.id, role: 'teacher' }, cls.id, 60);
    await classService.setClassTimer({ id: teacher.id, role: 'teacher' }, cls.id, null);
    const fromDb = await classRepo.findById(cls.id);
    expect(fromDb?.timer_minutes).toBeNull();
  });

  it('rejects values outside 1–180 with invalid_timer', async () => {
    const teacher = await createUser(pool, { role: 'teacher' });
    const cls = await classRepo.createClass({
      name: 'T',
      teacherId: teacher.id,
      academicYear: '2025/26',
    });
    await expect(
      classService.setClassTimer({ id: teacher.id, role: 'teacher' }, cls.id, 0),
    ).rejects.toMatchObject({ reason: 'invalid_timer' });
    await expect(
      classService.setClassTimer({ id: teacher.id, role: 'teacher' }, cls.id, 181),
    ).rejects.toMatchObject({ reason: 'invalid_timer' });
  });

  it('refuses another teacher with not_owner', async () => {
    const tA = await createUser(pool, { role: 'teacher' });
    const tB = await createUser(pool, { role: 'teacher' });
    const cls = await classRepo.createClass({
      name: 'T',
      teacherId: tA.id,
      academicYear: '2025/26',
    });
    await expect(
      classService.setClassTimer({ id: tB.id, role: 'teacher' }, cls.id, 60),
    ).rejects.toBeInstanceOf(ClassAccessError);
  });
});

describe('AttemptService.startTopicSet — timer snapshot', () => {
  it('copies class.timer_minutes onto the new attempt', async () => {
    const { pupil } = await setupTimedClass(30);
    const result = await attemptService.startTopicSet({ id: pupil.id, role: 'pupil' }, '1.2');
    const { rows } = await pool.query<{ timer_minutes: number | null }>(
      `SELECT timer_minutes FROM attempts WHERE id = $1::bigint`,
      [result.attemptId],
    );
    expect(rows[0]?.timer_minutes).toBe(30);
  });

  it('leaves attempts.timer_minutes null when the class has no timer', async () => {
    const { pupil } = await setupTimedClass(null);
    const result = await attemptService.startTopicSet({ id: pupil.id, role: 'pupil' }, '1.2');
    const { rows } = await pool.query<{ timer_minutes: number | null }>(
      `SELECT timer_minutes FROM attempts WHERE id = $1::bigint`,
      [result.attemptId],
    );
    expect(rows[0]?.timer_minutes).toBeNull();
  });

  it('changing the class timer AFTER an attempt starts does not mutate the in-flight attempt', async () => {
    const { teacher, pupil, classId } = await setupTimedClass(20);
    const first = await attemptService.startTopicSet({ id: pupil.id, role: 'pupil' }, '1.2');
    await classService.setClassTimer({ id: teacher.id, role: 'teacher' }, classId, 60);
    const { rows } = await pool.query<{ timer_minutes: number | null }>(
      `SELECT timer_minutes FROM attempts WHERE id = $1::bigint`,
      [first.attemptId],
    );
    expect(rows[0]?.timer_minutes).toBe(20);
  });
});

describe('AttemptService.submitAttempt — elapsed_seconds clamping', () => {
  it('stores elapsed_seconds when passed and under the ceiling', async () => {
    const { pupil } = await setupTimedClass(10);
    const actor = { id: pupil.id, role: 'pupil' as const };
    const { attemptId } = await attemptService.startTopicSet(actor, '1.2');
    const result = await attemptService.submitAttempt(actor, attemptId, 300);
    expect(result.elapsedSeconds).toBe(300);
    const { rows } = await pool.query<{ elapsed_seconds: number | null }>(
      `SELECT elapsed_seconds FROM attempts WHERE id = $1::bigint`,
      [attemptId],
    );
    expect(rows[0]?.elapsed_seconds).toBe(300);
  });

  it('clamps elapsed_seconds to timer_minutes*60 + 30 when over', async () => {
    const { pupil } = await setupTimedClass(10);
    const actor = { id: pupil.id, role: 'pupil' as const };
    const { attemptId } = await attemptService.startTopicSet(actor, '1.2');
    const result = await attemptService.submitAttempt(actor, attemptId, 99_999);
    expect(result.elapsedSeconds).toBe(10 * 60 + 30);
    const { rows } = await pool.query<{ elapsed_seconds: number | null }>(
      `SELECT elapsed_seconds FROM attempts WHERE id = $1::bigint`,
      [attemptId],
    );
    expect(rows[0]?.elapsed_seconds).toBe(630);
  });

  it('ignores a non-null elapsed when the attempt has no timer', async () => {
    const { pupil } = await setupTimedClass(null);
    const actor = { id: pupil.id, role: 'pupil' as const };
    const { attemptId } = await attemptService.startTopicSet(actor, '1.2');
    const result = await attemptService.submitAttempt(actor, attemptId, 500);
    expect(result.elapsedSeconds).toBeNull();
    const { rows } = await pool.query<{ elapsed_seconds: number | null }>(
      `SELECT elapsed_seconds FROM attempts WHERE id = $1::bigint`,
      [attemptId],
    );
    expect(rows[0]?.elapsed_seconds).toBeNull();
  });

  it('leaves elapsed_seconds null when no value is passed', async () => {
    const { pupil } = await setupTimedClass(10);
    const actor = { id: pupil.id, role: 'pupil' as const };
    const { attemptId } = await attemptService.startTopicSet(actor, '1.2');
    const result = await attemptService.submitAttempt(actor, attemptId);
    expect(result.elapsedSeconds).toBeNull();
    const { rows } = await pool.query<{ elapsed_seconds: number | null }>(
      `SELECT elapsed_seconds FROM attempts WHERE id = $1::bigint`,
      [attemptId],
    );
    expect(rows[0]?.elapsed_seconds).toBeNull();
  });
});
