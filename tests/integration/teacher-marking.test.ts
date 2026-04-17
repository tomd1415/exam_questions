import { describe, it, expect, beforeEach } from 'vitest';
import { AttemptRepo } from '../../src/repos/attempts.js';
import { ClassRepo } from '../../src/repos/classes.js';
import { AuditRepo } from '../../src/repos/audit.js';
import { AuditService } from '../../src/services/audit.js';
import { AttemptService } from '../../src/services/attempts.js';
import { TeacherMarkingError, TeacherMarkingService } from '../../src/services/marking/teacher.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createQuestion, createUser } from '../helpers/fixtures.js';

const pool = getSharedPool();
const attemptRepo = new AttemptRepo(pool);
const classRepo = new ClassRepo(pool);
const auditService = new AuditService(new AuditRepo(pool));
const attemptService = new AttemptService(attemptRepo, classRepo, auditService);
const teacherMarking = new TeacherMarkingService(attemptRepo, auditService);

beforeEach(async () => {
  await cleanDb();
});

async function setup(): Promise<{
  teacher: { id: string };
  pupil: { id: string };
  attemptId: string;
  mcPartId: string;
  openPartId: string;
  classId: string;
}> {
  const teacher = await createUser(pool, { role: 'teacher' });
  const pupil = await createUser(pool, { role: 'pupil' });
  const cls = await classRepo.createClass({
    name: 'Teacher marking',
    teacherId: teacher.id,
    academicYear: '2025/26',
  });
  await classRepo.addEnrolment(cls.id, pupil.id);
  await classRepo.assignTopic(cls.id, '1.2', teacher.id);
  await createQuestion(pool, teacher.id, {
    topicCode: '1.2',
    subtopicCode: '1.2.1',
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
      {
        label: '(b)',
        prompt: 'Explain at length.',
        marks: 6,
        expectedResponseType: 'extended_response',
      },
    ],
  });
  const actor = { id: pupil.id, role: 'pupil' as const };
  const { attemptId } = await attemptService.startTopicSet(actor, '1.2');
  const bundle = await attemptRepo.loadAttemptBundle(attemptId);
  const parts = bundle!.partsByQuestion.get(bundle!.questions[0]!.id)!;
  const mcPartId = parts.find((p) => p.part_label === '(a)')!.id;
  const openPartId = parts.find((p) => p.part_label === '(b)')!.id;
  await attemptService.saveAnswer(actor, attemptId, [
    { attemptPartId: mcPartId, rawAnswer: 'CPU' },
    { attemptPartId: openPartId, rawAnswer: 'An essay answer.' },
  ]);
  await attemptService.submitAttempt(actor, attemptId);
  return { teacher, pupil, attemptId, mcPartId, openPartId, classId: cls.id };
}

describe('TeacherMarkingService.setTeacherMark', () => {
  it('creates one awarded_marks row + one teacher_overrides row + one audit event on first mark', async () => {
    const { teacher, openPartId, attemptId, pupil } = await setup();

    const before = await pool.query<{ c: string }>(`SELECT count(*)::text AS c FROM audit_events`);
    const baselineAudit = Number(before.rows[0]!.c);

    const result = await teacherMarking.setTeacherMark(
      { id: teacher.id, role: 'teacher' },
      openPartId,
      4,
      'Full explanation of fetch–decode–execute.',
    );

    expect(result.marksAwarded).toBe(4);
    expect(result.marksTotal).toBe(6);

    const awarded = await pool.query<{ c: string; marks: number; marker: string }>(
      `SELECT count(*)::text AS c, max(marks_awarded) AS marks, max(marker) AS marker
         FROM awarded_marks WHERE attempt_part_id = $1::bigint`,
      [openPartId],
    );
    expect(Number(awarded.rows[0]!.c)).toBe(1);
    expect(awarded.rows[0]!.marks).toBe(4);
    expect(awarded.rows[0]!.marker).toBe('teacher_override');

    const overrides = await pool.query<{ c: string; new_marks: number }>(
      `SELECT count(*)::text AS c, max(new_marks_awarded) AS new_marks
         FROM teacher_overrides tov
         JOIN awarded_marks am ON am.id = tov.awarded_mark_id
        WHERE am.attempt_part_id = $1::bigint`,
      [openPartId],
    );
    expect(Number(overrides.rows[0]!.c)).toBe(1);
    expect(overrides.rows[0]!.new_marks).toBe(4);

    const audit = await pool.query<{ event_type: string; subject_user_id: string }>(
      `SELECT event_type, subject_user_id::text
         FROM audit_events
        WHERE event_type = 'marking.override' AND actor_user_id = $1::bigint
        ORDER BY at DESC LIMIT 1`,
      [teacher.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.subject_user_id).toBe(pupil.id);
    const nowAudit = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM audit_events`,
    );
    expect(Number(nowAudit.rows[0]!.c)).toBe(baselineAudit + 1);

    // The loaded bundle's latest-awarded mapping reflects the override.
    const after = await attemptRepo.loadAttemptBundle(attemptId);
    const latest = after!.awardedByAttemptPart.get(openPartId);
    expect(latest?.marks_awarded).toBe(4);
    expect(latest?.marker).toBe('teacher_override');
  });

  it('second override on the same part replaces the latest mark but keeps every override row', async () => {
    const { teacher, openPartId, attemptId } = await setup();
    const actor = { id: teacher.id, role: 'teacher' as const };

    await teacherMarking.setTeacherMark(actor, openPartId, 2, 'First pass.');
    await teacherMarking.setTeacherMark(actor, openPartId, 5, 'Revised after re-read.');

    const awarded = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM awarded_marks WHERE attempt_part_id = $1::bigint`,
      [openPartId],
    );
    expect(Number(awarded.rows[0]!.c)).toBe(2);

    const overrides = await pool.query<{ new_marks: number; reason: string }>(
      `SELECT new_marks_awarded AS new_marks, reason
         FROM teacher_overrides tov
         JOIN awarded_marks am ON am.id = tov.awarded_mark_id
        WHERE am.attempt_part_id = $1::bigint
        ORDER BY tov.created_at ASC`,
      [openPartId],
    );
    expect(overrides.rows.map((r) => r.new_marks)).toEqual([2, 5]);
    expect(overrides.rows.map((r) => r.reason)).toEqual(['First pass.', 'Revised after re-read.']);

    // Loaded bundle picks the latest (5).
    const bundle = await attemptRepo.loadAttemptBundle(attemptId);
    expect(bundle!.awardedByAttemptPart.get(openPartId)?.marks_awarded).toBe(5);

    // marking.override fired twice.
    const audit = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM audit_events WHERE event_type = 'marking.override'`,
    );
    expect(Number(audit.rows[0]!.c)).toBe(2);
  });

  it('overriding an objective mark replaces the deterministic result but preserves it in awarded_marks', async () => {
    const { teacher, mcPartId, attemptId } = await setup();
    // Pre-override: deterministic marker gave 1/1 at submit.
    const bundleBefore = await attemptRepo.loadAttemptBundle(attemptId);
    expect(bundleBefore!.awardedByAttemptPart.get(mcPartId)?.marker).toBe('deterministic');
    expect(bundleBefore!.awardedByAttemptPart.get(mcPartId)?.marks_awarded).toBe(1);

    await teacherMarking.setTeacherMark(
      { id: teacher.id, role: 'teacher' },
      mcPartId,
      0,
      'Rejected: pupil admitted guessing.',
    );
    const rows = await pool.query<{ marker: string; marks: number }>(
      `SELECT marker, marks_awarded AS marks FROM awarded_marks
        WHERE attempt_part_id = $1::bigint ORDER BY created_at ASC`,
      [mcPartId],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]!.marker).toBe('deterministic');
    expect(rows.rows[1]!.marker).toBe('teacher_override');
    const bundleAfter = await attemptRepo.loadAttemptBundle(attemptId);
    expect(bundleAfter!.awardedByAttemptPart.get(mcPartId)?.marks_awarded).toBe(0);
    expect(bundleAfter!.awardedByAttemptPart.get(mcPartId)?.marker).toBe('teacher_override');
  });

  it('rejects a teacher who does not own the class', async () => {
    const { openPartId } = await setup();
    const otherTeacher = await createUser(pool, { role: 'teacher' });
    await expect(
      teacherMarking.setTeacherMark(
        { id: otherTeacher.id, role: 'teacher' },
        openPartId,
        3,
        'Looks wrong.',
      ),
    ).rejects.toMatchObject({ reason: 'not_owner' });
  });

  it('admin can override even without owning the class', async () => {
    const { openPartId } = await setup();
    const admin = await createUser(pool, { role: 'admin' });
    const result = await teacherMarking.setTeacherMark(
      { id: admin.id, role: 'admin' },
      openPartId,
      6,
      'Admin moderation pass.',
    );
    expect(result.marksAwarded).toBe(6);
  });

  it('rejects pupil actors and non-owning pupils never reach this service', async () => {
    const { openPartId } = await setup();
    const snoop = await createUser(pool, { role: 'pupil' });
    await expect(
      teacherMarking.setTeacherMark(
        { id: snoop.id, role: 'pupil' },
        openPartId,
        3,
        'Trying to mark.',
      ),
    ).rejects.toBeInstanceOf(TeacherMarkingError);
  });

  it('rejects marks outside 0..partMarks', async () => {
    const { teacher, openPartId } = await setup();
    const actor = { id: teacher.id, role: 'teacher' as const };
    await expect(
      teacherMarking.setTeacherMark(actor, openPartId, -1, 'Negative.'),
    ).rejects.toMatchObject({ reason: 'invalid_marks' });
    await expect(
      teacherMarking.setTeacherMark(actor, openPartId, 99, 'Too many.'),
    ).rejects.toMatchObject({ reason: 'invalid_marks' });
    await expect(
      teacherMarking.setTeacherMark(actor, openPartId, 3.5, 'Fractional.'),
    ).rejects.toMatchObject({ reason: 'invalid_marks' });
  });

  it('rejects an empty reason', async () => {
    const { teacher, openPartId } = await setup();
    await expect(
      teacherMarking.setTeacherMark({ id: teacher.id, role: 'teacher' }, openPartId, 3, '   '),
    ).rejects.toMatchObject({ reason: 'invalid_reason' });
  });

  it('rejects marking an attempt that has not been submitted', async () => {
    const teacher = await createUser(pool, { role: 'teacher' });
    const pupil = await createUser(pool, { role: 'pupil' });
    const cls = await classRepo.createClass({
      name: 'Unsubmitted',
      teacherId: teacher.id,
      academicYear: '2025/26',
    });
    await classRepo.addEnrolment(cls.id, pupil.id);
    await classRepo.assignTopic(cls.id, '1.2', teacher.id);
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
    const { attemptId } = await attemptService.startTopicSet(
      { id: pupil.id, role: 'pupil' },
      '1.2',
    );
    const bundle = await attemptRepo.loadAttemptBundle(attemptId);
    const partId = bundle!.partsByQuestion.get(bundle!.questions[0]!.id)![0]!.id;

    await expect(
      teacherMarking.setTeacherMark(
        { id: teacher.id, role: 'teacher' },
        partId,
        1,
        'Eager teacher.',
      ),
    ).rejects.toMatchObject({ reason: 'not_yet_submitted' });
  });
});
