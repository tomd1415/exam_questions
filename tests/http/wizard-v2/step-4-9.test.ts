import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../../helpers/app.js';
import { cleanDb, getSharedPool } from '../../helpers/db.js';
import { createUser, type CreatedUser } from '../../helpers/fixtures.js';
import { cookieHeader, extractCsrfToken, newJar, updateJar } from '../../helpers/cookies.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

beforeEach(async () => {
  await cleanDb();
  process.env['WIZARD_V2_ENABLED'] = '1';
});

afterEach(() => {
  delete process.env['WIZARD_V2_ENABLED'];
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

async function createDraft(jar: ReturnType<typeof newJar>): Promise<string> {
  const list = await app.inject({
    method: 'GET',
    url: '/admin/questions/wizard',
    headers: { cookie: cookieHeader(jar) },
  });
  updateJar(jar, list);
  const csrf = extractCsrfToken(list.payload);
  const create = await app.inject({
    method: 'POST',
    url: '/admin/questions/wizard/new',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
    payload: form({ _csrf: csrf }),
  });
  expect(create.statusCode).toBe(302);
  const id = /\/admin\/questions\/wizard\/(\d+)\/step\/1/.exec(create.headers.location ?? '')?.[1];
  if (!id) throw new Error('Could not extract draft id');
  return id;
}

describe('Wizard v2 step 4 + 8 + 9 upgrades (Chunk 2.5s)', () => {
  it('step 4 renders a live char counter with the current stem length', async () => {
    const pool = getSharedPool();
    const teacher = await createUser(pool, { role: 'teacher' });
    const jar = await loginAs(teacher);
    const id = await createDraft(jar);
    await pool.query(
      `UPDATE question_drafts SET payload = payload || '{"stem":"Hello"}'::jsonb WHERE id = $1::bigint`,
      [id],
    );
    const res = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${id}/step/4`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('data-wizard-char-counter="wizard-stem-counter"');
    expect(res.payload).toContain('data-char-count');
    expect(res.payload).toContain('/ 4000 characters');
    // Server-rendered count matches the stem length.
    expect(res.payload).toMatch(/<span data-char-count>\s*5\s*<\/span>/);
  });

  it('step 4 flag-off still renders the v1 textarea without the counter', async () => {
    process.env['WIZARD_V2_ENABLED'] = '0';
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const id = await createDraft(jar);
    const res = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${id}/step/4`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.payload).not.toContain('data-wizard-char-counter');
  });

  it('step 8 renders a difficulty slider coupled with a hidden select', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const id = await createDraft(jar);
    const res = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${id}/step/8`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('data-wizard-difficulty');
    expect(res.payload).toContain('data-wizard-difficulty-range');
    expect(res.payload).toContain('data-wizard-difficulty-select');
    expect(res.payload).toMatch(/<input[^>]+type="range"/);
    expect(res.payload).toMatch(/<select[^>]+name="difficulty_band"/);
  });

  it('step 8 source chips render with all three options', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const id = await createDraft(jar);
    const res = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${id}/step/8`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.payload).toContain('value="teacher"');
    expect(res.payload).toContain('value="imported_pattern"');
    expect(res.payload).toContain('value="ai_generated"');
    expect(res.payload).toContain('data-wizard-chip-grid');
  });

  it('step 9 publish button ships the hold-to-confirm data attributes', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const id = await createDraft(jar);
    const res = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${id}/step/9`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('data-wizard-hold-confirm');
    expect(res.payload).toContain('data-hold-duration="1200"');
    expect(res.payload).toContain('data-hold-label-idle="Hold to publish"');
    expect(res.payload).toContain('data-wizard-publish-form');
  });

  it('step 9 flag-off publish form is byte-same v1 (no hold-confirm attrs)', async () => {
    process.env['WIZARD_V2_ENABLED'] = '0';
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const id = await createDraft(jar);
    const res = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${id}/step/9`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.payload).not.toContain('data-wizard-hold-confirm');
  });

  it('serves wizard_step_enhancements.js via /static/v2/ and the step page links to it', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const id = await createDraft(jar);
    const step = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${id}/step/4`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(step.payload).toContain('/static/v2/wizard_step_enhancements.js');
    const js = await app.inject({
      method: 'GET',
      url: '/static/v2/wizard_step_enhancements.js',
    });
    expect(js.statusCode).toBe(200);
  });
});
