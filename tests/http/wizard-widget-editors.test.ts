import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../helpers/app.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createUser, type CreatedUser } from '../helpers/fixtures.js';
import { cookieHeader, extractCsrfToken, newJar, updateJar } from '../helpers/cookies.js';

// Proves the per-widget step-4 editors actually parse, save, and re-render
// the part_config payloads. One round-trip per widget family is enough —
// the parsers themselves are unit-tested via the shape that lands in the
// database, and the registry's validateConfig acts as the second gate.

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

async function fetchCsrfAndBody(
  jar: ReturnType<typeof newJar>,
  url: string,
): Promise<{ csrf: string; body: string }> {
  const res = await app.inject({ method: 'GET', url, headers: { cookie: cookieHeader(jar) } });
  updateJar(jar, res);
  return { csrf: extractCsrfToken(res.payload), body: res.payload };
}

async function startDraft(jar: ReturnType<typeof newJar>): Promise<string> {
  const { csrf } = await fetchCsrfAndBody(jar, '/admin/questions/wizard');
  const res = await app.inject({
    method: 'POST',
    url: '/admin/questions/wizard/new',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
    payload: form({ _csrf: csrf }),
  });
  expect(res.statusCode).toBe(302);
  updateJar(jar, res);
  return /wizard\/(\d+)\/step/.exec(res.headers.location!)![1]!;
}

async function postStep(
  jar: ReturnType<typeof newJar>,
  draftId: string,
  n: number,
  fields: Record<string, string>,
): Promise<ReturnType<typeof app.inject> extends Promise<infer T> ? T : never> {
  const { csrf } = await fetchCsrfAndBody(jar, `/admin/questions/wizard/${draftId}/step/${n}`);
  const res = await app.inject({
    method: 'POST',
    url: `/admin/questions/wizard/${draftId}/step/${n}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
    payload: form({ _csrf: csrf, ...fields }),
  });
  updateJar(jar, res);
  return res;
}

async function pickWidget(
  jar: ReturnType<typeof newJar>,
  draftId: string,
  widget: string,
  cw = 'state',
): Promise<void> {
  // Step 1, 2, 3 with whatever cw/archetype keep the parsers happy.
  const r1 = await postStep(jar, draftId, 1, {
    component_code: 'J277/01',
    topic_code: '1.1',
    subtopic_code: '1.1.1',
  });
  expect(r1.statusCode, `step1 body=${r1.payload.slice(0, 200)}`).toBe(302);
  const r2 = await postStep(jar, draftId, 2, {
    command_word_code: cw,
    archetype_code: 'recall',
  });
  expect(r2.statusCode, `step2 body=${r2.payload.slice(0, 200)}`).toBe(302);
  const r3 = await postStep(jar, draftId, 3, { expected_response_type: widget });
  expect(r3.statusCode, `step3 body=${r3.payload.slice(0, 200)}`).toBe(302);
}

describe('wizard widget editors (chunk 2.5j step 4)', () => {
  it('noop widget (short_text) accepts an empty step-4 body and shows a no-op message', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);
    await pickWidget(jar, draftId, 'short_text');

    const get = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${draftId}/step/4`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(get.statusCode).toBe(200);
    expect(get.payload).toContain('doesn');
    expect(get.payload).toContain('extra');

    const res = await postStep(jar, draftId, 4, {});
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/admin/questions/wizard/${draftId}/step/5`);
  });

  it('tick_box editor saves options and tickExactly and pre-fills them on re-render', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);
    await pickWidget(jar, draftId, 'tick_box', 'tick');

    const res = await postStep(jar, draftId, 4, {
      options: 'CPU\nRAM\nGPU\nSSD',
      tickExactly: '2',
    });
    expect(res.statusCode, `body=${res.payload.slice(0, 400)}`).toBe(302);

    const reload = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${draftId}/step/4`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(reload.statusCode).toBe(200);
    expect(reload.payload).toContain('CPU');
    expect(reload.payload).toContain('RAM');
    expect(reload.payload).toContain('value="2"');
  });

  it('tick_box rejects an empty options list with a field-level error', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);
    await pickWidget(jar, draftId, 'tick_box', 'tick');

    const res = await postStep(jar, draftId, 4, { options: '' });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toContain('at least one option');
  });

  it('matrix_tick_single editor round-trips rows, columns, and per-row picks', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);
    await pickWidget(jar, draftId, 'matrix_tick_single', 'tick');

    const res = await postStep(jar, draftId, 4, {
      rows: 'Bubble sort\nLinear search',
      columns: 'Sorting\nSearching',
      correct_0: 'Sorting',
      correct_1: 'Searching',
    });
    expect(res.statusCode, `body=${res.payload.slice(0, 400)}`).toBe(302);

    const reload = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${draftId}/step/4`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(reload.statusCode).toBe(200);
    expect(reload.payload).toContain('Bubble sort');
    expect(reload.payload).toContain('Linear search');
    // The "Sorting" radio for row 0 should be checked.
    expect(reload.payload).toMatch(/name="correct_0" value="Sorting"\s+checked/);
  });

  it('matrix_tick_single rejects a correct value that is not in the columns list', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);
    await pickWidget(jar, draftId, 'matrix_tick_single', 'tick');

    const res = await postStep(jar, draftId, 4, {
      rows: 'Bubble sort',
      columns: 'Sorting\nSearching',
      correct_0: 'Compiling',
    });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toContain('not one of the columns');
  });

  it('cloze_free saves text + gaps and rejects gaps not referenced in the passage', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);
    await pickWidget(jar, draftId, 'cloze_free', 'complete');

    const ok = await postStep(jar, draftId, 4, {
      text: 'Eight bits make a {{u1}}.',
      gaps: 'u1|byte, octet',
    });
    expect(ok.statusCode, `body=${ok.payload.slice(0, 400)}`).toBe(302);

    // After save, re-render should show the passage and the gap line.
    const reload = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${draftId}/step/4`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(reload.statusCode).toBe(200);
    expect(reload.payload).toContain('Eight bits make a');
    expect(reload.payload).toContain('u1|byte, octet');

    // Now post a gap whose id is not referenced in {{...}} markers.
    const bad = await postStep(jar, draftId, 4, {
      text: 'Eight bits make a {{u1}}.',
      gaps: 'u1|byte\nu2|kilobyte',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.payload).toContain('not referenced in the passage');
  });

  it('cloze_with_bank requires a non-empty bank', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);
    await pickWidget(jar, draftId, 'cloze_with_bank', 'complete');

    const res = await postStep(jar, draftId, 4, {
      text: 'A {{d1}} forwards within a LAN.',
      gaps: 'd1|switch',
      bank: '',
    });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toContain('at least one bank entry');
  });

  it('matching round-trips left, right, and per-prompt right_for_<i>', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);
    await pickWidget(jar, draftId, 'matching', 'identify');

    const res = await postStep(jar, draftId, 4, {
      left: 'HTTP\nSMTP',
      right: 'web pages\nemail\nfile transfer',
      right_for_0: '0',
      right_for_1: '1',
    });
    expect(res.statusCode, `body=${res.payload.slice(0, 400)}`).toBe(302);

    const reload = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${draftId}/step/4`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(reload.statusCode).toBe(200);
    expect(reload.payload).toContain('HTTP');
    expect(reload.payload).toContain('email');
    expect(reload.payload).toMatch(/name="right_for_0"[\s\S]*?value="0" selected/);
  });

  it('trace_table parses columns + rows + cell maps', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);
    await pickWidget(jar, draftId, 'trace_table', 'complete');

    const res = await postStep(jar, draftId, 4, {
      columns: 'i\ntotal',
      rows: '2',
      prefill: '0,0=1',
      expected: '0,1=2\n1,0=2\n1,1=6',
      mode: 'perCell',
    });
    expect(res.statusCode, `body=${res.payload.slice(0, 400)}`).toBe(302);

    const reload = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${draftId}/step/4`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(reload.statusCode).toBe(200);
    expect(reload.payload).toContain('0,0=1');
    expect(reload.payload).toContain('1,1=6');
  });

  it('trace_table flags a cell whose row index is out of range', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);
    await pickWidget(jar, draftId, 'trace_table', 'complete');

    const res = await postStep(jar, draftId, 4, {
      columns: 'i\ntotal',
      rows: '2',
      expected: '5,0=99',
      mode: 'perCell',
    });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toContain('row index is out of range');
  });

  it('logic_diagram and flowchart accept canvas dimensions', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);
    await pickWidget(jar, draftId, 'logic_diagram', 'draw');

    const res = await postStep(jar, draftId, 4, {
      canvas_width: '800',
      canvas_height: '500',
    });
    expect(res.statusCode, `body=${res.payload.slice(0, 400)}`).toBe(302);

    const reload = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${draftId}/step/4`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(reload.statusCode).toBe(200);
    expect(reload.payload).toContain('value="800"');
    expect(reload.payload).toContain('value="500"');
  });

  it('diagram_labels parses hotspots and rejects bad image URLs', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);
    await pickWidget(jar, draftId, 'diagram_labels', 'label');

    const ok = await postStep(jar, draftId, 4, {
      imageUrl: '/static/curated/network.svg',
      imageAlt: 'A small network diagram',
      width: '600',
      height: '360',
      hotspots: 'centre|260|140|100|60|switch, hub\nhost-1|40|40|120|40|client, host',
    });
    expect(ok.statusCode, `body=${ok.payload.slice(0, 400)}`).toBe(302);

    const bad = await postStep(jar, draftId, 4, {
      imageUrl: 'http://insecure.example/network.svg',
      imageAlt: 'A network diagram',
      width: '600',
      height: '360',
      hotspots: 'centre|260|140|100|60|switch',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.payload).toContain('/static/');
  });
});
