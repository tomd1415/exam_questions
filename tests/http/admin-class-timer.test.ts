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

async function getLoginToken(): Promise<{ jar: ReturnType<typeof newJar>; token: string }> {
  const jar = newJar();
  const res = await app.inject({ method: 'GET', url: '/login' });
  updateJar(jar, res);
  return { jar, token: extractCsrfToken(res.payload) };
}

async function loginAs(user: CreatedUser): Promise<ReturnType<typeof newJar>> {
  const { jar, token } = await getLoginToken();
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

async function createClassFor(
  user: CreatedUser,
  name = 'TimerClass',
): Promise<{ jar: ReturnType<typeof newJar>; classId: string }> {
  const jar = await loginAs(user);
  const csrf = await getCsrfFor(jar, '/admin/classes/new');
  const res = await app.inject({
    method: 'POST',
    url: '/admin/classes',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: cookieHeader(jar),
    },
    payload: form({ name, academic_year: '2025/26', _csrf: csrf }),
  });
  const classId = res.headers.location!.split('/').pop()!;
  return { jar, classId };
}

describe('POST /admin/classes/:id/timer', () => {
  it('teacher can set a timer on their own class', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const { jar, classId } = await createClassFor(teacher);
    const csrf = await getCsrfFor(jar, `/admin/classes/${classId}`);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/classes/${classId}/timer`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ timer_minutes: '45', _csrf: csrf }),
    });
    expect(res.statusCode).toBe(302);
    expect(decodeURIComponent(res.headers.location!)).toContain('Countdown timer set to 45');

    const { rows } = await pool().query<{ timer_minutes: number | null }>(
      `SELECT timer_minutes FROM classes WHERE id = $1::bigint`,
      [classId],
    );
    expect(rows[0]?.timer_minutes).toBe(45);
  });

  it('clearing the timer (blank input) removes it', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const { jar, classId } = await createClassFor(teacher);

    const csrf1 = await getCsrfFor(jar, `/admin/classes/${classId}`);
    await app.inject({
      method: 'POST',
      url: `/admin/classes/${classId}/timer`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ timer_minutes: '30', _csrf: csrf1 }),
    });

    const csrf2 = await getCsrfFor(jar, `/admin/classes/${classId}`);
    const res = await app.inject({
      method: 'POST',
      url: `/admin/classes/${classId}/timer`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ timer_minutes: '', _csrf: csrf2 }),
    });
    expect(res.statusCode).toBe(302);
    expect(decodeURIComponent(res.headers.location!)).toContain('Countdown timer removed');

    const { rows } = await pool().query<{ timer_minutes: number | null }>(
      `SELECT timer_minutes FROM classes WHERE id = $1::bigint`,
      [classId],
    );
    expect(rows[0]?.timer_minutes).toBeNull();
  });

  it('out-of-range value flashes an error and leaves the timer unchanged', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const { jar, classId } = await createClassFor(teacher);
    const csrf = await getCsrfFor(jar, `/admin/classes/${classId}`);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/classes/${classId}/timer`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ timer_minutes: '500', _csrf: csrf }),
    });
    expect(res.statusCode).toBe(302);
    expect(decodeURIComponent(res.headers.location!)).toContain('between 1 and 180');

    const { rows } = await pool().query<{ timer_minutes: number | null }>(
      `SELECT timer_minutes FROM classes WHERE id = $1::bigint`,
      [classId],
    );
    expect(rows[0]?.timer_minutes).toBeNull();
  });

  it("teacher B cannot set teacher A's class timer (403)", async () => {
    const tA = await createUser(pool(), { role: 'teacher' });
    const tB = await createUser(pool(), { role: 'teacher' });
    const { classId } = await createClassFor(tA);

    const jarB = await loginAs(tB);
    const csrf = await getCsrfFor(jarB, '/admin/classes/new');
    const res = await app.inject({
      method: 'POST',
      url: `/admin/classes/${classId}/timer`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jarB),
      },
      payload: form({ timer_minutes: '30', _csrf: csrf }),
    });
    expect(res.statusCode).toBe(403);

    const { rows } = await pool().query<{ timer_minutes: number | null }>(
      `SELECT timer_minutes FROM classes WHERE id = $1::bigint`,
      [classId],
    );
    expect(rows[0]?.timer_minutes).toBeNull();
  });

  it('teacher setting a timer is reflected on a pupil\u2019s subsequent attempt', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    const { jar, classId } = await createClassFor(teacher);

    // Enrol the pupil and assign topic 1.2
    const csrfEnrol = await getCsrfFor(jar, `/admin/classes/${classId}`);
    await app.inject({
      method: 'POST',
      url: `/admin/classes/${classId}/enrol`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ pupil_username: pupil.username, _csrf: csrfEnrol }),
    });

    const csrfTopic = await getCsrfFor(jar, `/admin/classes/${classId}`);
    await app.inject({
      method: 'POST',
      url: `/admin/classes/${classId}/topics`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ topic_code: '1.2', _csrf: csrfTopic }),
    });

    await createQuestion(pool(), teacher.id, {
      topicCode: '1.2',
      active: true,
      approvalStatus: 'approved',
    });

    const csrfTimer = await getCsrfFor(jar, `/admin/classes/${classId}`);
    const timerRes = await app.inject({
      method: 'POST',
      url: `/admin/classes/${classId}/timer`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ timer_minutes: '25', _csrf: csrfTimer }),
    });
    expect(timerRes.statusCode).toBe(302);

    // Pupil logs in and starts an attempt on 1.2
    const pupilJar = await loginAs(pupil);
    const csrfStart = await getCsrfFor(pupilJar, '/topics');
    const startRes = await app.inject({
      method: 'POST',
      url: '/topics/1.2/start',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(pupilJar),
      },
      payload: form({ _csrf: csrfStart }),
    });
    expect(startRes.statusCode).toBe(302);
    const attemptId = /\/attempts\/(\d+)/.exec(startRes.headers.location!)![1]!;

    const { rows } = await pool().query<{ timer_minutes: number | null }>(
      `SELECT timer_minutes FROM attempts WHERE id = $1::bigint`,
      [attemptId],
    );
    expect(rows[0]?.timer_minutes).toBe(25);

    // The attempt page should render the timer pill with data attributes.
    const editRes = await app.inject({
      method: 'GET',
      url: `/attempts/${attemptId}`,
      headers: { cookie: cookieHeader(pupilJar) },
    });
    expect(editRes.statusCode).toBe(200);
    expect(editRes.payload).toContain('id="paper-timer"');
    expect(editRes.payload).toContain('data-timer-minutes="25"');
    expect(editRes.payload).toContain('/static/timer.js');
  });
});
