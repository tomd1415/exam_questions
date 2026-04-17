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

async function seedSubmittedAttempt(params: {
  teacher: CreatedUser;
  pupil: CreatedUser;
  topicCode: string;
  className: string;
}): Promise<{ classId: string; attemptId: string }> {
  const pool = getSharedPool();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO classes (name, teacher_id, academic_year)
     VALUES ($1, $2::bigint, '2025/26') RETURNING id::text`,
    [params.className, params.teacher.id],
  );
  const classId = rows[0]!.id;
  await pool.query(`INSERT INTO enrolments (class_id, user_id) VALUES ($1::bigint, $2::bigint)`, [
    classId,
    params.pupil.id,
  ]);
  await pool.query(
    `INSERT INTO class_assigned_topics (class_id, topic_code, assigned_by)
     VALUES ($1::bigint, $2, $3::bigint)`,
    [classId, params.topicCode, params.teacher.id],
  );
  await createQuestion(pool, params.teacher.id, {
    topicCode: params.topicCode,
    subtopicCode: `${params.topicCode}.1`,
    active: true,
    approvalStatus: 'approved',
    parts: [
      {
        label: '(a)',
        prompt: 'Explain.',
        marks: 4,
        expectedResponseType: 'extended_response',
      },
    ],
  });

  const pupilJar = await loginAs(params.pupil);
  const topics = await app.inject({
    method: 'GET',
    url: '/topics',
    headers: { cookie: cookieHeader(pupilJar) },
  });
  updateJar(pupilJar, topics);
  const csrfStart = extractCsrfToken(topics.payload);
  const start = await app.inject({
    method: 'POST',
    url: `/topics/${params.topicCode}/start`,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: cookieHeader(pupilJar),
    },
    payload: form({ _csrf: csrfStart }),
  });
  expect(start.statusCode).toBe(302);
  const attemptUrl = start.headers.location!;
  updateJar(pupilJar, start);
  const attemptId = attemptUrl.split('/').pop()!;

  const editPage = await app.inject({
    method: 'GET',
    url: attemptUrl,
    headers: { cookie: cookieHeader(pupilJar) },
  });
  expect(editPage.statusCode).toBe(200);
  updateJar(pupilJar, editPage);
  const csrfSubmit = extractCsrfToken(editPage.payload);
  const partIds = Array.from(editPage.payload.matchAll(/name="part_(\d+)"/g)).map((m) => m[1]!);
  const submit = await app.inject({
    method: 'POST',
    url: `${attemptUrl}/submit`,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: cookieHeader(pupilJar),
    },
    payload: form({ _csrf: csrfSubmit, [`part_${partIds[0]!}`]: 'An essay answer.' }),
  });
  expect(submit.statusCode).toBe(302);
  return { classId, attemptId };
}

describe('GET /admin/attempts — teacher marking queue (Chunk 6b)', () => {
  it('redirects unauthenticated to /login', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/attempts' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('returns 403 to pupils', async () => {
    const pupil = await createUser(getSharedPool(), { role: 'pupil' });
    const jar = await loginAs(pupil);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/attempts',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('teacher sees attempts across all their classes, not other teachers\u2019 classes', async () => {
    const teacherA = await createUser(getSharedPool(), { role: 'teacher' });
    const teacherB = await createUser(getSharedPool(), { role: 'teacher' });
    const pupil1 = await createUser(getSharedPool(), { role: 'pupil' });
    const pupil2 = await createUser(getSharedPool(), { role: 'pupil' });
    const pupilOther = await createUser(getSharedPool(), { role: 'pupil' });

    const a1 = await seedSubmittedAttempt({
      teacher: teacherA,
      pupil: pupil1,
      topicCode: '1.2',
      className: 'Class A1',
    });
    const a2 = await seedSubmittedAttempt({
      teacher: teacherA,
      pupil: pupil2,
      topicCode: '1.3',
      className: 'Class A2',
    });
    const bOther = await seedSubmittedAttempt({
      teacher: teacherB,
      pupil: pupilOther,
      topicCode: '1.4',
      className: 'Class B',
    });

    const jar = await loginAs(teacherA);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/attempts',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain(`/admin/attempts/${a1.attemptId}`);
    expect(res.payload).toContain(`/admin/attempts/${a2.attemptId}`);
    expect(res.payload).not.toContain(`/admin/attempts/${bOther.attemptId}`);
    expect(res.payload).toContain('Class A1');
    expect(res.payload).toContain('Class A2');
    expect(res.payload).not.toContain('Class B');
  });

  it('teacher with no pending work sees the empty state, not a 403', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/attempts',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('Nothing waiting');
  });
});
