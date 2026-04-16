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

describe('GET /admin/classes', () => {
  it('redirects unauthenticated users to /login', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/classes' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('returns 403 for pupils', async () => {
    const pupil = await createUser(pool(), { role: 'pupil' });
    const jar = await loginAs(pupil);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/classes',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('renders the empty state for a fresh teacher', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/classes',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('No classes yet');
    expect(res.payload).toContain('href="/admin/classes/new"');
  });
});

describe('POST /admin/classes (create)', () => {
  it('creates a class and redirects to its detail page', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const csrf = await getCsrfFor(jar, '/admin/classes/new');

    const res = await app.inject({
      method: 'POST',
      url: '/admin/classes',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ name: '10A Computing', academic_year: '2025/26', _csrf: csrf }),
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^\/admin\/classes\/\d+$/);

    const { rows } = await pool().query<{ name: string; teacher_id: string }>(
      `SELECT name, teacher_id::text FROM classes WHERE name = $1 AND academic_year = $2`,
      ['10A Computing', '2025/26'],
    );
    expect(rows[0]?.teacher_id).toBe(teacher.id);

    const audit = await pool().query<{ event_type: string }>(
      `SELECT event_type FROM audit_events
        WHERE actor_user_id = $1::bigint AND event_type = 'class.created'`,
      [teacher.id],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('rejects a duplicate (teacher, year, name) with a 409 and a flash', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const csrf1 = await getCsrfFor(jar, '/admin/classes/new');
    await app.inject({
      method: 'POST',
      url: '/admin/classes',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ name: 'Dup', academic_year: '2025/26', _csrf: csrf1 }),
    });

    const csrf2 = await getCsrfFor(jar, '/admin/classes/new');
    const res = await app.inject({
      method: 'POST',
      url: '/admin/classes',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ name: 'Dup', academic_year: '2025/26', _csrf: csrf2 }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.payload).toContain('already have a class with that name');
  });
});

describe('GET /admin/classes/:id (teacher isolation)', () => {
  it('teacher A cannot see teacher B\u2019s class', async () => {
    const tA = await createUser(pool(), { role: 'teacher' });
    const tB = await createUser(pool(), { role: 'teacher' });

    const jarB = await loginAs(tB);
    const csrf = await getCsrfFor(jarB, '/admin/classes/new');
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/classes',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jarB),
      },
      payload: form({ name: 'B-only', academic_year: '2025/26', _csrf: csrf }),
    });
    const location = createRes.headers.location!;
    const classId = location.split('/').pop();

    const jarA = await loginAs(tA);
    const res = await app.inject({
      method: 'GET',
      url: `/admin/classes/${classId}`,
      headers: { cookie: cookieHeader(jarA) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('admin can see any teacher\u2019s class', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const admin = await createUser(pool(), { role: 'admin' });

    const jarT = await loginAs(teacher);
    const csrf = await getCsrfFor(jarT, '/admin/classes/new');
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/classes',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jarT),
      },
      payload: form({ name: 'T-class', academic_year: '2025/26', _csrf: csrf }),
    });
    const location = createRes.headers.location!;
    const classId = location.split('/').pop();

    const jarAdmin = await loginAs(admin);
    const res = await app.inject({
      method: 'GET',
      url: `/admin/classes/${classId}`,
      headers: { cookie: cookieHeader(jarAdmin) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('T-class');
  });
});

describe('Enrolment lifecycle', () => {
  async function setupClass(
    teacher: CreatedUser,
  ): Promise<{ jar: ReturnType<typeof newJar>; classId: string }> {
    const jar = await loginAs(teacher);
    const csrf = await getCsrfFor(jar, '/admin/classes/new');
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/classes',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ name: 'EnrolTest', academic_year: '2025/26', _csrf: csrf }),
    });
    const classId = createRes.headers.location!.split('/').pop()!;
    return { jar, classId };
  }

  it('enrols an active pupil by username and lists them', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil', displayName: 'Pip' });
    const { jar, classId } = await setupClass(teacher);

    const csrf = await getCsrfFor(jar, `/admin/classes/${classId}`);
    const res = await app.inject({
      method: 'POST',
      url: `/admin/classes/${classId}/enrol`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ pupil_username: pupil.username, _csrf: csrf }),
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain(`/admin/classes/${classId}?flash=`);

    const detail = await app.inject({
      method: 'GET',
      url: res.headers.location!,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(detail.payload).toContain('Pip');
    expect(detail.payload).toContain(pupil.username);
  });

  it('shows a friendly flash when the username is unknown', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const { jar, classId } = await setupClass(teacher);
    const csrf = await getCsrfFor(jar, `/admin/classes/${classId}`);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/classes/${classId}/enrol`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ pupil_username: 'no_such_pupil', _csrf: csrf }),
    });
    expect(res.statusCode).toBe(302);
    expect(decodeURIComponent(res.headers.location!)).toContain(
      'No active pupil with that username',
    );
  });

  it('refuses to enrol a teacher (only pupils are eligible)', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const otherTeacher = await createUser(pool(), { role: 'teacher' });
    const { jar, classId } = await setupClass(teacher);
    const csrf = await getCsrfFor(jar, `/admin/classes/${classId}`);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/classes/${classId}/enrol`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ pupil_username: otherTeacher.username, _csrf: csrf }),
    });
    expect(decodeURIComponent(res.headers.location!)).toContain(
      'No active pupil with that username',
    );
  });

  it('removes a pupil and audits the action', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    const { jar, classId } = await setupClass(teacher);

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

    const csrfRemove = await getCsrfFor(jar, `/admin/classes/${classId}`);
    const removeRes = await app.inject({
      method: 'POST',
      url: `/admin/classes/${classId}/enrolments/${pupil.id}/remove`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ _csrf: csrfRemove }),
    });
    expect(removeRes.statusCode).toBe(302);

    const { rowCount } = await pool().query(
      `SELECT 1 FROM enrolments WHERE class_id = $1::bigint AND user_id = $2::bigint`,
      [classId, pupil.id],
    );
    expect(rowCount).toBe(0);

    const audit = await pool().query<{ event_type: string }>(
      `SELECT event_type FROM audit_events
        WHERE actor_user_id = $1::bigint AND event_type = 'enrolment.removed'`,
      [teacher.id],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('teacher A cannot enrol into teacher B\u2019s class', async () => {
    const tA = await createUser(pool(), { role: 'teacher' });
    const tB = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    const { classId } = await setupClass(tB);

    const jarA = await loginAs(tA);
    // Teacher A cannot fetch the detail page for B's class, so grab a CSRF
    // token from a page A *can* render — the new-class form.
    const csrf = await getCsrfFor(jarA, '/admin/classes/new');

    const res = await app.inject({
      method: 'POST',
      url: `/admin/classes/${classId}/enrol`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jarA),
      },
      payload: form({ pupil_username: pupil.username, _csrf: csrf }),
    });
    expect(res.statusCode).toBe(403);
  });
});
