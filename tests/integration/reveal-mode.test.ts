import { describe, it, expect, beforeEach } from 'vitest';
import { AttemptRepo } from '../../src/repos/attempts.js';
import { ClassRepo } from '../../src/repos/classes.js';
import { AuditRepo } from '../../src/repos/audit.js';
import { UserRepo } from '../../src/repos/users.js';
import { AuditService } from '../../src/services/audit.js';
import { AttemptService } from '../../src/services/attempts.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createQuestion, createUser } from '../helpers/fixtures.js';

const pool = getSharedPool();
const attemptRepo = new AttemptRepo(pool);
const classRepo = new ClassRepo(pool);
const userRepo = new UserRepo(pool);
const auditService = new AuditService(new AuditRepo(pool));
const service = new AttemptService(attemptRepo, classRepo, auditService, userRepo);

beforeEach(async () => {
  await cleanDb();
});

async function seedPupilWithTopic(): Promise<{
  teacher: { id: string };
  pupil: { id: string };
  classId: string;
}> {
  const teacher = await createUser(pool, { role: 'teacher' });
  const pupil = await createUser(pool, { role: 'pupil' });
  const cls = await classRepo.createClass({
    name: 'Reveal mode test',
    teacherId: teacher.id,
    academicYear: '2025/26',
  });
  await classRepo.addEnrolment(cls.id, pupil.id);
  await classRepo.assignTopic(cls.id, '1.2', teacher.id);
  await createQuestion(pool, teacher.id, {
    topicCode: '1.2',
    active: true,
    approvalStatus: 'approved',
  });
  return { teacher, pupil, classId: cls.id };
}

describe('AttemptService.setRevealModeForUser', () => {
  it('persists the preference on the user row and writes an audit event', async () => {
    const pupil = await createUser(pool, { role: 'pupil' });
    const before = await userRepo.findById(pupil.id);
    expect(before?.reveal_mode).toBe('per_question');

    await service.setRevealModeForUser({ id: pupil.id, role: 'pupil' }, 'whole_attempt');

    const after = await userRepo.findById(pupil.id);
    expect(after?.reveal_mode).toBe('whole_attempt');

    const audit = await pool.query<{ event_type: string; details: Record<string, unknown> }>(
      `SELECT event_type, details FROM audit_events WHERE actor_user_id = $1::bigint`,
      [pupil.id],
    );
    expect(audit.rows.map((r) => r.event_type)).toContain('user.reveal_mode.set');
    const row = audit.rows.find((r) => r.event_type === 'user.reveal_mode.set');
    expect(row?.details).toMatchObject({ mode: 'whole_attempt' });
  });

  it('round-trips both valid modes', async () => {
    const pupil = await createUser(pool, { role: 'pupil' });
    await service.setRevealModeForUser({ id: pupil.id, role: 'pupil' }, 'whole_attempt');
    expect((await userRepo.findById(pupil.id))?.reveal_mode).toBe('whole_attempt');
    await service.setRevealModeForUser({ id: pupil.id, role: 'pupil' }, 'per_question');
    expect((await userRepo.findById(pupil.id))?.reveal_mode).toBe('per_question');
  });
});

describe('AttemptService.startTopicSet — reveal mode propagation', () => {
  it('stamps attempts.reveal_mode with the value passed from the route', async () => {
    const { pupil } = await seedPupilWithTopic();
    const result = await service.startTopicSet(
      { id: pupil.id, role: 'pupil' },
      '1.2',
      'whole_attempt',
    );
    const { rows } = await pool.query<{ reveal_mode: string }>(
      `SELECT reveal_mode FROM attempts WHERE id = $1::bigint`,
      [result.attemptId],
    );
    expect(rows[0]?.reveal_mode).toBe('whole_attempt');
  });

  it('defaults to per_question when the route omits the mode argument', async () => {
    const { pupil } = await seedPupilWithTopic();
    const result = await service.startTopicSet({ id: pupil.id, role: 'pupil' }, '1.2');
    const { rows } = await pool.query<{ reveal_mode: string }>(
      `SELECT reveal_mode FROM attempts WHERE id = $1::bigint`,
      [result.attemptId],
    );
    expect(rows[0]?.reveal_mode).toBe('per_question');
  });

  it('changing the user preference AFTER an attempt starts does not mutate the in-flight attempt', async () => {
    const { pupil } = await seedPupilWithTopic();
    // Start under per_question
    const first = await service.startTopicSet(
      { id: pupil.id, role: 'pupil' },
      '1.2',
      'per_question',
    );
    // Pupil flips preference mid-flight
    await service.setRevealModeForUser({ id: pupil.id, role: 'pupil' }, 'whole_attempt');

    const { rows } = await pool.query<{ reveal_mode: string }>(
      `SELECT reveal_mode FROM attempts WHERE id = $1::bigint`,
      [first.attemptId],
    );
    expect(rows[0]?.reveal_mode).toBe('per_question');
  });
});
