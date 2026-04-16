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

async function loginAs(user: CreatedUser): Promise<ReturnType<typeof newJar>> {
  const jar = newJar();
  const loginPage = await app.inject({ method: 'GET', url: '/login' });
  updateJar(jar, loginPage);
  const token = extractCsrfToken(loginPage.payload);
  const res = await app.inject({
    method: 'POST',
    url: '/login',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: cookieHeader(jar),
    },
    payload: form({ username: user.username, password: user.password, _csrf: token }),
  });
  updateJar(jar, res);
  return jar;
}

describe('admin/classes CSRF protection', () => {
  it('POST /admin/classes without a token is rejected (403)', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'POST',
      url: '/admin/classes',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ name: 'NoCsrf', academic_year: '2025/26' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST /admin/classes/:id/enrol without a token is rejected (403)', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    const jar = await loginAs(teacher);

    // Create a class via the legitimate path so we have a real id.
    const newPage = await app.inject({
      method: 'GET',
      url: '/admin/classes/new',
      headers: { cookie: cookieHeader(jar) },
    });
    updateJar(jar, newPage);
    const csrf = extractCsrfToken(newPage.payload);
    const create = await app.inject({
      method: 'POST',
      url: '/admin/classes',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ name: 'CsrfTest', academic_year: '2025/26', _csrf: csrf }),
    });
    const classId = create.headers.location!.split('/').pop()!;

    const res = await app.inject({
      method: 'POST',
      url: `/admin/classes/${classId}/enrol`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ pupil_username: pupil.username }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST /admin/classes/:id/enrolments/:userId/remove without a token is rejected (403)', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    const jar = await loginAs(teacher);

    const newPage = await app.inject({
      method: 'GET',
      url: '/admin/classes/new',
      headers: { cookie: cookieHeader(jar) },
    });
    updateJar(jar, newPage);
    const csrfNew = extractCsrfToken(newPage.payload);
    const create = await app.inject({
      method: 'POST',
      url: '/admin/classes',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ name: 'CsrfRemove', academic_year: '2025/26', _csrf: csrfNew }),
    });
    const classId = create.headers.location!.split('/').pop()!;

    const detail = await app.inject({
      method: 'GET',
      url: `/admin/classes/${classId}`,
      headers: { cookie: cookieHeader(jar) },
    });
    updateJar(jar, detail);
    const csrfEnrol = extractCsrfToken(detail.payload);
    await app.inject({
      method: 'POST',
      url: `/admin/classes/${classId}/enrol`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ pupil_username: pupil.username, _csrf: csrfEnrol }),
    });

    const res = await app.inject({
      method: 'POST',
      url: `/admin/classes/${classId}/enrolments/${pupil.id}/remove`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: '',
    });
    expect(res.statusCode).toBe(403);
  });
});
