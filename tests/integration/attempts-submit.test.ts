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
