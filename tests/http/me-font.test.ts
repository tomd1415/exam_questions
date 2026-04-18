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

describe('POST /me/preferences/font (Chunk 7)', () => {
  it('unauthenticated POST redirects to /login', async () => {
    const jar = newJar();
    const getLogin = await app.inject({ method: 'GET', url: '/login' });
    updateJar(jar, getLogin);
    const token = extractCsrfToken(getLogin.payload);
    const res = await app.inject({
      method: 'POST',
      url: '/me/preferences/font',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
      payload: form({ _csrf: token, font: 'dyslexic' }),
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('toggles data-font on next render', async () => {
    const pupil = await createUser(getSharedPool(), { role: 'pupil' });
    const jar = await loginAs(pupil);

    const before = await app.inject({
      method: 'GET',
      url: '/me/preferences',
      headers: { cookie: cookieHeader(jar) },
    });
    updateJar(jar, before);
    expect(before.statusCode).toBe(200);
    expect(before.payload).toContain('<html lang="en" data-font="system">');
    const csrf = extractCsrfToken(before.payload);

    const post = await app.inject({
      method: 'POST',
      url: '/me/preferences/font',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
      payload: form({ _csrf: csrf, font: 'dyslexic' }),
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
    expect(after.payload).toContain('<html lang="en" data-font="dyslexic">');
  });

  it('teachers can also toggle their font preference', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const prefs = await app.inject({
      method: 'GET',
      url: '/me/preferences',
      headers: { cookie: cookieHeader(jar) },
    });
    updateJar(jar, prefs);
    expect(prefs.statusCode).toBe(200);
    const csrf = extractCsrfToken(prefs.payload);
    const post = await app.inject({
      method: 'POST',
      url: '/me/preferences/font',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
      payload: form({ _csrf: csrf, font: 'dyslexic' }),
    });
    expect(post.statusCode).toBe(302);
  });

  it('rejects an invalid font value with 400', async () => {
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
      url: '/me/preferences/font',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
      payload: form({ _csrf: csrf, font: 'comic-sans' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('site.css declares @font-face for OpenDyslexic and a data-font branch', async () => {
    const css = await app.inject({ method: 'GET', url: '/static/site.css' });
    expect(css.statusCode).toBe(200);
    expect(css.payload).toContain("font-family: 'OpenDyslexic'");
    expect(css.payload).toContain("html[data-font='dyslexic']");
    const woff = await app.inject({
      method: 'GET',
      url: '/static/fonts/opendyslexic-latin-400-normal.woff2',
    });
    expect(woff.statusCode).toBe(200);
  });
});
