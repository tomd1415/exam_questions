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

async function seedClassWithQuestion(params: {
  teacher: CreatedUser;
  pupil: CreatedUser;
  topicCode: string;
}): Promise<string> {
  const p = pool();
  const { rows } = await p.query<{ id: string }>(
    `INSERT INTO classes (name, teacher_id, academic_year)
     VALUES ('Print test', $1::bigint, '2025/26') RETURNING id::text`,
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
        prompt: 'Explain the fetch cycle.',
        marks: 6,
        expectedResponseType: 'extended_response',
        markPoints: [{ text: 'Teacher-only rubric.', marks: 3 }],
      },
    ],
  });
  return classId;
}

async function startAndSubmit(
  pupil: CreatedUser,
  topicCode: string,
  answers: Record<string, string>,
): Promise<{ attemptUrl: string; attemptId: string; jar: ReturnType<typeof newJar> }> {
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
    url: `/topics/${encodeURIComponent(topicCode)}/start`,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: cookieHeader(jar),
    },
    payload: form({ _csrf: csrfStart }),
  });
  expect(start.statusCode).toBe(302);
  const attemptUrl = start.headers.location!;
  const attemptId = /\/attempts\/(\d+)/.exec(attemptUrl)![1]!;
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
  const payload: Record<string, string> = { _csrf: csrfSubmit };
  for (let i = 0; i < partIds.length; i++) {
    payload[`part_${partIds[i]!}`] = answers[String(i)] ?? '';
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
  return { attemptUrl, attemptId, jar };
}

describe('Print routes (Chunk 6)', () => {
  it('pupil can print their own attempt and always sees their answers', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    await seedClassWithQuestion({ teacher, pupil, topicCode: '1.2' });
    const { attemptUrl, jar } = await startAndSubmit(pupil, '1.2', {
      0: 'CPU',
      1: 'The CPU fetches, decodes and executes.',
    });

    // Pupil with answers=0 still sees their answers (pupil forced-on).
    const res = await app.inject({
      method: 'GET',
      url: `${attemptUrl}/print?answers=0`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('print-paper');
    expect(res.payload).toContain('CPU');
    expect(res.payload).toContain('The CPU fetches');
    // Print chrome: no site header, no autosave, no timer script.
    expect(res.payload).not.toContain('site-header');
    expect(res.payload).not.toContain('autosave.js');
    expect(res.payload).not.toContain('timer.js');
  });

  it('pupil cannot print another pupil\u2019s attempt', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupilA = await createUser(pool(), { role: 'pupil' });
    const pupilB = await createUser(pool(), { role: 'pupil' });
    await seedClassWithQuestion({ teacher, pupil: pupilA, topicCode: '1.2' });
    const { attemptUrl } = await startAndSubmit(pupilA, '1.2', { 0: 'CPU', 1: 'Essay.' });

    const jarB = await loginAs(pupilB);
    const res = await app.inject({
      method: 'GET',
      url: `${attemptUrl}/print?answers=1`,
      headers: { cookie: cookieHeader(jarB) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('teacher owning the class can print an attempt with answers', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    await seedClassWithQuestion({ teacher, pupil, topicCode: '1.2' });
    const { attemptUrl } = await startAndSubmit(pupil, '1.2', {
      0: 'CPU',
      1: 'A thoughtful essay about fetch-decode-execute.',
    });

    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: `${attemptUrl}/print?answers=1`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('A thoughtful essay');
    expect(res.payload).toContain('print-paper');
  });

  it('teacher owning the class can print a blank copy with answers=0', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    await seedClassWithQuestion({ teacher, pupil, topicCode: '1.2' });
    const { attemptUrl } = await startAndSubmit(pupil, '1.2', {
      0: 'CPU',
      1: 'Confidential pupil essay.',
    });

    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: `${attemptUrl}/print?answers=0`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain('Confidential pupil essay');
    expect(res.payload).toContain('print-answer__blank');
    expect(res.payload).toContain('Blank paper');
  });

  it('a non-owning teacher is denied even with answers=1', async () => {
    const teacherA = await createUser(pool(), { role: 'teacher' });
    const teacherB = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    await seedClassWithQuestion({ teacher: teacherA, pupil, topicCode: '1.2' });
    const { attemptUrl } = await startAndSubmit(pupil, '1.2', { 0: 'CPU', 1: 'Essay.' });

    const jar = await loginAs(teacherB);
    const res = await app.inject({
      method: 'GET',
      url: `${attemptUrl}/print?answers=1`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('teacher can print a blank topic preview without creating an attempt row', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    await seedClassWithQuestion({ teacher, pupil, topicCode: '1.2' });

    const before = await pool().query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM attempts`);
    const beforeN = Number(before.rows[0]!.n);

    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: '/topics/1.2/print',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('print-paper');
    expect(res.payload).toContain('Preview only');
    expect(res.payload).toContain('print-answer__blank');

    const after = await pool().query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM attempts`);
    expect(Number(after.rows[0]!.n)).toBe(beforeN);
  });

  it('pupil cannot hit the topic preview route', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    await seedClassWithQuestion({ teacher, pupil, topicCode: '1.2' });

    const jar = await loginAs(pupil);
    const res = await app.inject({
      method: 'GET',
      url: '/topics/1.2/print',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('topic preview 404s when the topic has no approved questions', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: '/topics/1.4/print',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(404);
  });

  it('admin topics list renders a Print preview link for every topic', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/topics',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('Print preview');
    expect(res.payload).toContain('href="/topics/1.2/print"');
  });
});
