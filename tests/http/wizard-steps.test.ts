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

async function fetchCsrf(
  jar: ReturnType<typeof newJar>,
  url: string,
): Promise<{ csrf: string; payload: string }> {
  const res = await app.inject({ method: 'GET', url, headers: { cookie: cookieHeader(jar) } });
  updateJar(jar, res);
  return { csrf: extractCsrfToken(res.payload), payload: res.payload };
}

async function startDraft(jar: ReturnType<typeof newJar>): Promise<string> {
  const { csrf } = await fetchCsrf(jar, '/admin/questions/wizard');
  const res = await app.inject({
    method: 'POST',
    url: '/admin/questions/wizard/new',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
    payload: form({ _csrf: csrf }),
  });
  expect(res.statusCode).toBe(302);
  updateJar(jar, res);
  const loc = res.headers.location!;
  const m = /\/admin\/questions\/wizard\/(\d+)\/step\/1$/.exec(loc);
  expect(m).not.toBeNull();
  return m![1]!;
}

describe('wizard scaffolding (chunk 2.5j step 2)', () => {
  it('redirects unauthenticated users to /login', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/questions/wizard' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('forbids pupils', async () => {
    const pupil = await createUser(pool(), { role: 'pupil' });
    const jar = await loginAs(pupil);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/questions/wizard',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('renders an empty drafts list for a brand-new teacher', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/questions/wizard',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('My question drafts');
    expect(res.payload).toContain('No drafts in progress');
  });

  it('starts a draft via POST and redirects to step 1', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);

    const stepRes = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${draftId}/step/1`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(stepRes.statusCode).toBe(200);
    expect(stepRes.payload).toContain('Step 1 of 9');
    expect(stepRes.payload).toContain('Where does this question live');
  });

  it('refuses POST /admin/questions/wizard/new without CSRF', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'POST',
      url: '/admin/questions/wizard/new',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
      payload: '',
    });
    expect(res.statusCode).toBe(403);
  });

  it('advances through every step by repeated POST and lands at step 9', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);

    for (let n = 1; n <= 8; n++) {
      const { csrf } = await fetchCsrf(jar, `/admin/questions/wizard/${draftId}/step/${n}`);
      const res = await app.inject({
        method: 'POST',
        url: `/admin/questions/wizard/${draftId}/step/${n}`,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: cookieHeader(jar),
        },
        payload: form({ _csrf: csrf }),
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(`/admin/questions/wizard/${draftId}/step/${n + 1}`);
      updateJar(jar, res);
    }

    const last = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${draftId}/step/9`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(last.statusCode).toBe(200);
    expect(last.payload).toContain('Step 9 of 9');
    expect(last.payload).toContain('Publish question');
  });

  it('refuses step POST without CSRF', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);
    const res = await app.inject({
      method: 'POST',
      url: `/admin/questions/wizard/${draftId}/step/1`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
      payload: '',
    });
    expect(res.statusCode).toBe(403);
  });

  it('one teacher cannot view or advance another teacher’s draft', async () => {
    const alice = await createUser(pool(), { role: 'teacher' });
    const bob = await createUser(pool(), { role: 'teacher' });
    const aliceJar = await loginAs(alice);
    const draftId = await startDraft(aliceJar);

    const bobJar = await loginAs(bob);
    const get = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${draftId}/step/1`,
      headers: { cookie: cookieHeader(bobJar) },
    });
    expect(get.statusCode).toBe(403);

    const { csrf } = await fetchCsrf(bobJar, '/admin/questions/wizard');
    const post = await app.inject({
      method: 'POST',
      url: `/admin/questions/wizard/${draftId}/step/1`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(bobJar),
      },
      payload: form({ _csrf: csrf }),
    });
    expect(post.statusCode).toBe(403);
  });

  it('returns 404 for an unknown draft id', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/questions/wizard/9999999/step/1',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(404);
  });

  it('shows a resume row in the drafts list after starting one', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);
    const list = await app.inject({
      method: 'GET',
      url: '/admin/questions/wizard',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(list.statusCode).toBe(200);
    expect(list.payload).toContain('Resume');
    expect(list.payload).toContain(`/admin/questions/wizard/${draftId}/step/1`);
  });
});
