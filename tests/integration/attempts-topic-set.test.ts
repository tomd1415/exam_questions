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

async function setupPupilWithTopic(topicCode = '1.2'): Promise<{
  teacher: { id: string };
  pupil: { id: string };
  classId: string;
}> {
  const teacher = await createUser(pool, { role: 'teacher' });
  const pupil = await createUser(pool, { role: 'pupil' });
  const cls = await classRepo.createClass({
    name: 'Test class',
    teacherId: teacher.id,
    academicYear: '2025/26',
  });
  await classRepo.addEnrolment(cls.id, pupil.id);
  await classRepo.assignTopic(cls.id, topicCode, teacher.id);
  return { teacher, pupil, classId: cls.id };
}

describe('AttemptService.startTopicSet — picker filters', () => {
  it('creates an attempt with parts skeleton when eligible questions exist', async () => {
    const { teacher, pupil } = await setupPupilWithTopic('1.2');
    await createQuestion(pool, teacher.id, {
      topicCode: '1.2',
      subtopicCode: '1.2.1',
      active: true,
      approvalStatus: 'approved',
      parts: [
        {
          label: '(a)',
          prompt: 'Describe X.',
          marks: 2,
          expectedResponseType: 'short_text',
          markPoints: [{ text: 'X', marks: 2 }],
        },
        {
          label: '(b)',
          prompt: 'Explain Y.',
          marks: 3,
          expectedResponseType: 'medium_text',
        },
      ],
    });

    const result = await service.startTopicSet({ id: pupil.id, role: 'pupil' }, '1.2');
    expect(result.questionCount).toBe(1);
    const bundle = await attemptRepo.loadAttemptBundle(result.attemptId);
    expect(bundle?.questions).toHaveLength(1);
    const parts = bundle?.partsByQuestion.get(bundle.questions[0]!.id) ?? [];
    expect(parts).toHaveLength(2);
    expect(parts.every((p) => p.raw_answer === '')).toBe(true);
    expect(parts.every((p) => p.submitted_at === null)).toBe(true);
  });

  it('excludes non-approved, inactive, and off-topic questions', async () => {
    const { teacher, pupil } = await setupPupilWithTopic('1.2');
    await createQuestion(pool, teacher.id, {
      topicCode: '1.2',
      active: false,
      approvalStatus: 'approved',
    });
    await createQuestion(pool, teacher.id, {
      topicCode: '1.2',
      active: true,
      approvalStatus: 'draft',
    });
    await createQuestion(pool, teacher.id, {
      topicCode: '1.3',
      subtopicCode: '1.3.1',
      active: true,
      approvalStatus: 'approved',
    });
    await createQuestion(pool, teacher.id, {
      topicCode: '1.2',
      active: true,
      approvalStatus: 'approved',
    });

    const result = await service.startTopicSet({ id: pupil.id, role: 'pupil' }, '1.2');
    const bundle = await attemptRepo.loadAttemptBundle(result.attemptId);
    expect(bundle?.questions).toHaveLength(1);
    expect(bundle?.questions[0]!.topic_code).toBe('1.2');
  });

  it('throws no_questions (atomic) when no eligible questions exist', async () => {
    const { teacher, pupil } = await setupPupilWithTopic('1.2');
    await createQuestion(pool, teacher.id, {
      topicCode: '1.2',
      active: false,
      approvalStatus: 'approved',
    });

    await expect(
      service.startTopicSet({ id: pupil.id, role: 'pupil' }, '1.2'),
    ).rejects.toMatchObject({ reason: 'no_questions' });

    const { rowCount } = await pool.query(`SELECT 1 FROM attempts`);
    expect(rowCount).toBe(0);
  });

  it('throws not_enrolled when pupil is not enrolled in a class assigned the topic', async () => {
    const pupil = await createUser(pool, { role: 'pupil' });
    await expect(
      service.startTopicSet({ id: pupil.id, role: 'pupil' }, '1.2'),
    ).rejects.toBeInstanceOf(AttemptAccessError);
  });

  it('throws not_pupil when actor is a teacher', async () => {
    const teacher = await createUser(pool, { role: 'teacher' });
    await expect(
      service.startTopicSet({ id: teacher.id, role: 'teacher' }, '1.2'),
    ).rejects.toMatchObject({ reason: 'not_pupil' });
  });

  it('caps question count at topic_set_size', async () => {
    const { teacher, pupil, classId } = await setupPupilWithTopic('1.2');
    await pool.query(`UPDATE classes SET topic_set_size = 2 WHERE id = $1::bigint`, [classId]);
    for (let i = 0; i < 5; i++) {
      await createQuestion(pool, teacher.id, {
        topicCode: '1.2',
        active: true,
        approvalStatus: 'approved',
      });
    }
    const result = await service.startTopicSet({ id: pupil.id, role: 'pupil' }, '1.2');
    expect(result.questionCount).toBe(2);
  });
});
