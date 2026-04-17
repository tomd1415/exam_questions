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

function assertAllButtonsVariant(payload: string, url: string): void {
  const matches = Array.from(payload.matchAll(/<button\b[^>]*>/g));
  expect(matches.length, `${url} rendered no <button> elements`).toBeGreaterThan(0);
  for (const m of matches) {
    const tag = m[0];
    expect(
      /class="[^"]*\bbtn\b[^"]*"/.test(tag),
      `button on ${url} is missing a .btn class: ${tag}`,
    ).toBe(true);
    expect(
      /class="[^"]*\bbtn--(primary|secondary|ghost|danger)\b[^"]*"/.test(tag),
      `button on ${url} is missing a .btn--* variant: ${tag}`,
    ).toBe(true);
  }
}

describe('button variants (Chunk 6a)', () => {
  it('every button on /login has a .btn--* variant', async () => {
    const res = await app.inject({ method: 'GET', url: '/login' });
    expect(res.statusCode).toBe(200);
    assertAllButtonsVariant(res.payload, '/login');
  });

  it('every button on /topics has a .btn--* variant', async () => {
    const pupil = await createUser(getSharedPool(), { role: 'pupil' });
    const jar = await loginAs(pupil);
    const res = await app.inject({
      method: 'GET',
      url: '/topics',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    assertAllButtonsVariant(res.payload, '/topics');
  });

  it('every button on /admin/classes/new has a .btn--* variant', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/classes/new',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    assertAllButtonsVariant(res.payload, '/admin/classes/new');
  });
});
