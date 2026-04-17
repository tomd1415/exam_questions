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

async function getCsrfFor(jar: ReturnType<typeof newJar>, url: string): Promise<string> {
  const res = await app.inject({ method: 'GET', url, headers: { cookie: cookieHeader(jar) } });
  expect(res.statusCode).toBe(200);
  updateJar(jar, res);
  return extractCsrfToken(res.payload);
}

async function seedClassWithTopic(params: {
  teacher: CreatedUser;
  pupil: CreatedUser;
  topicCode: string;
}): Promise<string> {
  const p = pool();
  const { rows } = await p.query<{ id: string }>(
    `INSERT INTO classes (name, teacher_id, academic_year)
     VALUES ('Flow test', $1::bigint, '2025/26') RETURNING id::text`,
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
  return classId;
}

describe('GET /topics (pupil)', () => {
  it('redirects unauthenticated users to /login', async () => {
    const res = await app.inject({ method: 'GET', url: '/topics' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('returns 403 for teachers', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: '/topics',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('shows empty state when pupil has no assigned topics', async () => {
    const pupil = await createUser(pool(), { role: 'pupil' });
    const jar = await loginAs(pupil);
    const res = await app.inject({
      method: 'GET',
      url: '/topics',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('No topics have been assigned');
  });

  it('lists topics assigned to the pupil\u2019s class', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    await seedClassWithTopic({ teacher, pupil, topicCode: '1.2' });
    const jar = await loginAs(pupil);
    const res = await app.inject({
      method: 'GET',
      url: '/topics',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('1.2');
    expect(res.payload).toContain('/topics/1.2/start');
  });
});

describe('Full topic-set flow: start → save → reopen → submit → review', () => {
  it('walks through the happy path and persists answers between sessions', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    await seedClassWithTopic({ teacher, pupil, topicCode: '1.2' });
    await createQuestion(pool(), teacher.id, {
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

    const jar = await loginAs(pupil);

    // Start
    const csrfStart = await getCsrfFor(jar, '/topics');
    const startRes = await app.inject({
      method: 'POST',
      url: '/topics/1.2/start',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ _csrf: csrfStart }),
    });
    expect(startRes.statusCode).toBe(302);
    const attemptUrl = startRes.headers.location!;
    expect(attemptUrl).toMatch(/^\/attempts\/\d+$/);
    updateJar(jar, startRes);

    // Load edit page and grab the part id from the textarea name
    const editPage = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(editPage.statusCode).toBe(200);
    updateJar(jar, editPage);
    const partMatch = /name="part_(\d+)"/.exec(editPage.payload);
    expect(partMatch).not.toBeNull();
    const attemptPartId = partMatch![1]!;
    const csrfEdit = extractCsrfToken(editPage.payload);

    // Save progress (not submit)
    const saveRes = await app.inject({
      method: 'POST',
      url: `${attemptUrl}/save`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ _csrf: csrfEdit, [`part_${attemptPartId}`]: 'CPU' }),
    });
    expect(saveRes.statusCode).toBe(302);
    updateJar(jar, saveRes);

    // Reopen — should still be editable with saved content
    const reopen = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(reopen.statusCode).toBe(200);
    expect(reopen.payload).toMatch(/type="radio"[\s\S]*?value="CPU"[\s\S]*?checked/);
    updateJar(jar, reopen);

    // Submit
    const csrfSubmit = extractCsrfToken(reopen.payload);
    const submitRes = await app.inject({
      method: 'POST',
      url: `${attemptUrl}/submit`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ _csrf: csrfSubmit, [`part_${attemptPartId}`]: 'CPU' }),
    });
    expect(submitRes.statusCode).toBe(302);
    expect(submitRes.headers.location).toBe(attemptUrl);
    updateJar(jar, submitRes);

    // Review page
    const review = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(review.statusCode).toBe(200);
    expect(review.payload).toContain('review');
    expect(review.payload).toContain('Score:');
    expect(review.payload).toContain('1 / 1');

    // Audit: at least attempt.started, attempt.submitted, marking.completed
    const audit = await pool().query<{ event_type: string }>(
      `SELECT event_type FROM audit_events
        WHERE actor_user_id = $1::bigint
        ORDER BY at ASC`,
      [pupil.id],
    );
    const types = audit.rows.map((r) => r.event_type);
    expect(types).toContain('attempt.started');
    expect(types).toContain('attempt.submitted');
    expect(types).toContain('marking.completed');
  });

  it('start on a topic with no approved questions redirects back with a flash', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    await seedClassWithTopic({ teacher, pupil, topicCode: '1.2' });
    // Only a draft question — not pickable.
    await createQuestion(pool(), teacher.id, {
      topicCode: '1.2',
      active: true,
      approvalStatus: 'draft',
    });

    const jar = await loginAs(pupil);
    const csrf = await getCsrfFor(jar, '/topics');
    const res = await app.inject({
      method: 'POST',
      url: '/topics/1.2/start',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ _csrf: csrf }),
    });
    expect(res.statusCode).toBe(302);
    expect(decodeURIComponent(res.headers.location!)).toContain('No approved questions');
  });
});
