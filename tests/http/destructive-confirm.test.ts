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

describe('destructive-action confirms + confirm.js (Chunk 6f)', () => {
  it('chrome references confirm.js', async () => {
    const pupil = await createUser(getSharedPool(), { role: 'pupil' });
    const jar = await loginAs(pupil);
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('src="/static/confirm.js"');
  });

  it('confirm.js is served by static middleware', async () => {
    const res = await app.inject({ method: 'GET', url: '/static/confirm.js' });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('data-confirm');
  });

  it('admin class detail renders data-confirm on Remove-pupil/Remove-topic buttons', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const pupil = await createUser(getSharedPool(), { role: 'pupil' });
    const pool = getSharedPool();
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO classes (name, teacher_id, academic_year)
       VALUES ('Confirm class', $1::bigint, '2025/26') RETURNING id::text`,
      [teacher.id],
    );
    const classId = rows[0]!.id;
    await pool.query(`INSERT INTO enrolments (class_id, user_id) VALUES ($1::bigint, $2::bigint)`, [
      classId,
      pupil.id,
    ]);
    await pool.query(
      `INSERT INTO class_assigned_topics (class_id, topic_code, assigned_by)
       VALUES ($1::bigint, '1.1', $2::bigint)`,
      [classId, teacher.id],
    );

    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: `/admin/classes/${classId}`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    // Remove topic button has a data-confirm attribute
    expect(res.payload).toMatch(/data-confirm="Remove topic 1\.1/);
    // Remove pupil button has a data-confirm attribute
    expect(res.payload).toMatch(/data-confirm="Remove [^"]+ from this class/);
  });

  it('pupil attempt review exposes a Print link in the page header', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const pupil = await createUser(getSharedPool(), { role: 'pupil' });
    const pool = getSharedPool();
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO classes (name, teacher_id, academic_year)
       VALUES ('Print class', $1::bigint, '2025/26') RETURNING id::text`,
      [teacher.id],
    );
    const classId = rows[0]!.id;
    await pool.query(`INSERT INTO enrolments (class_id, user_id) VALUES ($1::bigint, $2::bigint)`, [
      classId,
      pupil.id,
    ]);
    await pool.query(
      `INSERT INTO class_assigned_topics (class_id, topic_code, assigned_by)
       VALUES ($1::bigint, '1.1', $2::bigint)`,
      [classId, teacher.id],
    );
    await createQuestion(pool, teacher.id, {
      topicCode: '1.1',
      subtopicCode: '1.1.1',
      active: true,
      approvalStatus: 'approved',
      parts: [
        {
          label: '(a)',
          prompt: 'P',
          marks: 1,
          expectedResponseType: 'multiple_choice',
          markPoints: [{ text: 'CPU', marks: 1 }],
        },
      ],
    });

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
      url: '/topics/1.1/start',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ _csrf: csrfStart }),
    });
    expect(start.statusCode).toBe(302);
    const attemptUrl = start.headers.location!;
    updateJar(jar, start);

    const edit = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(jar) },
    });
    updateJar(jar, edit);
    const csrfSubmit = extractCsrfToken(edit.payload);
    const partIds = Array.from(edit.payload.matchAll(/name="part_(\d+)"/g)).map((m) => m[1]!);
    const submit = await app.inject({
      method: 'POST',
      url: `${attemptUrl}/submit`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ _csrf: csrfSubmit, [`part_${partIds[0]!}`]: 'CPU' }),
    });
    expect(submit.statusCode).toBe(302);
    updateJar(jar, submit);

    const review = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(review.statusCode).toBe(200);
    // Page header (not the body) should show a Print link pointing at the
    // print endpoint for this attempt.
    const headerBlock = /<header class="page-header"[\s\S]*?<\/header>/.exec(review.payload);
    expect(headerBlock).not.toBeNull();
    expect(headerBlock![0]).toMatch(/href="\/attempts\/\d+\/print"/);
    expect(headerBlock![0]).toContain('>Print<');
  });
});
