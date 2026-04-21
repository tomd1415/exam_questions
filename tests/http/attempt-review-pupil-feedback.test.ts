import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../helpers/app.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createQuestion, createUser, type CreatedUser } from '../helpers/fixtures.js';
import { cookieHeader, extractCsrfToken, newJar, updateJar } from '../helpers/cookies.js';

// Chunk 3e end-to-end surface: once the teacher has cleared a
// safety-flagged AI mark out of moderation, the pupil's review
// page renders three feedback blocks + a badge. This test seeds
// the database directly (bypassing the LLM call) so we can pin the
// state machine exactly: llm/accepted, llm/pending, teacher_override.
//
// Reading-level fallback substitution and per-part fallback
// precedence are covered here too — they are not a hypothetical
// future concern but the load-bearing safety net that means we
// never show a pupil a paragraph that reads above GCSE level.

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

function form(record: Record<string, string>): string {
  return Object.entries(record)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

function pool(): ReturnType<typeof getSharedPool> {
  return getSharedPool();
}

async function loginAs(user: CreatedUser): Promise<ReturnType<typeof newJar>> {
  const jar = newJar();
  const getLogin = await app.inject({ method: 'GET', url: '/login' });
  updateJar(jar, getLogin);
  const token = extractCsrfToken(getLogin.payload);
  const res = await app.inject({
    method: 'POST',
    url: '/login',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: cookieHeader(jar),
    },
    payload: form({ username: user.username, password: user.password, _csrf: token }),
  });
  expect(res.statusCode).toBe(302);
  updateJar(jar, res);
  return jar;
}

interface Seed {
  pupil: CreatedUser;
  teacher: CreatedUser;
  attemptId: string;
  attemptPartId: string;
  questionPartId: string;
  partMarks: number;
}

async function seedSubmittedAttempt(fallbackText: string | null = null): Promise<Seed> {
  const p = pool();
  const teacher = await createUser(p, { role: 'teacher' });
  const pupil = await createUser(p, { role: 'pupil' });
  const { rows: cls } = await p.query<{ id: string }>(
    `INSERT INTO classes (name, teacher_id, academic_year)
     VALUES ('Feedback review test', $1::bigint, '2025/26') RETURNING id::text`,
    [teacher.id],
  );
  const classId = cls[0]!.id;
  await p.query(`INSERT INTO enrolments (class_id, user_id) VALUES ($1::bigint, $2::bigint)`, [
    classId,
    pupil.id,
  ]);
  const question = await createQuestion(p, teacher.id, {
    topicCode: '1.2',
    active: true,
    approvalStatus: 'approved',
    modelAnswer: 'The CPU executes instructions; the GPU renders pixels.',
    parts: [
      {
        label: '(a)',
        prompt: 'Explain the difference between the CPU and the GPU.',
        marks: 4,
        expectedResponseType: 'medium_text',
        markPoints: [
          { text: 'CPU executes instructions', marks: 2 },
          { text: 'GPU renders pixels', marks: 2 },
        ],
      },
    ],
  });
  const { rows: qpRows } = await p.query<{ id: string }>(
    `SELECT id::text FROM question_parts WHERE question_id = $1::bigint ORDER BY display_order`,
    [question.id],
  );
  const questionPartId = qpRows[0]!.id;
  if (fallbackText !== null) {
    await p.query(`UPDATE question_parts SET pupil_feedback_fallback = $2 WHERE id = $1::bigint`, [
      questionPartId,
      fallbackText,
    ]);
  }

  const { rows: aRows } = await p.query<{ id: string }>(
    `INSERT INTO attempts (user_id, class_id, target_topic_code, mode, submitted_at)
     VALUES ($1::bigint, $2::bigint, '1.2', 'topic_set', now())
     RETURNING id::text`,
    [pupil.id, classId],
  );
  const attemptId = aRows[0]!.id;
  const { rows: aqRows } = await p.query<{ id: string }>(
    `INSERT INTO attempt_questions (attempt_id, question_id, display_order, submitted_at)
     VALUES ($1::bigint, $2::bigint, 1, now())
     RETURNING id::text`,
    [attemptId, question.id],
  );
  const attemptQuestionId = aqRows[0]!.id;
  const { rows: apRows } = await p.query<{ id: string }>(
    `INSERT INTO attempt_parts (attempt_question_id, question_part_id, raw_answer, submitted_at)
     VALUES ($1::bigint, $2::bigint, 'CPU does things and GPU draws pixels.', now())
     RETURNING id::text`,
    [attemptQuestionId, questionPartId],
  );

  return {
    pupil,
    teacher,
    attemptId,
    attemptPartId: apRows[0]!.id,
    questionPartId,
    partMarks: 4,
  };
}

async function insertLlmAwardedMark(opts: {
  attemptPartId: string;
  moderationStatus: 'pending' | 'accepted' | 'not_required' | 'overridden';
  feedback: {
    what_went_well: string;
    how_to_gain_more: string;
    next_focus: string;
  } | null;
}): Promise<string> {
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO awarded_marks
       (attempt_part_id, marks_awarded, marks_total,
        mark_points_hit, mark_points_missed,
        marker, confidence, moderation_required, moderation_status,
        prompt_version, model_id, feedback_for_pupil)
     VALUES ($1::bigint, 2, 4, '{}'::bigint[], '{}'::bigint[],
             'llm', 0.82, $2, $3,
             'mark_open_response@test', 'gpt-5-mini', $4::jsonb)
     RETURNING id::text`,
    [
      opts.attemptPartId,
      opts.moderationStatus === 'pending',
      opts.moderationStatus,
      opts.feedback === null ? null : JSON.stringify(opts.feedback),
    ],
  );
  return rows[0]!.id;
}

async function insertOverride(
  attemptPartId: string,
  teacherId: string,
  reason: string,
): Promise<void> {
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO awarded_marks
       (attempt_part_id, marks_awarded, marks_total,
        mark_points_hit, mark_points_missed,
        marker, moderation_status)
     VALUES ($1::bigint, 4, 4, '{}'::bigint[], '{}'::bigint[],
             'teacher_override', 'not_required')
     RETURNING id::text`,
    [attemptPartId],
  );
  await pool().query(
    `INSERT INTO teacher_overrides (awarded_mark_id, teacher_id, new_marks_awarded, reason)
     VALUES ($1::bigint, $2::bigint, 4, $3)`,
    [rows[0]!.id, teacherId, reason],
  );
}

const PLAIN_FEEDBACK = {
  what_went_well: 'You named both the CPU and the GPU clearly.',
  how_to_gain_more: 'Say what each one does in short, plain sentences.',
  next_focus: 'Practise comparing the two with a short example each.',
};

const HARD_FEEDBACK = {
  what_went_well:
    'Your articulation of juxtaposed microprocessor functionalities ' +
    'contextualised operationally demonstrated sophistication beyond mere ' +
    'nomenclature, indicating methodical comparativism.',
  how_to_gain_more: 'Say what each one does.',
  next_focus: 'Practise comparing the CPU and GPU.',
};

describe('Pupil review: AI feedback blocks (Chunk 3e)', () => {
  it('shows three AI feedback blocks + "AI assistance" badge when the row is not_required', async () => {
    const seed = await seedSubmittedAttempt();
    await insertLlmAwardedMark({
      attemptPartId: seed.attemptPartId,
      moderationStatus: 'not_required',
      feedback: PLAIN_FEEDBACK,
    });
    const jar = await loginAs(seed.pupil);
    const res = await app.inject({
      method: 'GET',
      url: `/attempts/${seed.attemptId}`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('Marked with AI assistance');
    expect(res.payload).toContain('What went well');
    expect(res.payload).toContain('How to gain more marks');
    expect(res.payload).toContain('What to focus on next');
    expect(res.payload).toContain('named both the CPU and the GPU');
  });

  it('shows three AI feedback blocks when the row is accepted after moderation', async () => {
    const seed = await seedSubmittedAttempt();
    await insertLlmAwardedMark({
      attemptPartId: seed.attemptPartId,
      moderationStatus: 'accepted',
      feedback: PLAIN_FEEDBACK,
    });
    const jar = await loginAs(seed.pupil);
    const res = await app.inject({
      method: 'GET',
      url: `/attempts/${seed.attemptId}`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('Marked with AI assistance');
    expect(res.payload).toContain('named both the CPU and the GPU');
  });

  it('hides AI feedback while the row is still pending moderation', async () => {
    const seed = await seedSubmittedAttempt();
    await insertLlmAwardedMark({
      attemptPartId: seed.attemptPartId,
      moderationStatus: 'pending',
      feedback: PLAIN_FEEDBACK,
    });
    const jar = await loginAs(seed.pupil);
    const res = await app.inject({
      method: 'GET',
      url: `/attempts/${seed.attemptId}`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain('Marked with AI assistance');
    expect(res.payload).not.toContain('named both the CPU and the GPU');
  });

  it('substitutes the generic fallback when a feedback block reads too hard', async () => {
    const seed = await seedSubmittedAttempt();
    await insertLlmAwardedMark({
      attemptPartId: seed.attemptPartId,
      moderationStatus: 'not_required',
      feedback: HARD_FEEDBACK,
    });
    const jar = await loginAs(seed.pupil);
    const res = await app.inject({
      method: 'GET',
      url: `/attempts/${seed.attemptId}`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('Ask your teacher to talk this through');
    expect(res.payload).not.toContain('juxtaposed microprocessor functionalities');
    // The readable blocks still show verbatim.
    expect(res.payload).toContain('Say what each one does.');
  });

  it('prefers the per-part teacher-authored fallback over the generic prompt', async () => {
    const seed = await seedSubmittedAttempt(
      'Re-read pages 8–9 of the CPU workbook before retrying.',
    );
    await insertLlmAwardedMark({
      attemptPartId: seed.attemptPartId,
      moderationStatus: 'not_required',
      feedback: HARD_FEEDBACK,
    });
    const jar = await loginAs(seed.pupil);
    const res = await app.inject({
      method: 'GET',
      url: `/attempts/${seed.attemptId}`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('Re-read pages 8');
    expect(res.payload).not.toContain('Ask your teacher to talk this through');
  });

  it('hides AI feedback and surfaces the override reason when overridden', async () => {
    const seed = await seedSubmittedAttempt();
    await insertLlmAwardedMark({
      attemptPartId: seed.attemptPartId,
      moderationStatus: 'overridden',
      feedback: PLAIN_FEEDBACK,
    });
    await insertOverride(
      seed.attemptPartId,
      seed.teacher.id,
      'Full marks — both mark points are clearly hit.',
    );
    const jar = await loginAs(seed.pupil);
    const res = await app.inject({
      method: 'GET',
      url: `/attempts/${seed.attemptId}`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('Teacher-marked override');
    expect(res.payload).toContain('Full marks — both mark points are clearly hit.');
    expect(res.payload).not.toContain('Marked with AI assistance');
    expect(res.payload).not.toContain('named both the CPU and the GPU');
  });
});
