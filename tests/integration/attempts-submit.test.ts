import { describe, it, expect, beforeEach } from 'vitest';
import { AttemptRepo } from '../../src/repos/attempts.js';
import { ClassRepo } from '../../src/repos/classes.js';
import { AuditRepo } from '../../src/repos/audit.js';
import { AuditService } from '../../src/services/audit.js';
import { AttemptService, AttemptAccessError } from '../../src/services/attempts.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createQuestion, createUser } from '../helpers/fixtures.js';

const pool = getSharedPool();
const attemptRepo = new AttemptRepo(pool);
const classRepo = new ClassRepo(pool);
const auditService = new AuditService(new AuditRepo(pool));
const service = new AttemptService(attemptRepo, classRepo, auditService);

beforeEach(async () => {
  await cleanDb();
});

async function setup(): Promise<{ teacher: { id: string }; pupil: { id: string } }> {
  const teacher = await createUser(pool, { role: 'teacher' });
  const pupil = await createUser(pool, { role: 'pupil' });
  const cls = await classRepo.createClass({
    name: 'Submit test',
    teacherId: teacher.id,
    academicYear: '2025/26',
  });
  await classRepo.addEnrolment(cls.id, pupil.id);
  await classRepo.assignTopic(cls.id, '1.2', teacher.id);
  return { teacher, pupil };
}

describe('AttemptService.submitAttempt — deterministic marker integration', () => {
  it('writes awarded_marks for objective parts and leaves open parts pending', async () => {
    const { teacher, pupil } = await setup();
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
          markPoints: [
            { text: 'CPU', marks: 1 },
            { text: 'GPU', marks: 0 },
          ],
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
    const { attemptId } = await service.startTopicSet(actor, '1.2');
    const before = await attemptRepo.loadAttemptBundle(attemptId);
    const partA = before!.partsByQuestion
      .get(before!.questions[0]!.id)!
      .find((p) => p.part_label === '(a)')!;
    const partB = before!.partsByQuestion
      .get(before!.questions[0]!.id)!
      .find((p) => p.part_label === '(b)')!;

    await service.saveAnswer(actor, attemptId, [
      { attemptPartId: partA.id, rawAnswer: 'CPU' },
      { attemptPartId: partB.id, rawAnswer: 'Long answer requiring teacher marking.' },
    ]);
    const result = await service.submitAttempt(actor, attemptId);
    expect(result.markedParts).toBe(1);
    expect(result.pendingParts).toBe(1);

    const after = await attemptRepo.loadAttemptBundle(attemptId);
    const awardedA = after!.awardedByAttemptPart.get(partA.id);
    expect(awardedA?.marks_awarded).toBe(1);
    expect(awardedA?.marker).toBe('deterministic');
    expect(after!.awardedByAttemptPart.has(partB.id)).toBe(false);
    expect(after!.attempt.submitted_at).not.toBeNull();
  });

  it('awards 0 with a recorded row when an objective answer is wrong', async () => {
    const { teacher, pupil } = await setup();
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
    const actor = { id: pupil.id, role: 'pupil' as const };
    const { attemptId } = await service.startTopicSet(actor, '1.2');
    const bundle = await attemptRepo.loadAttemptBundle(attemptId);
    const part = bundle!.partsByQuestion.get(bundle!.questions[0]!.id)![0]!;
    await service.saveAnswer(actor, attemptId, [{ attemptPartId: part.id, rawAnswer: 'RAM' }]);
    const res = await service.submitAttempt(actor, attemptId);
    expect(res.markedParts).toBe(1);
    const after = await attemptRepo.loadAttemptBundle(attemptId);
    expect(after!.awardedByAttemptPart.get(part.id)?.marks_awarded).toBe(0);
  });

  it('rejects re-submission of an already submitted attempt', async () => {
    const { teacher, pupil } = await setup();
    await createQuestion(pool, teacher.id, {
      topicCode: '1.2',
      active: true,
      approvalStatus: 'approved',
    });
    const actor = { id: pupil.id, role: 'pupil' as const };
    const { attemptId } = await service.startTopicSet(actor, '1.2');
    await service.submitAttempt(actor, attemptId);
    await expect(service.submitAttempt(actor, attemptId)).rejects.toMatchObject({
      reason: 'already_submitted',
    });
  });

  it('rejects saveAnswer after submission', async () => {
    const { teacher, pupil } = await setup();
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
    const actor = { id: pupil.id, role: 'pupil' as const };
    const { attemptId } = await service.startTopicSet(actor, '1.2');
    const bundle = await attemptRepo.loadAttemptBundle(attemptId);
    const partId = bundle!.partsByQuestion.get(bundle!.questions[0]!.id)![0]!.id;
    await service.submitAttempt(actor, attemptId);
    await expect(
      service.saveAnswer(actor, attemptId, [{ attemptPartId: partId, rawAnswer: 'X' }]),
    ).rejects.toMatchObject({ reason: 'already_submitted' });
  });

  it('rejects another pupil viewing the attempt', async () => {
    const { teacher, pupil } = await setup();
    await createQuestion(pool, teacher.id, {
      topicCode: '1.2',
      active: true,
      approvalStatus: 'approved',
    });
    const other = await createUser(pool, { role: 'pupil' });
    const actor = { id: pupil.id, role: 'pupil' as const };
    const { attemptId } = await service.startTopicSet(actor, '1.2');
    await expect(
      service.getAttemptForActor({ id: other.id, role: 'pupil' }, attemptId),
    ).rejects.toBeInstanceOf(AttemptAccessError);
  });

  it('admin can view any attempt', async () => {
    const { teacher, pupil } = await setup();
    await createQuestion(pool, teacher.id, {
      topicCode: '1.2',
      active: true,
      approvalStatus: 'approved',
    });
    const admin = await createUser(pool, { role: 'admin' });
    const { attemptId } = await service.startTopicSet({ id: pupil.id, role: 'pupil' }, '1.2');
    const bundle = await service.getAttemptForActor({ id: admin.id, role: 'admin' }, attemptId);
    expect(bundle.attempt.id).toBe(attemptId);
  });
});

describe('AttemptService.submitQuestion — final-question finishes the attempt', () => {
  async function twoQuestionAttempt(): Promise<{
    pupil: { id: string };
    attemptId: string;
    partIds: { q1Objective: string; q2Open: string };
    questionIds: { q1: string; q2: string };
  }> {
    const { teacher, pupil } = await setup();
    const cls = await pool.query<{ id: string }>(
      `SELECT id::text FROM classes WHERE teacher_id = $1::bigint LIMIT 1`,
      [teacher.id],
    );
    await pool.query(`UPDATE classes SET topic_set_size = 2 WHERE id = $1::bigint`, [
      cls.rows[0]!.id,
    ]);
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
    await createQuestion(pool, teacher.id, {
      topicCode: '1.2',
      active: true,
      approvalStatus: 'approved',
      parts: [
        {
          label: '(a)',
          prompt: 'Explain at length.',
          marks: 4,
          expectedResponseType: 'extended_response',
        },
      ],
    });
    const actor = { id: pupil.id, role: 'pupil' as const };
    const { attemptId } = await service.startTopicSet(actor, '1.2', 'per_question');
    const bundle = (await attemptRepo.loadAttemptBundle(attemptId))!;
    // Questions are picked in random order by startTopicSet; locate each
    // question by the response type of its (single) part.
    const objectiveQ = bundle.questions.find(
      (q) => bundle.partsByQuestion.get(q.id)![0]!.expected_response_type === 'multiple_choice',
    )!;
    const openQ = bundle.questions.find(
      (q) => bundle.partsByQuestion.get(q.id)![0]!.expected_response_type === 'extended_response',
    )!;
    return {
      pupil,
      attemptId,
      questionIds: { q1: objectiveQ.id, q2: openQ.id },
      partIds: {
        q1Objective: bundle.partsByQuestion.get(objectiveQ.id)![0]!.id,
        q2Open: bundle.partsByQuestion.get(openQ.id)![0]!.id,
      },
    };
  }

  it('first submitQuestion does NOT finish the attempt; second one does', async () => {
    const { pupil, attemptId, questionIds, partIds } = await twoQuestionAttempt();
    const actor = { id: pupil.id, role: 'pupil' as const };

    // Answer Q1 correctly, then submit Q1.
    await service.saveAnswer(actor, attemptId, [
      { attemptPartId: partIds.q1Objective, rawAnswer: 'CPU' },
    ]);
    const first = await service.submitQuestion(actor, attemptId, questionIds.q1);
    expect(first.attemptFullySubmitted).toBe(false);
    expect(first.markedParts).toBe(1);
    expect(first.pendingParts).toBe(0);

    const midAttempt = await attemptRepo.findAttemptHeader(attemptId);
    expect(midAttempt!.submitted_at).toBeNull();

    // Answer Q2, submit — attempt should now be fully submitted.
    await service.saveAnswer(actor, attemptId, [
      { attemptPartId: partIds.q2Open, rawAnswer: 'A long-form answer.' },
    ]);
    const second = await service.submitQuestion(actor, attemptId, questionIds.q2);
    expect(second.attemptFullySubmitted).toBe(true);
    expect(second.markedParts).toBe(0);
    expect(second.pendingParts).toBe(1);

    const finalAttempt = await attemptRepo.findAttemptHeader(attemptId);
    expect(finalAttempt!.submitted_at).not.toBeNull();
  });

  it('objective parts get deterministic marks per question; open parts stay teacher_pending', async () => {
    const { pupil, attemptId, questionIds, partIds } = await twoQuestionAttempt();
    const actor = { id: pupil.id, role: 'pupil' as const };

    await service.saveAnswer(actor, attemptId, [
      { attemptPartId: partIds.q1Objective, rawAnswer: 'CPU' },
      { attemptPartId: partIds.q2Open, rawAnswer: 'A long-form answer.' },
    ]);
    await service.submitQuestion(actor, attemptId, questionIds.q1);
    await service.submitQuestion(actor, attemptId, questionIds.q2);

    const after = (await attemptRepo.loadAttemptBundle(attemptId))!;
    const awardedObjective = after.awardedByAttemptPart.get(partIds.q1Objective);
    expect(awardedObjective?.marker).toBe('deterministic');
    expect(awardedObjective?.marks_awarded).toBe(1);
    // Open part has no awarded_marks row yet — teacher must mark.
    expect(after.awardedByAttemptPart.has(partIds.q2Open)).toBe(false);
  });

  it('emits one attempt.question.submitted per question and exactly one attempt.submitted', async () => {
    const { pupil, attemptId, questionIds, partIds } = await twoQuestionAttempt();
    const actor = { id: pupil.id, role: 'pupil' as const };
    await service.saveAnswer(actor, attemptId, [
      { attemptPartId: partIds.q1Objective, rawAnswer: 'CPU' },
      { attemptPartId: partIds.q2Open, rawAnswer: 'Long answer.' },
    ]);
    await service.submitQuestion(actor, attemptId, questionIds.q1);
    await service.submitQuestion(actor, attemptId, questionIds.q2);

    const { rows } = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM audit_events
        WHERE actor_user_id = $1::bigint
        ORDER BY at ASC`,
      [pupil.id],
    );
    const types = rows.map((r) => r.event_type);
    expect(types.filter((t) => t === 'attempt.question.submitted').length).toBe(2);
    expect(types.filter((t) => t === 'attempt.submitted').length).toBe(1);
  });

  it('rejects re-submitting the same question', async () => {
    const { pupil, attemptId, questionIds, partIds } = await twoQuestionAttempt();
    const actor = { id: pupil.id, role: 'pupil' as const };
    await service.saveAnswer(actor, attemptId, [
      { attemptPartId: partIds.q1Objective, rawAnswer: 'CPU' },
    ]);
    await service.submitQuestion(actor, attemptId, questionIds.q1);
    await expect(service.submitQuestion(actor, attemptId, questionIds.q1)).rejects.toMatchObject({
      reason: 'question_already_submitted',
    });
  });
});
