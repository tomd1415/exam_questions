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

describe('POST /me/preferences/theme (Chunk 2.5n)', () => {
  it('unauthenticated POST redirects to /login', async () => {
    const jar = newJar();
    const getLogin = await app.inject({ method: 'GET', url: '/login' });
    updateJar(jar, getLogin);
    const token = extractCsrfToken(getLogin.payload);
    const res = await app.inject({
      method: 'POST',
      url: '/me/preferences/theme',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
      payload: form({ _csrf: token, theme: 'dark' }),
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('new users render with data-theme="auto" by default', async () => {
    const pupil = await createUser(getSharedPool(), { role: 'pupil' });
    const jar = await loginAs(pupil);
    const res = await app.inject({
      method: 'GET',
      url: '/me/preferences',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('data-theme="auto"');
  });

  it('toggling to dark updates data-theme on next render', async () => {
    const pupil = await createUser(getSharedPool(), { role: 'pupil' });
    const jar = await loginAs(pupil);
    const prefs = await app.inject({
      method: 'GET',
      url: '/me/preferences',
      headers: { cookie: cookieHeader(jar) },
    });
    updateJar(jar, prefs);
    const csrf = extractCsrfToken(prefs.payload);
    const post = await app.inject({
      method: 'POST',
      url: '/me/preferences/theme',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
      payload: form({ _csrf: csrf, theme: 'dark' }),
    });
    expect(post.statusCode).toBe(302);
    expect(post.headers.location).toMatch(/^\/me\/preferences\?flash=/);
    updateJar(jar, post);

    const after = await app.inject({
      method: 'GET',
      url: '/me/preferences',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(after.statusCode).toBe(200);
    expect(after.payload).toContain('data-theme="dark"');
  });

  it('teachers can also toggle their theme preference', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const prefs = await app.inject({
      method: 'GET',
      url: '/me/preferences',
      headers: { cookie: cookieHeader(jar) },
    });
    updateJar(jar, prefs);
    const csrf = extractCsrfToken(prefs.payload);
    const post = await app.inject({
      method: 'POST',
      url: '/me/preferences/theme',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
      payload: form({ _csrf: csrf, theme: 'light' }),
    });
    expect(post.statusCode).toBe(302);
  });

  it('rejects an invalid theme value with 400', async () => {
    const pupil = await createUser(getSharedPool(), { role: 'pupil' });
    const jar = await loginAs(pupil);
    const prefs = await app.inject({
      method: 'GET',
      url: '/me/preferences',
      headers: { cookie: cookieHeader(jar) },
    });
    updateJar(jar, prefs);
    const csrf = extractCsrfToken(prefs.payload);
    const res = await app.inject({
      method: 'POST',
      url: '/me/preferences/theme',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
      payload: form({ _csrf: csrf, theme: 'sepia' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('design-tokens.css declares the dark override block and warm-amber ramp', async () => {
    const css = await app.inject({ method: 'GET', url: '/static/design-tokens.css' });
    expect(css.statusCode).toBe(200);
    expect(css.payload).toContain("[data-theme='dark']");
    expect(css.payload).toContain('--color-accent-warm-500');
    expect(css.payload).toContain('--font-display');
    expect(css.payload).toContain('--duration-fast');
    expect(css.payload).toMatch(/@media \(prefers-color-scheme: dark\)/);
    expect(css.payload).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });

  it('writes an audit row on theme change', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const prefs = await app.inject({
      method: 'GET',
      url: '/me/preferences',
      headers: { cookie: cookieHeader(jar) },
    });
    updateJar(jar, prefs);
    const csrf = extractCsrfToken(prefs.payload);
    await app.inject({
      method: 'POST',
      url: '/me/preferences/theme',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
      payload: form({ _csrf: csrf, theme: 'dark' }),
    });
    const pool = getSharedPool();
    const { rows } = await pool.query<{ event_type: string; details: { theme: string } }>(
      `SELECT event_type, details FROM audit_events
         WHERE event_type = 'user.theme_preference.set'
         ORDER BY id DESC LIMIT 1`,
    );
    expect(rows[0]?.event_type).toBe('user.theme_preference.set');
    expect(rows[0]?.details?.theme).toBe('dark');
  });
});
