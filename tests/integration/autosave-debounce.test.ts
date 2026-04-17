import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildTestApp } from '../helpers/app.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createQuestion, createUser } from '../helpers/fixtures.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

beforeEach(async () => {
  await cleanDb();
});

afterAll(async () => {
  await app.close();
});

describe('savePartOne audit debounce', () => {
  it('records at most one attempt.part.saved event for a burst within the 60s window', async () => {
    const pool = getSharedPool();
    const teacher = await createUser(pool, { role: 'teacher' });
    const pupil = await createUser(pool, { role: 'pupil' });
    const { rows: clsRows } = await pool.query<{ id: string }>(
      `INSERT INTO classes (name, teacher_id, academic_year)
       VALUES ('Autosave debounce', $1::bigint, '2025/26') RETURNING id::text`,
      [teacher.id],
    );
    const classId = clsRows[0]!.id;
    await pool.query(`INSERT INTO enrolments (class_id, user_id) VALUES ($1::bigint, $2::bigint)`, [
      classId,
      pupil.id,
    ]);
    await pool.query(
      `INSERT INTO class_assigned_topics (class_id, topic_code, assigned_by)
       VALUES ($1::bigint, $2, $3::bigint)`,
      [classId, '1.2', teacher.id],
    );

    await createQuestion(pool, teacher.id, {
      topicCode: '1.2',
      active: true,
      approvalStatus: 'approved',
      parts: [
        {
          label: '(a)',
          prompt: 'Describe.',
          marks: 2,
          expectedResponseType: 'medium_text',
        },
      ],
    });

    const actor = { id: pupil.id, role: 'pupil' as const };
    const { attemptId } = await app.services.attempts.startTopicSet(actor, '1.2');

    const { rows: partRows } = await pool.query<{ id: string }>(
      `SELECT ap.id::text
         FROM attempt_parts ap
         JOIN attempt_questions aq ON aq.id = ap.attempt_question_id
        WHERE aq.attempt_id = $1::bigint
        ORDER BY ap.id ASC`,
      [attemptId],
    );
    const attemptPartId = partRows[0]!.id;

    await app.services.attempts.savePartOne(actor, attemptPartId, 'one');
    await app.services.attempts.savePartOne(actor, attemptPartId, 'one two');
    await app.services.attempts.savePartOne(actor, attemptPartId, 'one two three');

    const { rows: saved } = await pool.query<{ raw_answer: string }>(
      `SELECT raw_answer FROM attempt_parts WHERE id = $1::bigint`,
      [attemptPartId],
    );
    expect(saved[0]?.raw_answer).toBe('one two three');

    const { rows: auditRows } = await pool.query<{ event_type: string; details: unknown }>(
      `SELECT event_type, details
         FROM audit_events
        WHERE actor_user_id = $1::bigint
          AND event_type = 'attempt.part.saved'`,
      [pupil.id],
    );
    expect(auditRows).toHaveLength(1);
    expect((auditRows[0]!.details as { source?: string }).source).toBe('autosave');
  });

  it('refuses autosave for another pupil with not_owner', async () => {
    const pool = getSharedPool();
    const teacher = await createUser(pool, { role: 'teacher' });
    const owner = await createUser(pool, { role: 'pupil' });
    const intruder = await createUser(pool, { role: 'pupil' });
    const { rows: clsRows } = await pool.query<{ id: string }>(
      `INSERT INTO classes (name, teacher_id, academic_year)
       VALUES ('Autosave authz', $1::bigint, '2025/26') RETURNING id::text`,
      [teacher.id],
    );
    const classId = clsRows[0]!.id;
    await pool.query(`INSERT INTO enrolments (class_id, user_id) VALUES ($1::bigint, $2::bigint)`, [
      classId,
      owner.id,
    ]);
    await pool.query(
      `INSERT INTO class_assigned_topics (class_id, topic_code, assigned_by)
       VALUES ($1::bigint, $2, $3::bigint)`,
      [classId, '1.2', teacher.id],
    );

    await createQuestion(pool, teacher.id, {
      topicCode: '1.2',
      active: true,
      approvalStatus: 'approved',
      parts: [
        {
          label: '(a)',
          prompt: 'Describe.',
          marks: 2,
          expectedResponseType: 'medium_text',
        },
      ],
    });

    const ownerActor = { id: owner.id, role: 'pupil' as const };
    const { attemptId } = await app.services.attempts.startTopicSet(ownerActor, '1.2');

    const { rows: partRows } = await pool.query<{ id: string }>(
      `SELECT ap.id::text
         FROM attempt_parts ap
         JOIN attempt_questions aq ON aq.id = ap.attempt_question_id
        WHERE aq.attempt_id = $1::bigint
        ORDER BY ap.id ASC`,
      [attemptId],
    );
    const attemptPartId = partRows[0]!.id;

    const intruderActor = { id: intruder.id, role: 'pupil' as const };
    await expect(
      app.services.attempts.savePartOne(intruderActor, attemptPartId, 'mine now'),
    ).rejects.toMatchObject({ reason: 'not_owner' });
  });
});
