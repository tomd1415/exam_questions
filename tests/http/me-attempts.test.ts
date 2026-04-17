import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../helpers/app.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createUser, createQuestion, type CreatedUser } from '../helpers/fixtures.js';
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

async function loginAs(user: CreatedUser): Promise<ReturnType<typeof newJar>> {
  const jar = newJar();
  const getLogin = await app.inject({ method: 'GET', url: '/login' });
  updateJar(jar, getLogin);
  const token = extractCsrfToken(getLogin.payload);
  const res = await app.inject({
    method: 'POST',
    url: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
    payload: form({ username: user.username, password: user.password, _csrf: token }),
  });
  expect(res.statusCode).toBe(302);
  updateJar(jar, res);
  return jar;
}

async function seedAttemptFor(
  teacher: CreatedUser,
  pupil: CreatedUser,
  topicCode: string,
): Promise<{ classId: string; attemptId: string }> {
  const pool = getSharedPool();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO classes (name, teacher_id, academic_year)
     VALUES ($1, $2::bigint, '2025/26') RETURNING id::text`,
    [`Me-attempts ${topicCode}`, teacher.id],
  );
  const classId = rows[0]!.id;
  await pool.query(`INSERT INTO enrolments (class_id, user_id) VALUES ($1::bigint, $2::bigint)`, [
    classId,
    pupil.id,
  ]);
  await pool.query(
    `INSERT INTO class_assigned_topics (class_id, topic_code, assigned_by)
     VALUES ($1::bigint, $2, $3::bigint)`,
    [classId, topicCode, teacher.id],
  );
  await createQuestion(pool, teacher.id, {
    topicCode,
    subtopicCode: `${topicCode}.1`,
    active: true,
    approvalStatus: 'approved',
    parts: [
      {
        label: '(a)',
        prompt: 'Describe.',
        marks: 2,
        expectedResponseType: 'short_text',
      },
    ],
  });

  const pupilJar = await loginAs(pupil);
  const topics = await app.inject({
    method: 'GET',
    url: '/topics',
    headers: { cookie: cookieHeader(pupilJar) },
  });
  updateJar(pupilJar, topics);
  const csrfStart = extractCsrfToken(topics.payload);
  const start = await app.inject({
    method: 'POST',
    url: `/topics/${topicCode}/start`,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: cookieHeader(pupilJar),
    },
    payload: form({ _csrf: csrfStart }),
  });
  expect(start.statusCode).toBe(302);
  const attemptId = start.headers.location!.split('/').pop()!;
  return { classId, attemptId };
}

describe('GET /me/attempts (Chunk 6b)', () => {
  it('redirects unauthenticated to /login', async () => {
    const res = await app.inject({ method: 'GET', url: '/me/attempts' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('returns 403 to teachers', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: '/me/attempts',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('shows the signed-in pupil their own attempt and not another pupil\u2019s', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const pupilA = await createUser(getSharedPool(), { role: 'pupil' });
    const pupilB = await createUser(getSharedPool(), { role: 'pupil' });
    const a = await seedAttemptFor(teacher, pupilA, '1.3');
    const b = await seedAttemptFor(teacher, pupilB, '1.4');

    const jar = await loginAs(pupilA);
    const res = await app.inject({
      method: 'GET',
      url: '/me/attempts',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain(`/attempts/${a.attemptId}`);
    expect(res.payload).not.toContain(`/attempts/${b.attemptId}`);
  });
});
