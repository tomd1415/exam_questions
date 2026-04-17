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

describe('teacher home dashboard (Chunk 6e)', () => {
  it('teacher with no data sees empty-state dashboard', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('Teacher dashboard');
    expect(res.payload).toContain('Marking queue');
    expect(res.payload).toContain('Pending approvals');
    expect(res.payload).toContain('Your classes');
    expect(res.payload).toContain('Nothing awaiting marking');
    expect(res.payload).toContain('No questions awaiting review');
    expect(res.payload).toContain('No classes yet');
  });

  it('admin sees the dashboard heading as Admin dashboard', async () => {
    const admin = await createUser(getSharedPool(), { role: 'admin' });
    const jar = await loginAs(admin);
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('Admin dashboard');
  });

  it('teacher sees pending-review questions and their classes', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const pool = getSharedPool();
    await pool.query(
      `INSERT INTO classes (name, teacher_id, academic_year)
       VALUES ('Yr11 A', $1::bigint, '2025/26')`,
      [teacher.id],
    );
    await createQuestion(pool, teacher.id, {
      topicCode: '1.2',
      subtopicCode: '1.2.1',
      active: true,
      approvalStatus: 'pending_review',
      parts: [{ label: '(a)', prompt: 'Prompt', marks: 2, expectedResponseType: 'short_text' }],
    });

    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('Yr11 A');
    expect(res.payload).toMatch(/href="\/admin\/questions\/\d+"/);
  });

  it('teacher marking queue surfaces pupil submissions from their class', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const pupil = await createUser(getSharedPool(), { role: 'pupil' });
    const pool = getSharedPool();
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO classes (name, teacher_id, academic_year)
       VALUES ('Queue class', $1::bigint, '2025/26') RETURNING id::text`,
      [teacher.id],
    );
    const classId = rows[0]!.id;
    await pool.query(`INSERT INTO enrolments (class_id, user_id) VALUES ($1::bigint, $2::bigint)`, [
      classId,
      pupil.id,
    ]);
    await pool.query(
      `INSERT INTO class_assigned_topics (class_id, topic_code, assigned_by)
       VALUES ($1::bigint, '2.1', $2::bigint)`,
      [classId, teacher.id],
    );
    await createQuestion(pool, teacher.id, {
      topicCode: '2.1',
      subtopicCode: '2.1.1',
      active: true,
      approvalStatus: 'approved',
      parts: [
        { label: '(a)', prompt: 'Describe.', marks: 2, expectedResponseType: 'extended_response' },
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
      url: '/topics/2.1/start',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(pupilJar),
      },
      payload: form({ _csrf: csrfStart }),
    });
    expect(start.statusCode).toBe(302);
    const attemptUrl = start.headers.location!;
    updateJar(pupilJar, start);
    const edit = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(pupilJar) },
    });
    updateJar(pupilJar, edit);
    const csrfSubmit = extractCsrfToken(edit.payload);
    const partIds = Array.from(edit.payload.matchAll(/name="part_(\d+)"/g)).map((m) => m[1]!);
    const submit = await app.inject({
      method: 'POST',
      url: `${attemptUrl}/submit`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(pupilJar),
      },
      payload: form({ _csrf: csrfSubmit, [`part_${partIds[0]!}`]: 'answer' }),
    });
    expect(submit.statusCode).toBe(302);

    const teacherJar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { cookie: cookieHeader(teacherJar) },
    });
    expect(res.statusCode).toBe(200);
    const queueBlock = /id="dash-queue"[\s\S]*?<\/article>/.exec(res.payload);
    expect(queueBlock).not.toBeNull();
    expect(queueBlock![0]).toContain('Queue class');
    expect(queueBlock![0]).toContain('2.1');
    expect(queueBlock![0]).toMatch(/href="\/admin\/attempts\/\d+"/);
  });
});
