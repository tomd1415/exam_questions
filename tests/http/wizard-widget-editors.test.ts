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
      url: `/admin/questions/wizard/${draftId}/step/5`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(get.statusCode).toBe(200);
    expect(get.payload).toContain('doesn');
    expect(get.payload).toContain('extra');

    const res = await postStep(jar, draftId, 5, {});
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/admin/questions/wizard/${draftId}/step/6`);
  });

  it('multiple_choice editor saves options + correct ticks and derives mark_points', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);
    await pickWidget(jar, draftId, 'multiple_choice', 'identify');

    const res = await postStep(jar, draftId, 5, {
      options: 'CPU\nRAM\nGPU\nSSD',
      correct_1: 'on',
    });
    expect(res.statusCode, `body=${res.payload.slice(0, 400)}`).toBe(302);

    const reload = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${draftId}/step/5`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(reload.statusCode).toBe(200);
    expect(reload.payload).toContain('CPU');
    expect(reload.payload).toContain('RAM');
    // Re-render keeps the second checkbox ticked.
    expect(reload.payload).toMatch(/name="correct_1"[^>]*checked/);

    // Step 6 should now show the derived mark point and hide the manual textarea.
    const step6 = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${draftId}/step/6`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(step6.statusCode).toBe(200);
    expect(step6.payload).toContain('Mark points (set on step 5)');
    expect(step6.payload).toContain('RAM');
    expect(step6.payload).not.toMatch(/name="mark_points"/);
  });

  it('multiple_choice rejects a body where no options are ticked correct', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);
    await pickWidget(jar, draftId, 'multiple_choice', 'identify');

    const res = await postStep(jar, draftId, 5, {
      options: 'CPU\nRAM\nGPU',
    });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toContain('Tick at least one option');
  });

  it('tick_box editor saves options and tickExactly and pre-fills them on re-render', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);
    await pickWidget(jar, draftId, 'tick_box', 'tick');

    const res = await postStep(jar, draftId, 5, {
      options: 'CPU\nRAM\nGPU\nSSD',
      tickExactly: '2',
      correct_0: 'on',
      correct_2: 'on',
    });
    expect(res.statusCode, `body=${res.payload.slice(0, 400)}`).toBe(302);

    const reload = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${draftId}/step/5`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(reload.statusCode).toBe(200);
    expect(reload.payload).toContain('CPU');
    expect(reload.payload).toContain('RAM');
    expect(reload.payload).toContain('value="2"');

    const step6 = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${draftId}/step/6`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(step6.statusCode).toBe(200);
    expect(step6.payload).toContain('mc-derived-mark-points');
    expect(step6.payload).toContain('CPU');
    expect(step6.payload).toContain('GPU');
  });

  it('tick_box rejects an empty options list with a field-level error', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);
    await pickWidget(jar, draftId, 'tick_box', 'tick');

    const res = await postStep(jar, draftId, 5, { options: '' });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toContain('at least one option');
  });

  it('tick_box rejects when no options are ticked correct', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);
    await pickWidget(jar, draftId, 'tick_box', 'tick');

    const res = await postStep(jar, draftId, 5, {
      options: 'CPU\nRAM\nGPU',
    });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toContain('at least one option as a correct');
  });

  it('tick_box rejects when ticked count does not match tickExactly', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);
    await pickWidget(jar, draftId, 'tick_box', 'tick');

    const res = await postStep(jar, draftId, 5, {
      options: 'CPU\nRAM\nGPU\nSSD',
      tickExactly: '2',
      correct_0: 'on',
    });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toContain('Tick exactly 2');
  });

  it('matrix_tick_single editor round-trips rows, columns, and per-row picks', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);
    await pickWidget(jar, draftId, 'matrix_tick_single', 'tick');

    const res = await postStep(jar, draftId, 5, {
      rows: 'Bubble sort\nLinear search',
      columns: 'Sorting\nSearching',
      correct_0: 'Sorting',
      correct_1: 'Searching',
    });
    expect(res.statusCode, `body=${res.payload.slice(0, 400)}`).toBe(302);

    const reload = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${draftId}/step/5`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(reload.statusCode).toBe(200);
    expect(reload.payload).toContain('Bubble sort');
    expect(reload.payload).toContain('Linear search');
    // The "Sorting" radio for row 0 should be checked.
    expect(reload.payload).toMatch(/name="correct_0"[\s\S]*?value="Sorting"[\s\S]*?checked/);
  });

  it('matrix_tick_single rejects a correct value that is not in the columns list', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);
    await pickWidget(jar, draftId, 'matrix_tick_single', 'tick');

    const res = await postStep(jar, draftId, 5, {
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

    const ok = await postStep(jar, draftId, 5, {
      text: 'Eight bits make a {{u1}}.',
      gaps: 'u1|byte, octet',
    });
    expect(ok.statusCode, `body=${ok.payload.slice(0, 400)}`).toBe(302);

    // After save, re-render should show the passage and the gap line.
    const reload = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${draftId}/step/5`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(reload.statusCode).toBe(200);
    expect(reload.payload).toContain('Eight bits make a');
    expect(reload.payload).toContain('u1|byte, octet');

    // Now post a gap whose id is not referenced in {{...}} markers.
    const bad = await postStep(jar, draftId, 5, {
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

    const res = await postStep(jar, draftId, 5, {
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

    const res = await postStep(jar, draftId, 5, {
      left: 'HTTP\nSMTP',
      right: 'web pages\nemail\nfile transfer',
      right_for_0: '0',
      right_for_1: '1',
    });
    expect(res.statusCode, `body=${res.payload.slice(0, 400)}`).toBe(302);

    const reload = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${draftId}/step/5`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(reload.statusCode).toBe(200);
    expect(reload.payload).toContain('HTTP');
    expect(reload.payload).toContain('email');
    expect(reload.payload).toMatch(/name="right_for_0"[\s\S]*?value="0"[\s\S]*?selected/);
  });

  it('trace_table parses columns + rows + per-cell mode/value grid', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);
    await pickWidget(jar, draftId, 'trace_table', 'complete');

    const res = await postStep(jar, draftId, 5, {
      columns: 'i\ntotal',
      rows: '2',
      mode_0_0: 'prefill',
      value_0_0: '1',
      mode_0_1: 'expected',
      value_0_1: '2',
      mode_1_0: 'expected',
      value_1_0: '2',
      mode_1_1: 'expected',
      value_1_1: '6',
      mode: 'perCell',
    });
    expect(res.statusCode, `body=${res.payload.slice(0, 400)}`).toBe(302);

    const reload = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${draftId}/step/5`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(reload.statusCode).toBe(200);
    // Cell values pre-populate the per-cell text inputs on re-render.
    expect(reload.payload).toMatch(/name="value_0_0"\s+type="text"\s+value="1"/);
    expect(reload.payload).toMatch(/name="value_1_1"\s+type="text"\s+value="6"/);
    // The pre-filled cell should have its mode select set to "prefill".
    expect(reload.payload).toMatch(/id="mode_0_0"[\s\S]*?<option value="prefill" selected/);
  });

  it('trace_table flags a grid where no cells are marked Expected', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);
    await pickWidget(jar, draftId, 'trace_table', 'complete');

    const res = await postStep(jar, draftId, 5, {
      columns: 'i\ntotal',
      rows: '2',
      mode_0_0: 'prefill',
      value_0_0: '1',
      mode: 'perCell',
    });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toContain('Mark at least one cell as Expected');
  });

  it('matrix_tick_multi parses ticked cells from the checkbox grid', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);
    await pickWidget(jar, draftId, 'matrix_tick_multi', 'tick');

    const res = await postStep(jar, draftId, 5, {
      rows: 'TCP\nUDP',
      columns: 'Connection-oriented\nConnectionless\nReliable',
      cell_0_0: 'on',
      cell_0_2: 'on',
      cell_1_1: 'on',
      partialCredit: 'on',
    });
    expect(res.statusCode, `body=${res.payload.slice(0, 400)}`).toBe(302);

    const reload = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${draftId}/step/5`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(reload.statusCode).toBe(200);
    expect(reload.payload).toContain('TCP');
    expect(reload.payload).toContain('Connectionless');
    // The (TCP, Connection-oriented) and (TCP, Reliable) cells should be checked.
    expect(reload.payload).toMatch(/id="cell_0_0"[^>]*checked/);
    expect(reload.payload).toMatch(/id="cell_0_2"[^>]*checked/);
    expect(reload.payload).toMatch(/id="cell_1_1"[^>]*checked/);
  });

  it('logic_diagram and flowchart accept canvas dimensions', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);
    await pickWidget(jar, draftId, 'logic_diagram', 'draw');

    const res = await postStep(jar, draftId, 5, {
      canvas_width: '800',
      canvas_height: '500',
    });
    expect(res.statusCode, `body=${res.payload.slice(0, 400)}`).toBe(302);

    const reload = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${draftId}/step/5`,
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

    const ok = await postStep(jar, draftId, 5, {
      imageUrl: '/static/curated/network.svg',
      imageAlt: 'A small network diagram',
      width: '600',
      height: '360',
      hotspots: 'centre|260|140|100|60|switch, hub\nhost-1|40|40|120|40|client, host',
    });
    expect(ok.statusCode, `body=${ok.payload.slice(0, 400)}`).toBe(302);

    const bad = await postStep(jar, draftId, 5, {
      imageUrl: 'http://insecure.example/network.svg',
      imageAlt: 'A network diagram',
      width: '600',
      height: '360',
      hotspots: 'centre|260|140|100|60|switch',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.payload).toContain('/static/');
  });

  it('diagram_labels editor exposes the hotspot picker hooks', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const draftId = await startDraft(jar);
    await pickWidget(jar, draftId, 'diagram_labels', 'label');

    const reload = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${draftId}/step/5`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(reload.statusCode).toBe(200);
    expect(reload.payload).toContain('data-widget-editor="diagram_labels"');
    expect(reload.payload).toContain('data-picker="hotspot-stage"');
    expect(reload.payload).toContain('/static/wizard_hotspot_picker.js');
  });
});
