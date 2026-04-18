import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../helpers/app.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createUser, type CreatedUser } from '../helpers/fixtures.js';
import { cookieHeader, extractCsrfToken, newJar, updateJar } from '../helpers/cookies.js';
import { EXPECTED_RESPONSE_TYPES } from '../../src/lib/question-invariants.js';

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

describe('GET /api/widgets', () => {
  it('rejects anonymous callers with 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/widgets' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects pupil callers with 403', async () => {
    const pupil = await createUser(getSharedPool(), { role: 'pupil' });
    const jar = await loginAs(pupil);
    const res = await app.inject({
      method: 'GET',
      url: '/api/widgets',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns the full registry to a teacher caller', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: '/api/widgets',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    interface WidgetView {
      type: string;
      marker: string;
      displayName: string;
      description: string;
      markPointGuidance: string;
      configSchema: unknown;
      exampleConfig: unknown;
    }
    const body = res.json<{ version: string; widgets: WidgetView[] }>();
    expect(typeof body.version).toBe('string');
    const types = body.widgets.map((w) => w.type).sort();
    expect(types).toEqual([...EXPECTED_RESPONSE_TYPES].sort());
    for (const w of body.widgets) {
      expect(w.displayName.length).toBeGreaterThan(0);
      expect(w.description.length).toBeGreaterThan(0);
      expect(w.markPointGuidance.length).toBeGreaterThan(0);
      expect(['deterministic', 'teacher_pending']).toContain(w.marker);
    }
  });

  it('does not leak any obviously sensitive fields', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: '/api/widgets',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    const raw = res.payload;
    for (const term of ['password', 'session', 'cookie', 'argon', 'secret', 'csrf']) {
      expect(raw.toLowerCase(), `unexpectedly leaks '${term}'`).not.toContain(term);
    }
  });
});
