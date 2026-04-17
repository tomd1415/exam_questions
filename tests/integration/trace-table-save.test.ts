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

describe('trace_table: pipe-separated grid round-trips via save + submit', () => {
  it('stores the verbatim string and marks the part as teacher_pending', async () => {
    const pool = getSharedPool();
    const teacher = await createUser(pool, { role: 'teacher' });
    const pupil = await createUser(pool, { role: 'pupil' });
    const { rows: clsRows } = await pool.query<{ id: string }>(
      `INSERT INTO classes (name, teacher_id, academic_year)
       VALUES ('Trace table test', $1::bigint, '2025/26') RETURNING id::text`,
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
      [classId, '2.1', teacher.id],
    );

    await createQuestion(pool, teacher.id, {
      componentCode: 'J277/02',
      topicCode: '2.1',
      subtopicCode: '2.1.1',
      active: true,
      approvalStatus: 'approved',
      stem: 'Complete the trace table.',
      expectedResponseType: 'trace_table',
      parts: [
        {
          label: '(a)',
          prompt: 'Trace this algorithm.',
          marks: 3,
          expectedResponseType: 'trace_table',
        },
      ],
    });

    const actor = { id: pupil.id, role: 'pupil' as const };
    const { attemptId } = await app.services.attempts.startTopicSet(actor, '2.1');

    const { rows: partRows } = await pool.query<{ id: string }>(
      `SELECT ap.id::text
         FROM attempt_parts ap
         JOIN attempt_questions aq ON aq.id = ap.attempt_question_id
        WHERE aq.attempt_id = $1::bigint
        ORDER BY ap.id ASC`,
      [attemptId],
    );
    expect(partRows.length).toBe(1);
    const attemptPartId = partRows[0]!.id;

    const gridAnswer = 'x | y | output\n1 | 2 | 3\n2 | 5 | 7';

    // Save → submit, mimicking the HTTP flow.
    await app.services.attempts.saveAnswer(actor, attemptId, [
      { attemptPartId, rawAnswer: gridAnswer },
    ]);
    await app.services.attempts.submitAttempt(actor, attemptId);

    const { rows: saved } = await pool.query<{ raw_answer: string }>(
      `SELECT raw_answer FROM attempt_parts WHERE id = $1::bigint`,
      [attemptPartId],
    );
    expect(saved[0]?.raw_answer).toBe(gridAnswer);

    const { rows: awarded } = await pool.query<{ marker: string; marks_awarded: number }>(
      `SELECT marker, marks_awarded FROM awarded_marks WHERE attempt_part_id = $1::bigint`,
      [attemptPartId],
    );
    // Open type: teacher will mark it; no deterministic row is written.
    expect(awarded).toHaveLength(0);

    const { rows: attemptRow } = await pool.query<{ submitted_at: Date | null }>(
      `SELECT submitted_at FROM attempts WHERE id = $1::bigint`,
      [attemptId],
    );
    expect(attemptRow[0]?.submitted_at).not.toBeNull();
  });
});
