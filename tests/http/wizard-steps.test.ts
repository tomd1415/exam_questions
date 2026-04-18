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

// Minimum-viable payloads for steps 1–8 that pass every parser. Tests that
// want to check just one step's behaviour thread these through all *other*
// steps so the happy path holds. Fixtures live here (not shared) because
// they're tied to the parsers' field names.
const STEP_FIELDS: Record<number, Record<string, string>> = {
  1: { component_code: 'J277/01', topic_code: '1.1', subtopic_code: '1.1.1' },
  2: { command_word_code: 'state', archetype_code: 'recall' },
  3: { expected_response_type: 'short_text' },
  4: {},
  5: { stem: 'State one role of the CPU.' },
  6: {
    marks: '1',
    model_answer: 'It fetches, decodes, and executes instructions.',
    mark_points: 'fetches instructions\ndecodes instructions\nexecutes instructions',
  },
  7: { misconceptions: '' },
  8: { difficulty_band: '3', difficulty_step: '1', source_type: 'teacher' },
};

async function postStep(
  jar: ReturnType<typeof newJar>,
  draftId: string,
  n: number,
  fields: Record<string, string>,
): Promise<ReturnType<typeof app.inject> extends Promise<infer T> ? T : never> {
  const { csrf } = await fetchCsrf(jar, `/admin/questions/wizard/${draftId}/step/${n}`);
  const res = await app.inject({
    method: 'POST',
    url: `/admin/questions/wizard/${draftId}/step/${n}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
    payload: form({ _csrf: csrf, ...fields }),
  });
  updateJar(jar, res);
  return res;
}

async function walkStepsUpTo(
  jar: ReturnType<typeof newJar>,
  draftId: string,
  stopAfter: number,
): Promise<void> {
  for (let n = 1; n <= stopAfter; n++) {
    const res = await postStep(jar, draftId, n, STEP_FIELDS[n]!);
    expect(res.statusCode, `step ${n} body=${res.payload.slice(0, 400)}`).toBe(302);
  }
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

  it('advances through every step with valid fields and lands at step 9', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);

    for (let n = 1; n <= 8; n++) {
      const res = await postStep(jar, draftId, n, STEP_FIELDS[n]!);
      expect(res.statusCode, `step ${n} body=${res.payload.slice(0, 400)}`).toBe(302);
      expect(res.headers.location).toBe(`/admin/questions/wizard/${draftId}/step/${n + 1}`);
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
      payload: form({ _csrf: csrf, ...STEP_FIELDS[1]! }),
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

describe('wizard per-step validation (chunk 2.5j step 3)', () => {
  it('step 1 rejects an empty body with a field issue', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);
    const res = await postStep(jar, draftId, 1, {});
    expect(res.statusCode).toBe(400);
    expect(res.payload).toContain('Pick a component.');
    expect(res.payload).toContain('Pick a topic.');
    expect(res.payload).toContain('Pick a subtopic.');
  });

  it('step 1 rejects a subtopic that does not belong to the topic', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);
    const res = await postStep(jar, draftId, 1, {
      component_code: 'J277/01',
      topic_code: '1.1',
      subtopic_code: '2.1.1',
    });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toContain('Subtopic');
    expect(res.payload).toContain('2.1.1');
    expect(res.payload).toContain('belongs to topic');
  });

  it('step 2 rejects an unknown command word', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);
    await postStep(jar, draftId, 1, STEP_FIELDS[1]!);
    const res = await postStep(jar, draftId, 2, {
      command_word_code: 'shout',
      archetype_code: 'recall',
    });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toContain('Unknown command word');
    expect(res.payload).toContain('shout');
  });

  it('step 3 persists expected_response_type and pre-selects it on revisit', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);
    await walkStepsUpTo(jar, draftId, 3);

    const res = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${draftId}/step/3`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    // The chosen widget tile is checked.
    expect(res.payload).toMatch(/value="short_text"\s+checked/);
  });

  it('step 6 rejects an empty model answer', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);
    await walkStepsUpTo(jar, draftId, 5);

    const res = await postStep(jar, draftId, 6, {
      marks: '2',
      model_answer: '',
      mark_points: 'one\ntwo',
    });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toContain('The model answer is required.');
  });

  it('step 6 splits mark_points on newlines and round-trips them on revisit', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);
    await walkStepsUpTo(jar, draftId, 6);

    const res = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${draftId}/step/6`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('fetches instructions');
    expect(res.payload).toContain('decodes instructions');
    expect(res.payload).toContain('executes instructions');
  });

  it('step 7 rejects a misconception line without the "label : description" format', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);
    await walkStepsUpTo(jar, draftId, 6);

    const res = await postStep(jar, draftId, 7, {
      misconceptions: 'no colon here',
    });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toContain('label : description');
  });

  it('step 8 clamps source_type to a known value', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);
    await walkStepsUpTo(jar, draftId, 7);

    const res = await postStep(jar, draftId, 8, {
      difficulty_band: '4',
      difficulty_step: '2',
      source_type: 'nonsense',
    });
    expect(res.statusCode).toBe(302);
    // Arriving on step 9, the review dl shows the default source_type.
    const review = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${draftId}/step/9`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(review.statusCode).toBe(200);
    expect(review.payload).toContain('teacher');
  });

  it('step 9 flags every missing field when the teacher jumps ahead', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);
    // Advance just through step 1 so the draft has current_step = 2 but all
    // later steps are empty. Visit step 9 directly.
    await postStep(jar, draftId, 1, STEP_FIELDS[1]!);

    const res = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${draftId}/step/9`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('Not ready to publish');
    expect(res.payload).toContain('Step 2: command word');
    expect(res.payload).toContain('Step 5: stem');
    expect(res.payload).toContain('Step 6: model answer');
  });
});
