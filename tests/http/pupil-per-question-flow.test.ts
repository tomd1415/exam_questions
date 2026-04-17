import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../helpers/app.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createQuestion, createUser, type CreatedUser } from '../helpers/fixtures.js';
import { cookieHeader, extractCsrfToken, newJar, updateJar } from '../helpers/cookies.js';

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

async function seedClassWithTwoQuestions(params: {
  teacher: CreatedUser;
  pupil: CreatedUser;
}): Promise<void> {
  const p = pool();
  const { rows } = await p.query<{ id: string }>(
    `INSERT INTO classes (name, teacher_id, academic_year)
     VALUES ('Per-question flow test', $1::bigint, '2025/26') RETURNING id::text`,
    [params.teacher.id],
  );
  const classId = rows[0]!.id;
  await p.query(`INSERT INTO enrolments (class_id, user_id) VALUES ($1::bigint, $2::bigint)`, [
    classId,
    params.pupil.id,
  ]);
  await p.query(
    `INSERT INTO class_assigned_topics (class_id, topic_code, assigned_by)
     VALUES ($1::bigint, '1.2', $2::bigint)`,
    [classId, params.teacher.id],
  );
  await p.query(`UPDATE classes SET topic_set_size = 2 WHERE id = $1::bigint`, [classId]);

  // Q1 — objective, marks awarded automatically on submit
  await createQuestion(p, params.teacher.id, {
    topicCode: '1.2',
    active: true,
    approvalStatus: 'approved',
    parts: [
      {
        label: '(a)',
        prompt: 'Pick the correct one.',
        marks: 1,
        expectedResponseType: 'multiple_choice',
        markPoints: [{ text: 'CPU', marks: 1 }],
      },
    ],
  });
  // Q2 — open response, stays teacher_pending until the teacher marks
  await createQuestion(p, params.teacher.id, {
    topicCode: '1.2',
    active: true,
    approvalStatus: 'approved',
    parts: [
      {
        label: '(a)',
        prompt: 'Explain mesh topology.',
        marks: 3,
        expectedResponseType: 'medium_text',
        markPoints: [{ text: 'every node connected', marks: 1 }],
      },
    ],
  });
}

async function getAttemptPartIds(
  jar: ReturnType<typeof newJar>,
  url: string,
): Promise<{ csrf: string; partIds: string[]; questionAction: string | null }> {
  const res = await app.inject({ method: 'GET', url, headers: { cookie: cookieHeader(jar) } });
  expect(res.statusCode).toBe(200);
  updateJar(jar, res);
  const partMatches = [...res.payload.matchAll(/name="part_(\d+)"/g)].map((m) => m[1]!);
  const actionMatch = /action="(\/attempts\/\d+\/questions\/\d+\/submit)"/.exec(res.payload);
  return {
    csrf: extractCsrfToken(res.payload),
    partIds: partMatches,
    questionAction: actionMatch?.[1] ?? null,
  };
}

describe('Pupil per-question reveal-mode happy path', () => {
  it('start → save on Q1 → submit Q1 → submit Q2 → final review', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    await seedClassWithTwoQuestions({ teacher, pupil });

    // Pupil defaults to per_question; start the topic-set attempt.
    const jar = await loginAs(pupil);
    const topics = await app.inject({
      method: 'GET',
      url: '/topics',
      headers: { cookie: cookieHeader(jar) },
    });
    updateJar(jar, topics);
    const csrfStart = extractCsrfToken(topics.payload);
    const start = await app.inject({
      method: 'POST',
      url: '/topics/1.2/start',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ _csrf: csrfStart }),
    });
    expect(start.statusCode).toBe(302);
    updateJar(jar, start);
    const attemptUrl = start.headers.location!;
    expect(attemptUrl).toMatch(/^\/attempts\/\d+$/);
    const attemptId = attemptUrl.split('/').pop()!;

    // Confirm attempt is per_question
    const attempt = await pool().query<{ reveal_mode: string }>(
      `SELECT reveal_mode FROM attempts WHERE id = $1::bigint`,
      [attemptId],
    );
    expect(attempt.rows[0]?.reveal_mode).toBe('per_question');

    // Load edit page: should render Q1 only, with question-scoped submit action.
    const q1 = await getAttemptPartIds(jar, attemptUrl);
    expect(q1.partIds.length).toBeGreaterThan(0);
    expect(q1.questionAction).not.toBeNull();
    const q1PartId = q1.partIds[0]!;

    // Save progress on Q1 (hits /save, NOT the question submit).
    const save = await app.inject({
      method: 'POST',
      url: `${attemptUrl}/save`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ _csrf: q1.csrf, [`part_${q1PartId}`]: 'CPU' }),
    });
    expect(save.statusCode).toBe(302);
    expect(decodeURIComponent(save.headers.location!)).toContain('Saved 1 answer');
    updateJar(jar, save);

    // Reopen; answer restored, Q1 still editable.
    const reopened = await getAttemptPartIds(jar, attemptUrl);
    expect(reopened.partIds).toContain(q1PartId);

    // Submit Q1 via the question-scoped endpoint.
    const submitQ1 = await app.inject({
      method: 'POST',
      url: reopened.questionAction!,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ _csrf: reopened.csrf, [`part_${q1PartId}`]: 'CPU' }),
    });
    expect(submitQ1.statusCode).toBe(302);
    expect(decodeURIComponent(submitQ1.headers.location!)).toContain('Question submitted');
    updateJar(jar, submitQ1);

    // attempt_questions.submitted_at for Q1 is now set; Q2 still null.
    const qStates = await pool().query<{ submitted_at: Date | null; display_order: number }>(
      `SELECT submitted_at, display_order FROM attempt_questions
        WHERE attempt_id = $1::bigint ORDER BY display_order`,
      [attemptId],
    );
    expect(qStates.rows).toHaveLength(2);
    expect(qStates.rows[0]!.submitted_at).not.toBeNull();
    expect(qStates.rows[1]!.submitted_at).toBeNull();

    // Attempt itself is NOT fully submitted yet.
    const midAttempt = await pool().query<{ submitted_at: Date | null }>(
      `SELECT submitted_at FROM attempts WHERE id = $1::bigint`,
      [attemptId],
    );
    expect(midAttempt.rows[0]!.submitted_at).toBeNull();

    // Navigate to Q2 (the UI's "Next unsubmitted").
    const q2 = await getAttemptPartIds(jar, attemptUrl);
    expect(q2.partIds.length).toBeGreaterThan(0);
    expect(q2.questionAction).not.toBeNull();
    // Q2 part id must differ from Q1's.
    expect(q2.partIds[0]).not.toBe(q1PartId);
    const q2PartId = q2.partIds[0]!;

    // Submit Q2 — this should also mark the attempt fully submitted.
    const submitQ2 = await app.inject({
      method: 'POST',
      url: q2.questionAction!,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ _csrf: q2.csrf, [`part_${q2PartId}`]: 'Every node connected to every other.' }),
    });
    expect(submitQ2.statusCode).toBe(302);
    expect(decodeURIComponent(submitQ2.headers.location!)).toContain('All questions submitted');
    updateJar(jar, submitQ2);

    // Attempt is now fully submitted.
    const finalAttempt = await pool().query<{ submitted_at: Date | null }>(
      `SELECT submitted_at FROM attempts WHERE id = $1::bigint`,
      [attemptId],
    );
    expect(finalAttempt.rows[0]!.submitted_at).not.toBeNull();

    // Review page renders with a Score.
    const review = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(review.statusCode).toBe(200);
    expect(review.payload).toContain('review');
    expect(review.payload).toContain('Score:');

    // Audit events: attempt.started, attempt.question.submitted (×2), attempt.submitted (×1),
    // marking.completed (at least one — fires on the final submitAttempt path).
    const audit = await pool().query<{ event_type: string }>(
      `SELECT event_type FROM audit_events WHERE actor_user_id = $1::bigint ORDER BY at ASC`,
      [pupil.id],
    );
    const types = audit.rows.map((r) => r.event_type);
    expect(types).toContain('attempt.started');
    expect(types.filter((t) => t === 'attempt.question.submitted').length).toBe(2);
    expect(types).toContain('attempt.submitted');
  });

  it('POSTing /attempts/:id/save leaves attempt_questions.submitted_at untouched', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    await seedClassWithTwoQuestions({ teacher, pupil });

    const jar = await loginAs(pupil);
    const topics = await app.inject({
      method: 'GET',
      url: '/topics',
      headers: { cookie: cookieHeader(jar) },
    });
    updateJar(jar, topics);
    const start = await app.inject({
      method: 'POST',
      url: '/topics/1.2/start',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ _csrf: extractCsrfToken(topics.payload) }),
    });
    updateJar(jar, start);
    const attemptUrl = start.headers.location!;
    const attemptId = attemptUrl.split('/').pop()!;

    const page = await getAttemptPartIds(jar, attemptUrl);
    await app.inject({
      method: 'POST',
      url: `${attemptUrl}/save`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ _csrf: page.csrf, [`part_${page.partIds[0]!}`]: 'CPU' }),
    });

    const rows = (
      await pool().query<{ submitted_at: Date | null }>(
        `SELECT submitted_at FROM attempt_questions WHERE attempt_id = $1::bigint`,
        [attemptId],
      )
    ).rows;
    expect(rows.every((r) => r.submitted_at === null)).toBe(true);
  });
});
