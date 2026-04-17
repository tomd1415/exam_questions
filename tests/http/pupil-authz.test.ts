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

async function seedAttempt(pupil: CreatedUser): Promise<string> {
  const teacher = await createUser(pool(), { role: 'teacher' });
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO classes (name, teacher_id, academic_year)
     VALUES ('Authz test', $1::bigint, '2025/26') RETURNING id::text`,
    [teacher.id],
  );
  const classId = rows[0]!.id;
  await pool().query(`INSERT INTO enrolments (class_id, user_id) VALUES ($1::bigint, $2::bigint)`, [
    classId,
    pupil.id,
  ]);
  await pool().query(
    `INSERT INTO class_assigned_topics (class_id, topic_code, assigned_by)
     VALUES ($1::bigint, '1.2', $2::bigint)`,
    [classId, teacher.id],
  );
  await createQuestion(pool(), teacher.id, {
    topicCode: '1.2',
    active: true,
    approvalStatus: 'approved',
  });

  const jar = await loginAs(pupil);
  const topics = await app.inject({
    method: 'GET',
    url: '/topics',
    headers: { cookie: cookieHeader(jar) },
  });
  updateJar(jar, topics);
  const csrf = extractCsrfToken(topics.payload);
  const start = await app.inject({
    method: 'POST',
    url: '/topics/1.2/start',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: cookieHeader(jar),
    },
    payload: form({ _csrf: csrf }),
  });
  expect(start.statusCode).toBe(302);
  return start.headers.location!.split('/').pop()!;
}

describe('Pupil attempt authorization', () => {
  it('pupil A cannot view pupil B\u2019s attempt (403)', async () => {
    const pupilA = await createUser(pool(), { role: 'pupil' });
    const pupilB = await createUser(pool(), { role: 'pupil' });
    const attemptId = await seedAttempt(pupilA);

    const jarB = await loginAs(pupilB);
    const res = await app.inject({
      method: 'GET',
      url: `/attempts/${attemptId}`,
      headers: { cookie: cookieHeader(jarB) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('pupil B cannot save into pupil A\u2019s attempt (403)', async () => {
    const pupilA = await createUser(pool(), { role: 'pupil' });
    const pupilB = await createUser(pool(), { role: 'pupil' });
    const attemptId = await seedAttempt(pupilA);

    // B needs a CSRF token from *some* page B can render.
    const jarB = await loginAs(pupilB);
    const topics = await app.inject({
      method: 'GET',
      url: '/topics',
      headers: { cookie: cookieHeader(jarB) },
    });
    updateJar(jarB, topics);
    const csrf = extractCsrfToken(topics.payload);

    const res = await app.inject({
      method: 'POST',
      url: `/attempts/${attemptId}/save`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jarB),
      },
      payload: form({ _csrf: csrf, part_1: 'hack' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('teachers cannot use pupil start endpoint (403)', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    // Grab a real CSRF token from a page a teacher can load.
    const page = await app.inject({
      method: 'GET',
      url: '/admin/classes/new',
      headers: { cookie: cookieHeader(jar) },
    });
    updateJar(jar, page);
    const csrf = extractCsrfToken(page.payload);

    const res = await app.inject({
      method: 'POST',
      url: '/topics/1.2/start',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ _csrf: csrf }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('admin can view a pupil attempt', async () => {
    const pupil = await createUser(pool(), { role: 'pupil' });
    const admin = await createUser(pool(), { role: 'admin' });
    const attemptId = await seedAttempt(pupil);

    const jar = await loginAs(admin);
    const res = await app.inject({
      method: 'GET',
      url: `/attempts/${attemptId}`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
  });
});
