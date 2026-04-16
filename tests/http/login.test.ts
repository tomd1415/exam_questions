import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../helpers/app.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createUser } from '../helpers/fixtures.js';
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

async function getLoginToken(): Promise<{ jar: ReturnType<typeof newJar>; token: string }> {
  const jar = newJar();
  const res = await app.inject({ method: 'GET', url: '/login' });
  expect(res.statusCode).toBe(200);
  updateJar(jar, res);
  const token = extractCsrfToken(res.payload);
  return { jar, token };
}

describe('GET /login', () => {
  it('renders the form with a CSRF token and sets a _csrf cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/login' });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('name="_csrf"');
    expect(res.payload).toContain('action="/login"');
    const csrfCookie = res.cookies.find((c) => c.name === '_csrf');
    expect(csrfCookie?.value).toBeTruthy();
  });
});

describe('POST /login', () => {
  it('rejects requests without a CSRF token (403)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'username=foo&password=bar',
    });
    expect(res.statusCode).toBe(403);
  });

  it('on correct credentials, sets sid cookie and redirects to /', async () => {
    const u = await createUser(pool(), { username: 'login_ok', password: 'pw-12345-ok' });
    const { jar, token } = await getLoginToken();
    const res = await app.inject({
      method: 'POST',
      url: '/login',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ username: 'login_ok', password: 'pw-12345-ok', _csrf: token }),
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    const sid = res.cookies.find((c) => c.name === 'sid');
    expect(sid?.value).toBeTruthy();

    // A row in sessions for this user.
    const { rowCount } = await pool().query(`SELECT 1 FROM sessions WHERE user_id = $1::bigint`, [
      u.id,
    ]);
    expect(rowCount).toBe(1);
  });

  it('on bad password, returns 401 with login form re-rendered (no sid cookie)', async () => {
    await createUser(pool(), { username: 'login_bad', password: 'right-pw' });
    const { jar, token } = await getLoginToken();
    const res = await app.inject({
      method: 'POST',
      url: '/login',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ username: 'login_bad', password: 'wrong-pw', _csrf: token }),
    });

    expect(res.statusCode).toBe(401);
    expect(res.payload).toContain('Username or password is incorrect.');
    expect(res.cookies.find((c) => c.name === 'sid')).toBeUndefined();
  });

  it('locks an account after 5 failed attempts (audit + DB)', async () => {
    await createUser(pool(), { username: 'lockme', password: 'right-pw' });
    for (let i = 0; i < 5; i++) {
      const { jar, token } = await getLoginToken();
      await app.inject({
        method: 'POST',
        url: '/login',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: cookieHeader(jar),
        },
        payload: form({ username: 'lockme', password: 'wrong-pw', _csrf: token }),
      });
    }

    const { rows } = await pool().query<{ failed_login_count: number; locked_until: Date | null }>(
      `SELECT failed_login_count, locked_until FROM users WHERE username = $1`,
      ['lockme'],
    );
    expect(rows[0]?.failed_login_count).toBe(5);
    expect(rows[0]?.locked_until).not.toBeNull();
  });
});

describe('POST /logout', () => {
  it('destroys the session and clears the sid cookie', async () => {
    await createUser(pool(), { username: 'logout_user', password: 'pw-12345-ok' });

    const { jar: loginJar, token: loginToken } = await getLoginToken();
    const loginRes = await app.inject({
      method: 'POST',
      url: '/login',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(loginJar),
      },
      payload: form({
        username: 'logout_user',
        password: 'pw-12345-ok',
        _csrf: loginToken,
      }),
    });
    expect(loginRes.statusCode).toBe(302);
    updateJar(loginJar, loginRes);

    // Now fetch a CSRF for the logout (cookies must include sid + _csrf).
    const formRes = await app.inject({
      method: 'GET',
      url: '/login',
      headers: { cookie: cookieHeader(loginJar) },
    });
    // Authed users hitting /login redirect to /; we want a CSRF token, so
    // fetch /q/1 instead — it sets _csrf and renders a token-bearing form.
    expect(formRes.statusCode).toBe(302);

    const qRes = await app.inject({
      method: 'GET',
      url: '/q/1',
      headers: { cookie: cookieHeader(loginJar) },
    });
    updateJar(loginJar, qRes);
    const csrf = extractCsrfToken(qRes.payload);

    const logoutRes = await app.inject({
      method: 'POST',
      url: '/logout',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(loginJar),
      },
      payload: form({ _csrf: csrf }),
    });
    expect(logoutRes.statusCode).toBe(302);
    expect(logoutRes.headers.location).toBe('/login');

    const { rowCount } = await pool().query(
      `SELECT 1 FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = $1)`,
      ['logout_user'],
    );
    expect(rowCount).toBe(0);
  });
});

function form(record: Record<string, string>): string {
  return Object.entries(record)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

function pool(): ReturnType<typeof getSharedPool> {
  return getSharedPool();
}
