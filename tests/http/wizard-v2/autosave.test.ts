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
  const loc = create.headers.location ?? '';
  const id = /\/admin\/questions\/wizard\/(\d+)\/step\/1/.exec(loc)?.[1];
  if (!id) throw new Error('Could not extract draft id');
  return id;
}

async function stepCsrf(
  jar: ReturnType<typeof newJar>,
  draftId: string,
  step: number,
): Promise<string> {
  const res = await app.inject({
    method: 'GET',
    url: `/admin/questions/wizard/${draftId}/step/${step}`,
    headers: { cookie: cookieHeader(jar) },
  });
  updateJar(jar, res);
  return extractCsrfToken(res.payload);
}

describe('Wizard v2 autosave (Chunk 2.5q)', () => {
  it('POST .../autosave with valid step-4 patch returns 204 and merges payload without advancing', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const id = await createDraft(jar);
    const csrf = await stepCsrf(jar, id, 4);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/questions/wizard/${id}/step/4/autosave`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
      payload: form({ _csrf: csrf, stem: 'Define the term cache.' }),
    });
    expect(res.statusCode).toBe(204);

    const pool = getSharedPool();
    const { rows } = await pool.query<{ current_step: number; payload: unknown }>(
      `SELECT current_step, payload FROM question_drafts WHERE id = $1::bigint`,
      [id],
    );
    expect(rows[0]!.current_step).toBe(1);
    const payload = rows[0]!.payload as { stem?: string };
    expect(payload.stem).toBe('Define the term cache.');
  });

  it('does not emit a question.draft.advanced audit row on autosave', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const id = await createDraft(jar);
    const csrf = await stepCsrf(jar, id, 4);

    await app.inject({
      method: 'POST',
      url: `/admin/questions/wizard/${id}/step/4/autosave`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
      payload: form({ _csrf: csrf, stem: 'x' }),
    });

    const pool = getSharedPool();
    const { rows } = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM audit_events WHERE event_type = 'question.draft.advanced'`,
    );
    expect(rows[0]!.c).toBe('0');
  });

  it('rejects autosave without CSRF', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const id = await createDraft(jar);
    const res = await app.inject({
      method: 'POST',
      url: `/admin/questions/wizard/${id}/step/4/autosave`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
      payload: form({ stem: 'no csrf' }),
    });
    expect([400, 403]).toContain(res.statusCode);
  });

  it('autosave on another teacher\u2019s draft returns 403', async () => {
    const pool = getSharedPool();
    const owner = await createUser(pool, { role: 'teacher' });
    const intruder = await createUser(pool, { role: 'teacher' });
    const ownerJar = await loginAs(owner);
    const id = await createDraft(ownerJar);

    const intruderJar = await loginAs(intruder);
    // The intruder can't see the owner's step (403), so pull CSRF from
    // their own drafts list instead.
    const list = await app.inject({
      method: 'GET',
      url: '/admin/questions/wizard',
      headers: { cookie: cookieHeader(intruderJar) },
    });
    updateJar(intruderJar, list);
    const csrf = extractCsrfToken(list.payload);
    const res = await app.inject({
      method: 'POST',
      url: `/admin/questions/wizard/${id}/step/4/autosave`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(intruderJar),
      },
      payload: form({ _csrf: csrf, stem: 'malicious' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('autosave with invalid step-6 patch returns 422 with field issues', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const id = await createDraft(jar);
    const csrf = await stepCsrf(jar, id, 6);

    // Step 6 requires marks, model_answer, and mark_points. Sending only
    // a nonsense marks value should surface issues in the 422 body.
    const res = await app.inject({
      method: 'POST',
      url: `/admin/questions/wizard/${id}/step/6/autosave`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
      payload: form({ _csrf: csrf, marks: '-1' }),
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.payload) as { ok: boolean; issues: unknown[] };
    expect(body.ok).toBe(false);
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it('wizard_autosave.js is served and the step form exposes the autosave URL', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const id = await createDraft(jar);
    const step = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${id}/step/1`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(step.payload).toContain('/static/v2/wizard_autosave.js');
    expect(step.payload).toContain(
      `data-autosave-url="/admin/questions/wizard/${id}/step/1/autosave"`,
    );

    const js = await app.inject({ method: 'GET', url: '/static/v2/wizard_autosave.js' });
    expect(js.statusCode).toBe(200);
  });

  it('autosave pulse from step 4 → 5 preserves current_step across subsequent autosaves', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const id = await createDraft(jar);
    // Advance to step 3 (the real advance bumps current_step).
    // Direct SQL update to avoid brittle multi-step form submissions.
    const pool = getSharedPool();
    await pool.query(`UPDATE question_drafts SET current_step = 3 WHERE id = $1::bigint`, [id]);
    const csrf = await stepCsrf(jar, id, 4);
    await app.inject({
      method: 'POST',
      url: `/admin/questions/wizard/${id}/step/4/autosave`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
      payload: form({ _csrf: csrf, stem: 'a' }),
    });
    await app.inject({
      method: 'POST',
      url: `/admin/questions/wizard/${id}/step/4/autosave`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
      payload: form({ _csrf: csrf, stem: 'ab' }),
    });
    const { rows } = await pool.query<{ current_step: number }>(
      `SELECT current_step FROM question_drafts WHERE id = $1::bigint`,
      [id],
    );
    expect(rows[0]!.current_step).toBe(3);
  });
});
