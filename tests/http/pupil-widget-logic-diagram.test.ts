import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../helpers/app.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createQuestion, createUser, type CreatedUser } from '../helpers/fixtures.js';
import { cookieHeader, extractCsrfToken, newJar, updateJar } from '../helpers/cookies.js';
import { LOGIC_DIAGRAM_DATA_URL_PREFIX } from '../../src/lib/logic-diagram.js';

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

async function seedClassWithTopic(params: {
  teacher: CreatedUser;
  pupil: CreatedUser;
  topicCode: string;
}): Promise<void> {
  const p = pool();
  const { rows } = await p.query<{ id: string }>(
    `INSERT INTO classes (name, teacher_id, academic_year)
     VALUES ('Logic-diagram test', $1::bigint, '2025/26') RETURNING id::text`,
    [params.teacher.id],
  );
  const classId = rows[0]!.id;
  await p.query(`INSERT INTO enrolments (class_id, user_id) VALUES ($1::bigint, $2::bigint)`, [
    classId,
    params.pupil.id,
  ]);
  await p.query(
    `INSERT INTO class_assigned_topics (class_id, topic_code, assigned_by)
     VALUES ($1::bigint, $2, $3::bigint)`,
    [classId, params.topicCode, params.teacher.id],
  );
}

async function startTopicAttempt(
  jar: ReturnType<typeof newJar>,
  topicCode: string,
): Promise<string> {
  const listPage = await app.inject({
    method: 'GET',
    url: '/topics',
    headers: { cookie: cookieHeader(jar) },
  });
  updateJar(jar, listPage);
  const csrf = extractCsrfToken(listPage.payload);
  const startRes = await app.inject({
    method: 'POST',
    url: `/topics/${topicCode}/start`,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: cookieHeader(jar),
    },
    payload: form({ _csrf: csrf }),
  });
  expect(startRes.statusCode).toBe(302);
  updateJar(jar, startRes);
  return startRes.headers.location!;
}

const STUB_PNG = `${LOGIC_DIAGRAM_DATA_URL_PREFIX}iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=`;

describe('Pupil widget — logic_diagram', () => {
  it('renders a canvas + toolbar and round-trips a PNG dataURL', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    await seedClassWithTopic({ teacher, pupil, topicCode: '2.4' });
    await createQuestion(pool(), teacher.id, {
      componentCode: 'J277/02',
      topicCode: '2.4',
      subtopicCode: '2.4.1',
      active: true,
      approvalStatus: 'approved',
      stem: 'Draw the alarm logic diagram.',
      expectedResponseType: 'logic_diagram',
      parts: [
        {
          label: '(a)',
          prompt: 'Draw the alarm circuit.',
          marks: 4,
          expectedResponseType: 'logic_diagram',
          partConfig: {
            variant: 'image',
            canvas: { width: 500, height: 320 },
          },
          markPoints: [
            { text: 'OR gate fed by DOOR and WINDOW', marks: 1 },
            { text: 'AND gate fed by ARMED and the OR-gate output', marks: 1 },
            { text: 'ALARM taken from the AND gate output', marks: 1 },
            { text: 'Inputs and output clearly labelled', marks: 1 },
          ],
        },
      ],
    });

    const jar = await loginAs(pupil);
    const attemptUrl = await startTopicAttempt(jar, '2.4');

    const editPage = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(jar) },
    });
    updateJar(jar, editPage);
    expect(editPage.statusCode).toBe(200);
    const html = editPage.payload;
    expect(html).toMatch(/class="[^"]*\bwidget--logic-diagram\b/);
    expect(html).toMatch(/data-logic-diagram-canvas[^>]*width="500"/);
    expect(html).toMatch(/data-logic-diagram-canvas[^>]*height="320"/);
    expect(html).toMatch(/data-logic-diagram-tool="pen"/);
    expect(html).toMatch(/data-logic-diagram-tool="eraser"/);
    expect(html).toMatch(/data-logic-diagram-clear/);
    expect(html).toMatch(/data-logic-diagram-image/);

    const partMatch = /name="part_(\d+)__image"/.exec(html);
    expect(partMatch).not.toBeNull();
    const partId = partMatch![1]!;

    const csrf = extractCsrfToken(html);
    const payload =
      form({ _csrf: csrf }) + `&part_${partId}__image=${encodeURIComponent(STUB_PNG)}`;
    const saveRes = await app.inject({
      method: 'POST',
      url: `${attemptUrl}/save`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload,
    });
    expect(saveRes.statusCode).toBe(302);
    updateJar(jar, saveRes);

    const { rows } = await pool().query<{ raw_answer: string }>(
      `SELECT raw_answer FROM attempt_parts WHERE id = $1::bigint`,
      [partId],
    );
    const stored = rows[0]?.raw_answer ?? '';
    expect(stored).toBe(`image=${STUB_PNG}`);

    const reopen = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(reopen.statusCode).toBe(200);
    // The hidden input should reload with the prior PNG so the canvas can
    // repaint it on enhancement.
    expect(reopen.payload).toContain(`value="${STUB_PNG}"`);
  });

  it('guided_slots: renders dropdowns and marks each slot', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    await seedClassWithTopic({ teacher, pupil, topicCode: '2.4' });
    await createQuestion(pool(), teacher.id, {
      componentCode: 'J277/02',
      topicCode: '2.4',
      subtopicCode: '2.4.1',
      active: true,
      approvalStatus: 'approved',
      stem: 'Pick gates for P.',
      expectedResponseType: 'logic_diagram',
      parts: [
        {
          label: '(a)',
          prompt: 'Pick each gate.',
          marks: 2,
          expectedResponseType: 'logic_diagram',
          partConfig: {
            variant: 'guided_slots',
            slots: [
              { id: 'ab', prompt: 'A and B', options: ['AND', 'OR'], accept: 'AND' },
              { id: 'notc', prompt: 'Invert C', options: ['AND', 'OR', 'NOT'], accept: 'NOT' },
            ],
          },
          markPoints: [
            { text: 'ab: AND', marks: 1 },
            { text: 'notc: NOT', marks: 1 },
          ],
        },
      ],
    });

    const jar = await loginAs(pupil);
    const attemptUrl = await startTopicAttempt(jar, '2.4');
    const editPage = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(jar) },
    });
    updateJar(jar, editPage);
    const html = editPage.payload;
    expect(html).toMatch(/widget--logic-diagram-slots/);
    expect(html).toMatch(/name="part_\d+__ab"/);
    expect(html).toMatch(/name="part_\d+__notc"/);

    const partMatch = /name="part_(\d+)__ab"/.exec(html);
    const partId = partMatch![1]!;
    const csrf = extractCsrfToken(html);
    const payload = form({ _csrf: csrf }) + `&part_${partId}__ab=AND&part_${partId}__notc=OR`;
    const saveRes = await app.inject({
      method: 'POST',
      url: `${attemptUrl}/save`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
      payload,
    });
    expect(saveRes.statusCode).toBe(302);
    updateJar(jar, saveRes);

    const { rows } = await pool().query<{ raw_answer: string }>(
      `SELECT raw_answer FROM attempt_parts WHERE id = $1::bigint`,
      [partId],
    );
    expect(rows[0]?.raw_answer.split('\n').sort()).toEqual(['ab=AND', 'notc=OR']);
  });

  it('boolean_expression: round-trips the expression and matches symbol forms', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    await seedClassWithTopic({ teacher, pupil, topicCode: '2.4' });
    await createQuestion(pool(), teacher.id, {
      componentCode: 'J277/02',
      topicCode: '2.4',
      subtopicCode: '2.4.1',
      active: true,
      approvalStatus: 'approved',
      stem: 'Write the expression.',
      expectedResponseType: 'logic_diagram',
      parts: [
        {
          label: '(a)',
          prompt: 'Write P.',
          marks: 1,
          expectedResponseType: 'logic_diagram',
          partConfig: {
            variant: 'boolean_expression',
            accept: ['(A AND B) OR NOT C'],
          },
          markPoints: [{ text: 'Expression matches', marks: 1 }],
        },
      ],
    });

    const jar = await loginAs(pupil);
    const attemptUrl = await startTopicAttempt(jar, '2.4');
    const editPage = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(jar) },
    });
    updateJar(jar, editPage);
    const html = editPage.payload;
    expect(html).toMatch(/widget--logic-diagram-boolean/);
    const partMatch = /name="part_(\d+)__expression"/.exec(html);
    const partId = partMatch![1]!;
    const csrf = extractCsrfToken(html);
    const payload =
      form({ _csrf: csrf }) + `&part_${partId}__expression=${encodeURIComponent('(A.B)+/C')}`;
    const saveRes = await app.inject({
      method: 'POST',
      url: `${attemptUrl}/save`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
      payload,
    });
    expect(saveRes.statusCode).toBe(302);

    const { rows } = await pool().query<{ raw_answer: string }>(
      `SELECT raw_answer FROM attempt_parts WHERE id = $1::bigint`,
      [partId],
    );
    expect(rows[0]?.raw_answer).toBe('expression=(A.B)+/C');
  });

  it('gate_palette: renders the palette and stores the circuit JSON', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    await seedClassWithTopic({ teacher, pupil, topicCode: '2.4' });
    await createQuestion(pool(), teacher.id, {
      componentCode: 'J277/02',
      topicCode: '2.4',
      subtopicCode: '2.4.1',
      active: true,
      approvalStatus: 'approved',
      stem: 'Build P = A AND B.',
      expectedResponseType: 'logic_diagram',
      parts: [
        {
          label: '(a)',
          prompt: 'Drag gates.',
          marks: 1,
          expectedResponseType: 'logic_diagram',
          partConfig: {
            variant: 'gate_palette',
            canvas: { width: 600, height: 400 },
            terminals: [
              { id: 'a', kind: 'input', label: 'A', x: 40, y: 80 },
              { id: 'b', kind: 'input', label: 'B', x: 40, y: 160 },
              { id: 'p', kind: 'output', label: 'P', x: 520, y: 120 },
            ],
            palette: ['AND', 'OR', 'NOT'],
            expected: {
              truthTable: [
                { inputs: { a: 0, b: 0 }, output: 0 },
                { inputs: { a: 0, b: 1 }, output: 0 },
                { inputs: { a: 1, b: 0 }, output: 0 },
                { inputs: { a: 1, b: 1 }, output: 1 },
              ],
            },
          },
          markPoints: [{ text: 'Circuit matches truth table', marks: 1 }],
        },
      ],
    });

    const jar = await loginAs(pupil);
    const attemptUrl = await startTopicAttempt(jar, '2.4');
    const editPage = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(jar) },
    });
    updateJar(jar, editPage);
    const html = editPage.payload;
    expect(html).toMatch(/widget--logic-diagram-palette/);
    expect(html).toMatch(/data-logic-palette-gate="AND"/);
    expect(html).toMatch(/data-logic-palette-terminal-id="a"/);

    const partMatch = /name="part_(\d+)__circuit"/.exec(html);
    const partId = partMatch![1]!;
    const csrf = extractCsrfToken(html);
    const circuit = JSON.stringify({
      gates: [{ id: 'g1', type: 'AND' }],
      wires: [
        { from: 'a', to: 'g1' },
        { from: 'b', to: 'g1' },
        { from: 'g1', to: 'p' },
      ],
    });
    const payload =
      form({ _csrf: csrf }) + `&part_${partId}__circuit=${encodeURIComponent(circuit)}`;
    const saveRes = await app.inject({
      method: 'POST',
      url: `${attemptUrl}/save`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
      payload,
    });
    expect(saveRes.statusCode).toBe(302);

    const { rows } = await pool().query<{ raw_answer: string }>(
      `SELECT raw_answer FROM attempt_parts WHERE id = $1::bigint`,
      [partId],
    );
    expect(rows[0]?.raw_answer).toBe(`circuit=${circuit}`);
  });
});
