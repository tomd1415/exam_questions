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

async function seedClassWithMixedQuestion(params: {
  teacher: CreatedUser;
  pupil: CreatedUser;
  topicCode: string;
}): Promise<void> {
  const p = pool();
  const { rows } = await p.query<{ id: string }>(
    `INSERT INTO classes (name, teacher_id, academic_year)
     VALUES ('Review v2 test', $1::bigint, '2025/26') RETURNING id::text`,
    [params.teacher.id],
  );
  const classId = rows[0]!.id;
  await p.query(`INSERT INTO enrolments (class_id, user_id) VALUES ($1::bigint, $2::bigint)`, [
    classId,
    params.pupil.id,
  ]);
  await p.query(
    `INSERT INTO class_assigned_topics (class_id, topic_code, assigned_by)
     VALUES ($1::bigint, $2, $3::bigint)`,
    [classId, params.topicCode, params.teacher.id],
  );
  await createQuestion(p, params.teacher.id, {
    topicCode: params.topicCode,
    subtopicCode: `${params.topicCode}.1`,
    active: true,
    approvalStatus: 'approved',
    parts: [
      {
        label: '(a)',
        prompt: 'Pick the correct component.',
        marks: 1,
        expectedResponseType: 'multiple_choice',
        markPoints: [{ text: 'CPU', marks: 1 }],
      },
      {
        label: '(b)',
        prompt: 'Explain how fetch–decode–execute works.',
        marks: 6,
        expectedResponseType: 'extended_response',
        markPoints: [{ text: 'Teacher-only rubric bullet.', marks: 3 }],
      },
    ],
  });
}

async function startAndSubmit(
  pupil: CreatedUser,
  answers: Record<string, string>,
): Promise<{ attemptUrl: string; jar: ReturnType<typeof newJar> }> {
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
  const attemptUrl = start.headers.location!;
  updateJar(jar, start);

  const editPage = await app.inject({
    method: 'GET',
    url: attemptUrl,
    headers: { cookie: cookieHeader(jar) },
  });
  expect(editPage.statusCode).toBe(200);
  updateJar(jar, editPage);
  const csrfSubmit = extractCsrfToken(editPage.payload);

  const partIds = Array.from(editPage.payload.matchAll(/name="part_(\d+)"/g)).map((m) => m[1]!);
  expect(partIds.length).toBeGreaterThan(0);
  const payload: Record<string, string> = { _csrf: csrfSubmit };
  for (let i = 0; i < partIds.length; i++) {
    const answer = answers[String(i)] ?? '';
    payload[`part_${partIds[i]!}`] = answer;
  }
  const submit = await app.inject({
    method: 'POST',
    url: `${attemptUrl}/submit`,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: cookieHeader(jar),
    },
    payload: form(payload),
  });
  expect(submit.statusCode).toBe(302);
  updateJar(jar, submit);
  return { attemptUrl, jar };
}

describe('Pupil review v2 layout (Chunk 5)', () => {
  it('renders pupil-col, model-col, and mark-points-grid for an awarded objective part', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    await seedClassWithMixedQuestion({ teacher, pupil, topicCode: '1.2' });

    const { attemptUrl, jar } = await startAndSubmit(pupil, { 0: 'CPU', 1: 'Essay.' });
    const review = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(review.statusCode).toBe(200);

    const html = review.payload;
    expect(html).toContain('class="review-columns"');
    expect(html).toContain('class="pupil-col"');
    expect(html).toContain('class="model-col"');
    expect(html).toContain('class="mark-points-grid"');
    expect(html).toContain('mp--hit');
    expect(html).toContain('Your answer:');
    expect(html).toContain('Model answer:');
  });

  it('renders a miss badge when the pupil answered the objective part incorrectly', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    await seedClassWithMixedQuestion({ teacher, pupil, topicCode: '1.2' });

    const { attemptUrl, jar } = await startAndSubmit(pupil, { 0: 'RAM', 1: 'Essay.' });
    const review = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(review.statusCode).toBe(200);
    expect(review.payload).toContain('class="mark-points-grid"');
    expect(review.payload).toContain('mp--miss');
  });

  it('open parts show model-col with marking criteria and no hit/miss grid', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    await seedClassWithMixedQuestion({ teacher, pupil, topicCode: '1.2' });

    const { attemptUrl, jar } = await startAndSubmit(pupil, { 0: 'CPU', 1: 'My essay.' });
    const review = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(review.statusCode).toBe(200);
    const html = review.payload;

    // The open part lives below the objective part in the same review. Both
    // render the two-column shell. Only the awarded objective part emits
    // a mark-points-grid — count occurrences to confirm.
    const gridMatches = html.match(/class="mark-points-grid"/g) ?? [];
    expect(gridMatches.length).toBe(1);

    expect(html).toContain('Marking criteria:');
    expect(html).toContain('self-estimate');
  });

  it('pupil answer preserves newlines inside the pupil-col pre block', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    await seedClassWithMixedQuestion({ teacher, pupil, topicCode: '1.2' });

    const multiline = 'Line one.\nLine two.\nLine three.';
    const { attemptUrl, jar } = await startAndSubmit(pupil, { 0: 'CPU', 1: multiline });
    const review = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(review.statusCode).toBe(200);
    expect(review.payload).toContain('Line one.');
    expect(review.payload).toContain('Line two.');
    expect(review.payload).toContain('Line three.');
    expect(review.payload).toContain('class="review-col__answer"');
  });
});
