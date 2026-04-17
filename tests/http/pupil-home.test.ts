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

async function enrolPupilAndAssignTopic(
  teacherId: string,
  pupilId: string,
  className: string,
  topicCode: string,
): Promise<void> {
  const pool = getSharedPool();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO classes (name, teacher_id, academic_year)
     VALUES ($1, $2::bigint, '2025/26') RETURNING id::text`,
    [className, teacherId],
  );
  const classId = rows[0]!.id;
  await pool.query(`INSERT INTO enrolments (class_id, user_id) VALUES ($1::bigint, $2::bigint)`, [
    classId,
    pupilId,
  ]);
  await pool.query(
    `INSERT INTO class_assigned_topics (class_id, topic_code, assigned_by)
     VALUES ($1::bigint, $2, $3::bigint)`,
    [classId, topicCode, teacherId],
  );
}

describe('pupil home dashboard (Chunk 6d)', () => {
  it('unauthenticated / redirects to /login', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('teacher / still redirects to /admin/classes', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/admin/classes');
  });

  it('pupil with no attempts and no topics sees empty-state dashboard', async () => {
    const pupil = await createUser(getSharedPool(), { role: 'pupil' });
    const jar = await loginAs(pupil);
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('Welcome back');
    expect(res.payload).toContain('In progress');
    expect(res.payload).toContain('Awaiting marking');
    expect(res.payload).toContain('Recently reviewed');
    expect(res.payload).toContain('Your topics');
    expect(res.payload).toContain('No attempts in progress');
    expect(res.payload).toContain('No topics have been assigned');
  });

  it('pupil with in-progress and awaiting-marking attempts sees them in the right cards', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const pupil = await createUser(getSharedPool(), { role: 'pupil' });
    await enrolPupilAndAssignTopic(teacher.id, pupil.id, 'Home-A', '1.3');
    await enrolPupilAndAssignTopic(teacher.id, pupil.id, 'Home-B', '1.4');

    await createQuestion(getSharedPool(), teacher.id, {
      topicCode: '1.3',
      subtopicCode: '1.3.1',
      active: true,
      approvalStatus: 'approved',
      parts: [{ label: '(a)', prompt: 'P', marks: 2, expectedResponseType: 'extended_response' }],
    });
    await createQuestion(getSharedPool(), teacher.id, {
      topicCode: '1.4',
      subtopicCode: '1.4.1',
      active: true,
      approvalStatus: 'approved',
      parts: [{ label: '(a)', prompt: 'P', marks: 2, expectedResponseType: 'extended_response' }],
    });

    const jar = await loginAs(pupil);
    const topics = await app.inject({
      method: 'GET',
      url: '/topics',
      headers: { cookie: cookieHeader(jar) },
    });
    updateJar(jar, topics);

    // Start + leave in progress for 1.3
    const csrfA = extractCsrfToken(topics.payload);
    const startA = await app.inject({
      method: 'POST',
      url: '/topics/1.3/start',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ _csrf: csrfA }),
    });
    expect(startA.statusCode).toBe(302);
    updateJar(jar, startA);

    // Start + submit 1.4 (awaiting marking since extended_response)
    const topics2 = await app.inject({
      method: 'GET',
      url: '/topics',
      headers: { cookie: cookieHeader(jar) },
    });
    updateJar(jar, topics2);
    const csrfB = extractCsrfToken(topics2.payload);
    const startB = await app.inject({
      method: 'POST',
      url: '/topics/1.4/start',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ _csrf: csrfB }),
    });
    expect(startB.statusCode).toBe(302);
    const attemptBUrl = startB.headers.location!;
    updateJar(jar, startB);

    const editB = await app.inject({
      method: 'GET',
      url: attemptBUrl,
      headers: { cookie: cookieHeader(jar) },
    });
    updateJar(jar, editB);
    const csrfSubmit = extractCsrfToken(editB.payload);
    const partIds = Array.from(editB.payload.matchAll(/name="part_(\d+)"/g)).map((m) => m[1]!);
    const submitB = await app.inject({
      method: 'POST',
      url: `${attemptBUrl}/submit`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ _csrf: csrfSubmit, [`part_${partIds[0]!}`]: 'An answer.' }),
    });
    expect(submitB.statusCode).toBe(302);

    const home = await app.inject({
      method: 'GET',
      url: '/',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(home.statusCode).toBe(200);

    // In-progress card should mention topic 1.3
    const inProgressBlock = /id="dash-in-progress"[\s\S]*?<\/article>/.exec(home.payload);
    expect(inProgressBlock).not.toBeNull();
    // Awaiting-marking card should mention topic 1.4 ("pending")
    const awaitingBlock = /id="dash-awaiting"[\s\S]*?<\/article>/.exec(home.payload);
    expect(awaitingBlock).not.toBeNull();
    expect(awaitingBlock![0]).toMatch(/pending/);

    // The two topic codes should appear in the topics card
    expect(home.payload).toContain('1.3');
    expect(home.payload).toContain('1.4');
  });
});
