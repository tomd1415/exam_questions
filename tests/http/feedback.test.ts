import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../helpers/app.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createUser, type CreatedUser } from '../helpers/fixtures.js';
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

describe('GET /feedback', () => {
  it('redirects anonymous users to /login', async () => {
    const res = await app.inject({ method: 'GET', url: '/feedback' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('renders the form for a logged-in pupil', async () => {
    const pupil = await createUser(getSharedPool(), { role: 'pupil' });
    const jar = await loginAs(pupil);
    const res = await app.inject({
      method: 'GET',
      url: '/feedback',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('Send feedback');
    expect(res.payload).toContain('name="comment"');
  });
});

describe('POST /feedback', () => {
  it('saves a comment and shows a thank-you flash', async () => {
    const pupil = await createUser(getSharedPool(), { role: 'pupil' });
    const jar = await loginAs(pupil);
    const csrf = await getCsrfFor(jar, '/feedback');

    const res = await app.inject({
      method: 'POST',
      url: '/feedback',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ comment: 'The timer pill is too small on mobile.', _csrf: csrf }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('Thank you');

    const { rows } = await getSharedPool().query<{ comment: string; status: string }>(
      `SELECT comment, status FROM pupil_feedback WHERE user_id = $1::bigint`,
      [pupil.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.comment).toBe('The timer pill is too small on mobile.');
    expect(rows[0]!.status).toBe('new');
  });

  it('rejects an empty comment with a 400', async () => {
    const pupil = await createUser(getSharedPool(), { role: 'pupil' });
    const jar = await loginAs(pupil);
    const csrf = await getCsrfFor(jar, '/feedback');

    const res = await app.inject({
      method: 'POST',
      url: '/feedback',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ comment: '   ', _csrf: csrf }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toContain('add a comment');
  });

  it('fails CSRF without a token', async () => {
    const pupil = await createUser(getSharedPool(), { role: 'pupil' });
    const jar = await loginAs(pupil);

    const res = await app.inject({
      method: 'POST',
      url: '/feedback',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ comment: 'hello' }),
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('/admin/feedback', () => {
  it('pupil cannot view the admin list', async () => {
    const pupil = await createUser(getSharedPool(), { role: 'pupil' });
    const jar = await loginAs(pupil);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/feedback',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('teacher sees all submitted feedback and can triage an entry', async () => {
    const pool = getSharedPool();
    const pupil = await createUser(pool, { role: 'pupil' });
    const teacher = await createUser(pool, { role: 'teacher' });

    // Pupil submits feedback
    const pupilJar = await loginAs(pupil);
    const submitCsrf = await getCsrfFor(pupilJar, '/feedback');
    await app.inject({
      method: 'POST',
      url: '/feedback',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(pupilJar),
      },
      payload: form({ comment: 'Add a dark mode please.', _csrf: submitCsrf }),
    });

    // Teacher views and triages
    const teacherJar = await loginAs(teacher);
    const listRes = await app.inject({
      method: 'GET',
      url: '/admin/feedback',
      headers: { cookie: cookieHeader(teacherJar) },
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.payload).toContain('Add a dark mode please.');

    const triageCsrf = await getCsrfFor(teacherJar, '/admin/feedback');
    const { rows: before } = await pool.query<{ id: string }>(
      `SELECT id::text FROM pupil_feedback LIMIT 1`,
    );
    const feedbackId = before[0]!.id;

    const triageRes = await app.inject({
      method: 'POST',
      url: `/admin/feedback/${feedbackId}/triage`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(teacherJar),
      },
      payload: form({
        status: 'in_progress',
        category: 'new_feature',
        triage_notes: 'Tracked under theming epic.',
        _csrf: triageCsrf,
      }),
    });
    expect(triageRes.statusCode).toBe(302);
    expect(triageRes.headers.location).toBe('/admin/feedback');

    const { rows: after } = await pool.query<{
      status: string;
      category: string | null;
      triage_notes: string | null;
      triaged_by: string | null;
    }>(
      `SELECT status, category, triage_notes, triaged_by::text FROM pupil_feedback WHERE id = $1::bigint`,
      [feedbackId],
    );
    expect(after[0]!.status).toBe('in_progress');
    expect(after[0]!.category).toBe('new_feature');
    expect(after[0]!.triage_notes).toBe('Tracked under theming epic.');
    expect(after[0]!.triaged_by).toBe(teacher.id);
  });
});

describe('/admin/feedback/new', () => {
  it('pupil cannot open the offline-entry form', async () => {
    const pupil = await createUser(getSharedPool(), { role: 'pupil' });
    const jar = await loginAs(pupil);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/feedback/new',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('teacher logs feedback on behalf of a pupil and it appears in both views', async () => {
    const pool = getSharedPool();
    const pupil = await createUser(pool, { role: 'pupil' });
    const teacher = await createUser(pool, { role: 'teacher' });

    const teacherJar = await loginAs(teacher);
    const csrf = await getCsrfFor(teacherJar, '/admin/feedback/new');

    const res = await app.inject({
      method: 'POST',
      url: '/admin/feedback/new',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(teacherJar),
      },
      payload: form({
        pupil_username: pupil.username,
        comment: 'Pupil said the trace table widget is just a text box.',
        _csrf: csrf,
      }),
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/admin/feedback');

    const { rows } = await pool.query<{
      user_id: string;
      submitted_by_user_id: string | null;
      comment: string;
    }>(
      `SELECT user_id::text, submitted_by_user_id::text, comment
         FROM pupil_feedback WHERE user_id = $1::bigint`,
      [pupil.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.submitted_by_user_id).toBe(teacher.id);
    expect(rows[0]!.comment).toContain('trace table widget');

    const adminList = await app.inject({
      method: 'GET',
      url: '/admin/feedback',
      headers: { cookie: cookieHeader(teacherJar) },
    });
    expect(adminList.statusCode).toBe(200);
    expect(adminList.payload).toContain('Logged offline by');
    expect(adminList.payload).toContain('trace table widget');

    const pupilJar = await loginAs(pupil);
    const pupilView = await app.inject({
      method: 'GET',
      url: '/feedback',
      headers: { cookie: cookieHeader(pupilJar) },
    });
    expect(pupilView.statusCode).toBe(200);
    expect(pupilView.payload).toContain('Logged by a teacher on your behalf');
    expect(pupilView.payload).toContain('trace table widget');
  });

  it('unknown pupil username re-renders the form with an error flash', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const csrf = await getCsrfFor(jar, '/admin/feedback/new');

    const res = await app.inject({
      method: 'POST',
      url: '/admin/feedback/new',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({
        pupil_username: 'not_a_real_pupil',
        comment: 'something',
        _csrf: csrf,
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toContain('No active pupil with that username');
    expect(res.payload).toContain('value="not_a_real_pupil"');
  });
});
