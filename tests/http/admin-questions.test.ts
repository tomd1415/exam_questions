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
  expect(res.statusCode).toBe(302);
  updateJar(jar, res);
  return jar;
}

describe('GET /admin/questions', () => {
  it('redirects unauthenticated users to /login', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/questions' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('returns 403 for pupils', async () => {
    const pupil = await createUser(pool(), { role: 'pupil' });
    const jar = await loginAs(pupil);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/questions',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('renders the list with the seeded question for a teacher', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/questions',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('Systems architecture');
    expect(res.payload).toContain('describe');
    expect(res.payload).toContain('href="/admin/questions/1"');
    // Filter dropdown is wired.
    expect(res.payload).toContain('name="topic"');
    expect(res.payload).toContain('name="approval_status"');
  });

  it('filters by topic via the query string', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    await createQuestion(pool(), teacher.id, {
      topicCode: '1.2',
      subtopicCode: '1.2.1',
      stem: 'A unique 1.2 stem for filter test',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/admin/questions?topic=1.2',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('A unique 1.2 stem for filter test');
    // The seeded 1.1 question should not appear under topic=1.2.
    expect(res.payload).not.toContain('Inside the CPU is the Arithmetic Logic Unit');
  });

  it('ignores invalid query values without 500ing', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/questions?approval_status=not-a-status&active=maybe',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    // No filter applied → seeded question still listed.
    expect(res.payload).toContain('Systems architecture');
  });
});

describe('GET /admin/questions/:id', () => {
  it('returns 403 for pupils', async () => {
    const pupil = await createUser(pool(), { role: 'pupil' });
    const jar = await loginAs(pupil);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/questions/1',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('renders parts and mark points in display order for a teacher', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const created = await createQuestion(pool(), teacher.id, {
      stem: 'Two-part question',
      parts: [
        {
          label: '(a)',
          prompt: 'Part A prompt',
          marks: 1,
          expectedResponseType: 'short_text',
          markPoints: [{ text: 'Mark point A1' }, { text: 'Mark point A2' }],
        },
        {
          label: '(b)',
          prompt: 'Part B prompt',
          marks: 2,
          expectedResponseType: 'short_text',
          markPoints: [{ text: 'Mark point B1', isRequired: true }],
        },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: `/admin/questions/${created.id}`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('Two-part question');
    expect(res.payload).toContain('Part A prompt');
    expect(res.payload).toContain('Part B prompt');
    // Order: (a) appears before (b) in the rendered HTML.
    const idxA = res.payload.indexOf('Part A prompt');
    const idxB = res.payload.indexOf('Part B prompt');
    expect(idxA).toBeGreaterThan(0);
    expect(idxB).toBeGreaterThan(idxA);
    // Mark points appear in order.
    const idxA1 = res.payload.indexOf('Mark point A1');
    const idxA2 = res.payload.indexOf('Mark point A2');
    expect(idxA1).toBeLessThan(idxA2);
    // is_required surfaces.
    expect(res.payload).toContain('required');
  });

  it('returns 404 for an unknown id', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/questions/999999',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for a non-numeric id', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/questions/not-a-number',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(404);
  });
});
