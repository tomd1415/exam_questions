import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../helpers/app.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createUser, type CreatedUser } from '../helpers/fixtures.js';
import { cookieHeader, extractCsrfToken, newJar, updateJar } from '../helpers/cookies.js';

// Proves the command-word → widget compatibility map is wired into the
// step-3 template. The wizard's day-one UX hinges on this: a teacher who
// picked "write_rewrite" must not be nudged toward a tick-box or a
// cloze-with-bank, and a teacher who picked "complete" must see trace_table
// in the recommended list.

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

async function fetchCsrf(jar: ReturnType<typeof newJar>, url: string): Promise<string> {
  const res = await app.inject({ method: 'GET', url, headers: { cookie: cookieHeader(jar) } });
  updateJar(jar, res);
  return extractCsrfToken(res.payload);
}

async function postStep(
  jar: ReturnType<typeof newJar>,
  draftId: string,
  n: number,
  fields: Record<string, string>,
): Promise<void> {
  const csrf = await fetchCsrf(jar, `/admin/questions/wizard/${draftId}/step/${n}`);
  const res = await app.inject({
    method: 'POST',
    url: `/admin/questions/wizard/${draftId}/step/${n}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
    payload: form({ _csrf: csrf, ...fields }),
  });
  expect(res.statusCode, `POST step ${n} body=${res.payload.slice(0, 300)}`).toBe(302);
  updateJar(jar, res);
}

async function startDraft(jar: ReturnType<typeof newJar>): Promise<string> {
  const csrf = await fetchCsrf(jar, '/admin/questions/wizard');
  const res = await app.inject({
    method: 'POST',
    url: '/admin/questions/wizard/new',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
    payload: form({ _csrf: csrf }),
  });
  expect(res.statusCode).toBe(302);
  updateJar(jar, res);
  return /\/step\/1$/.exec(res.headers.location!)
    ? /wizard\/(\d+)\/step/.exec(res.headers.location!)![1]!
    : '';
}

function sliceRecommended(html: string): string {
  const start = html.indexOf('data-section="recommended"');
  if (start === -1) return '';
  // The "other" widgets are rendered under admin-wizard__more-widgets — use
  // it as the end marker (it comes after the recommended grid closes).
  const end = html.indexOf('admin-wizard__more-widgets', start);
  return html.slice(start, end === -1 ? html.length : end);
}

function sliceOther(html: string): string {
  const start = html.indexOf('admin-wizard__more-widgets');
  if (start === -1) return '';
  return html.slice(start);
}

describe('wizard widget-filter (chunk 2.5j step 3)', () => {
  it('write_rewrite does not show matrix_tick_single or cloze_with_bank in recommended', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);

    await postStep(jar, draftId, 1, {
      component_code: 'J277/02',
      topic_code: '2.1',
      subtopic_code: '2.1.2',
    });
    await postStep(jar, draftId, 2, {
      command_word_code: 'write_rewrite',
      archetype_code: 'code_writing',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${draftId}/step/3`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);

    const recommended = sliceRecommended(res.payload);
    const other = sliceOther(res.payload);

    // Recommended ones for write_rewrite per COMMAND_WORD_WIDGETS.
    expect(recommended).toContain('value="code"');
    expect(recommended).toContain('value="algorithm"');
    expect(recommended).toContain('value="medium_text"');
    expect(recommended).toContain('value="extended_response"');

    // These would be a strange fit for "write an algorithm" — they must be
    // in the "Other widgets" fold, not in the recommended grid.
    expect(recommended).not.toContain('value="matrix_tick_single"');
    expect(recommended).not.toContain('value="cloze_with_bank"');
    expect(other).toContain('value="matrix_tick_single"');
    expect(other).toContain('value="cloze_with_bank"');
  });

  it('complete surfaces trace_table in the recommended widgets', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);

    await postStep(jar, draftId, 1, {
      component_code: 'J277/02',
      topic_code: '2.1',
      subtopic_code: '2.1.2',
    });
    await postStep(jar, draftId, 2, {
      command_word_code: 'complete',
      archetype_code: 'trace_table',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${draftId}/step/3`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);

    const recommended = sliceRecommended(res.payload);
    expect(recommended).toContain('value="trace_table"');
    expect(recommended).toContain('value="cloze_free"');
    expect(recommended).toContain('value="algorithm"');
  });

  it('tick recommends tick_box and the two matrix widgets, nothing else', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);

    await postStep(jar, draftId, 1, {
      component_code: 'J277/01',
      topic_code: '1.2',
      subtopic_code: '1.2.3',
    });
    await postStep(jar, draftId, 2, {
      command_word_code: 'tick',
      archetype_code: 'recall',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${draftId}/step/3`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);

    const recommended = sliceRecommended(res.payload);
    expect(recommended).toContain('value="tick_box"');
    expect(recommended).toContain('value="matrix_tick_single"');
    expect(recommended).toContain('value="matrix_tick_multi"');
    // An extended-response widget has no business being the recommended pick
    // for a tick-the-box question.
    expect(recommended).not.toContain('value="extended_response"');
  });
});
