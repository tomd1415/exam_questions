import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../helpers/app.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createUser, type CreatedUser } from '../helpers/fixtures.js';
import { cookieHeader, extractCsrfToken, newJar, updateJar } from '../helpers/cookies.js';

// Covers the /admin/content-guards surface: read-only admin
// protection, add-pattern POST, toggle POST, and the redirect/flash
// flow used by the form.

let app: FastifyInstance;
const pool = getSharedPool();

beforeAll(async () => {
  app = await buildTestApp();
});

beforeEach(async () => {
  await cleanDb();
  await pool.query(`DELETE FROM content_guard_patterns`);
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
  const loginGet = await app.inject({ method: 'GET', url: '/login' });
  updateJar(jar, loginGet);
  const token = extractCsrfToken(loginGet.payload);
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

async function getPageWithCsrf(
  jar: ReturnType<typeof newJar>,
  url: string,
): Promise<{ payload: string; csrf: string }> {
  const res = await app.inject({
    method: 'GET',
    url,
    headers: { cookie: cookieHeader(jar) },
  });
  expect(res.statusCode).toBe(200);
  updateJar(jar, res);
  return { payload: res.payload, csrf: extractCsrfToken(res.payload) };
}

describe('GET /admin/content-guards', () => {
  it('redirects anonymous users to /login', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/content-guards' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('forbids a pupil', async () => {
    const pupil = await createUser(pool, { role: 'pupil' });
    const jar = await loginAs(pupil);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/content-guards',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('forbids a teacher (admin-only surface)', async () => {
    const teacher = await createUser(pool, { role: 'teacher' });
    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/content-guards',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('renders both kind sections for an admin, even with no DB rows', async () => {
    const admin = await createUser(pool, { role: 'admin' });
    const jar = await loginAs(admin);
    const { payload } = await getPageWithCsrf(jar, '/admin/content-guards');
    expect(payload).toContain('Content guards');
    expect(payload).toContain('Safeguarding patterns');
    expect(payload).toContain('Prompt-injection patterns');
    expect(payload).toContain('No admin-added patterns');
  });
});

describe('POST /admin/content-guards', () => {
  it('adds a pattern and shows it on reload', async () => {
    const admin = await createUser(pool, { role: 'admin' });
    const jar = await loginAs(admin);
    const { csrf } = await getPageWithCsrf(jar, '/admin/content-guards');

    const postRes = await app.inject({
      method: 'POST',
      url: '/admin/content-guards',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({
        kind: 'safeguarding',
        pattern: 'kill myself',
        note: 'escalation phrase',
        _csrf: csrf,
      }),
    });
    expect(postRes.statusCode).toBe(302);
    expect(postRes.headers.location).toContain('/admin/content-guards');
    expect(postRes.headers.location).toContain('Pattern%20added');

    const { rows } = await pool.query<{
      kind: string;
      pattern: string;
      note: string | null;
      active: boolean;
    }>(`SELECT kind, pattern, note, active FROM content_guard_patterns`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('safeguarding');
    expect(rows[0]!.pattern).toBe('kill myself');
    expect(rows[0]!.note).toBe('escalation phrase');
    expect(rows[0]!.active).toBe(true);

    const { payload: reloaded } = await getPageWithCsrf(jar, '/admin/content-guards');
    expect(reloaded).toContain('kill myself');
    expect(reloaded).toContain('escalation phrase');
  });

  it('rejects a too-short pattern with a redirect flash', async () => {
    const admin = await createUser(pool, { role: 'admin' });
    const jar = await loginAs(admin);
    const { csrf } = await getPageWithCsrf(jar, '/admin/content-guards');

    const postRes = await app.inject({
      method: 'POST',
      url: '/admin/content-guards',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ kind: 'safeguarding', pattern: 'x', _csrf: csrf }),
    });
    expect(postRes.statusCode).toBe(302);
    expect(postRes.headers.location).toContain('between%202%20and%20200');

    const { rows } = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM content_guard_patterns`,
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('rejects the CSRF-less POST', async () => {
    const admin = await createUser(pool, { role: 'admin' });
    const jar = await loginAs(admin);
    const res = await app.inject({
      method: 'POST',
      url: '/admin/content-guards',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ kind: 'safeguarding', pattern: 'nope' }),
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });
});

describe('POST /admin/content-guards/:id/toggle', () => {
  it('disables and re-enables a pattern', async () => {
    const admin = await createUser(pool, { role: 'admin' });
    const jar = await loginAs(admin);

    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO content_guard_patterns (kind, pattern, note, created_by)
       VALUES ('prompt_injection', 'ignore previous instructions', null, $1::bigint)
       RETURNING id::text`,
      [admin.id],
    );
    const id = inserted.rows[0]!.id;

    const { csrf } = await getPageWithCsrf(jar, '/admin/content-guards');

    const disable = await app.inject({
      method: 'POST',
      url: `/admin/content-guards/${id}/toggle`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ active: 'false', _csrf: csrf }),
    });
    expect(disable.statusCode).toBe(302);
    expect(disable.headers.location).toContain('Pattern%20disabled');

    const afterDisable = await pool.query<{ active: boolean }>(
      `SELECT active FROM content_guard_patterns WHERE id = $1::bigint`,
      [id],
    );
    expect(afterDisable.rows[0]!.active).toBe(false);

    const { csrf: csrf2 } = await getPageWithCsrf(jar, '/admin/content-guards');
    const enable = await app.inject({
      method: 'POST',
      url: `/admin/content-guards/${id}/toggle`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ active: 'true', _csrf: csrf2 }),
    });
    expect(enable.statusCode).toBe(302);
    expect(enable.headers.location).toContain('re-enabled');

    const afterEnable = await pool.query<{ active: boolean }>(
      `SELECT active FROM content_guard_patterns WHERE id = $1::bigint`,
      [id],
    );
    expect(afterEnable.rows[0]!.active).toBe(true);
  });

  it('returns 404 for an unknown id', async () => {
    const admin = await createUser(pool, { role: 'admin' });
    const jar = await loginAs(admin);
    const { csrf } = await getPageWithCsrf(jar, '/admin/content-guards');

    const res = await app.inject({
      method: 'POST',
      url: '/admin/content-guards/99999999/toggle',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ active: 'false', _csrf: csrf }),
    });
    expect(res.statusCode).toBe(404);
  });
});
