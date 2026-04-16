import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../helpers/app.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createUser, type CreatedUser } from '../helpers/fixtures.js';
import {
  cookieHeader,
  extractCsrfToken,
  newJar,
  updateJar,
  type CookieJar,
} from '../helpers/cookies.js';

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

async function loginAs(user: CreatedUser): Promise<CookieJar> {
  const jar = newJar();
  const formRes = await app.inject({ method: 'GET', url: '/login' });
  updateJar(jar, formRes);
  const token = extractCsrfToken(formRes.payload);

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

describe('GET /q/:id', () => {
  it('redirects to /login when unauthenticated', async () => {
    const res = await app.inject({ method: 'GET', url: '/q/1' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('renders the question for an authenticated user', async () => {
    const user = await createUser(getSharedPool(), { role: 'pupil' });
    const jar = await loginAs(user);
    const res = await app.inject({
      method: 'GET',
      url: '/q/1',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('Inside the CPU is the Arithmetic Logic Unit');
    expect(res.payload).toContain('Describe the purpose of the ALU');
    expect(res.payload).toContain('name="_csrf"');
  });

  it('returns 404 for an unknown question', async () => {
    const user = await createUser(getSharedPool());
    const jar = await loginAs(user);
    const res = await app.inject({
      method: 'GET',
      url: '/q/999999',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /q/:id', () => {
  it('rejects without CSRF (403)', async () => {
    const user = await createUser(getSharedPool());
    const jar = await loginAs(user);
    const res = await app.inject({
      method: 'POST',
      url: '/q/1',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: 'part_1=anything',
    });
    expect(res.statusCode).toBe(403);
  });

  it('saves an attempt and audit row, then redirects to /q/:id?saved=N', async () => {
    const pool = getSharedPool();
    const user = await createUser(pool, { role: 'pupil' });
    const jar = await loginAs(user);

    const getRes = await app.inject({
      method: 'GET',
      url: '/q/1',
      headers: { cookie: cookieHeader(jar) },
    });
    updateJar(jar, getRes);
    const csrf = extractCsrfToken(getRes.payload);

    // Find the textarea name to know the part id we have to submit.
    const partMatch = /name="part_(\d+)"/.exec(getRes.payload);
    expect(partMatch).not.toBeNull();
    const partFieldName = `part_${partMatch![1]!}`;

    const postRes = await app.inject({
      method: 'POST',
      url: '/q/1',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({
        _csrf: csrf,
        [partFieldName]: 'It performs arithmetic and logical operations on data.',
      }),
    });

    expect(postRes.statusCode).toBe(302);
    expect(postRes.headers.location).toMatch(/^\/q\/1\?saved=\d+$/);

    const attempts = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM attempts WHERE user_id = $1::bigint`,
      [user.id],
    );
    expect(attempts.rows[0]!.count).toBe('1');

    const parts = await pool.query<{ raw_answer: string }>(
      `SELECT raw_answer FROM attempt_parts
        WHERE attempt_question_id = (
          SELECT id FROM attempt_questions
           WHERE attempt_id = (SELECT id FROM attempts WHERE user_id = $1::bigint LIMIT 1)
           LIMIT 1)`,
      [user.id],
    );
    expect(parts.rows[0]?.raw_answer).toContain('arithmetic and logical');

    const audit = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM audit_events
        WHERE actor_user_id = $1::bigint AND event_type = 'attempt.submitted'`,
      [user.id],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('on follow-up GET with saved query string, renders the success flash', async () => {
    const pool = getSharedPool();
    const user = await createUser(pool);
    const jar = await loginAs(user);

    const getRes = await app.inject({
      method: 'GET',
      url: '/q/1',
      headers: { cookie: cookieHeader(jar) },
    });
    updateJar(jar, getRes);
    const csrf = extractCsrfToken(getRes.payload);
    const partMatch = /name="part_(\d+)"/.exec(getRes.payload);
    const partFieldName = `part_${partMatch![1]!}`;

    const postRes = await app.inject({
      method: 'POST',
      url: '/q/1',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ _csrf: csrf, [partFieldName]: 'arithmetic and logic' }),
    });

    const followUp = await app.inject({
      method: 'GET',
      url: postRes.headers.location!,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(followUp.statusCode).toBe(200);
    expect(followUp.payload).toContain('Submitted. Saved as attempt');
  });
});
