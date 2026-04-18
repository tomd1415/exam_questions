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
     VALUES ('Matrix tick test', $1::bigint, '2025/26') RETURNING id::text`,
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

const ROWS = ['RAM', 'ROM', 'HDD'];
const COLUMNS = ['Volatile primary', 'Non-volatile primary', 'Secondary'];
const CORRECT = ['Volatile primary', 'Non-volatile primary', 'Secondary'];

async function seedMatrixTickQuestion(teacherId: string, topicCode: string): Promise<void> {
  await createQuestion(pool(), teacherId, {
    componentCode: 'J277/01',
    topicCode,
    subtopicCode: '1.2.1',
    active: true,
    approvalStatus: 'approved',
    stem: 'Classify each storage device.',
    expectedResponseType: 'matrix_tick_single',
    parts: [
      {
        label: '(a)',
        prompt: 'Tick one box per row.',
        marks: 3,
        expectedResponseType: 'matrix_tick_single',
        partConfig: {
          rows: ROWS,
          columns: COLUMNS,
          correctByRow: CORRECT,
        },
        markPoints: ROWS.map((r, i) => ({ text: `${r} → ${CORRECT[i]!}`, marks: 1 })),
      },
    ],
  });
}

describe('Pupil widget — matrix_tick_single', () => {
  it('renders one radio group per row with the correct field name and column values', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    await seedClassWithTopic({ teacher, pupil, topicCode: '1.2' });
    await seedMatrixTickQuestion(teacher.id, '1.2');

    const jar = await loginAs(pupil);
    const attemptUrl = await startTopicAttempt(jar, '1.2');
    const res = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    const html = res.payload;

    expect(html).toContain('widget--matrix-tick');
    expect(html).toMatch(/class="[^"]*\bmatrix-tick\b[^"]*"/);

    for (const col of COLUMNS) expect(html).toContain(col);
    for (const row of ROWS) expect(html).toContain(row);

    // One radio per (row, column) named part_<id>__<rowIndex>.
    const partMatch = /name="part_(\d+)__0"/.exec(html);
    expect(partMatch).not.toBeNull();
    const partId = partMatch![1]!;
    for (let i = 0; i < ROWS.length; i++) {
      for (const col of COLUMNS) {
        const rx = new RegExp(
          `name="part_${partId}__${String(i)}"[^>]*value="${col.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}"`,
        );
        expect(html).toMatch(rx);
      }
    }
  });

  it('round-trips selections into raw_answer and re-renders them as checked', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    await seedClassWithTopic({ teacher, pupil, topicCode: '1.2' });
    await seedMatrixTickQuestion(teacher.id, '1.2');

    const jar = await loginAs(pupil);
    const attemptUrl = await startTopicAttempt(jar, '1.2');

    const editPage = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(jar) },
    });
    updateJar(jar, editPage);
    const partMatch = /name="part_(\d+)__0"/.exec(editPage.payload);
    expect(partMatch).not.toBeNull();
    const partId = partMatch![1]!;
    const csrf = extractCsrfToken(editPage.payload);

    const payload =
      form({ _csrf: csrf }) +
      `&part_${partId}__0=${encodeURIComponent('Volatile primary')}` +
      `&part_${partId}__1=${encodeURIComponent('Non-volatile primary')}` +
      `&part_${partId}__2=${encodeURIComponent('Secondary')}`;

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
    const lines = new Set(stored.split('\n'));
    expect(lines.has('0=Volatile primary')).toBe(true);
    expect(lines.has('1=Non-volatile primary')).toBe(true);
    expect(lines.has('2=Secondary')).toBe(true);

    const reopen = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(reopen.statusCode).toBe(200);
    const re = reopen.payload;
    expect(re).toMatch(
      new RegExp(`name="part_${partId}__0"[^>]*value="Volatile primary"[^>]*checked`, 'i'),
    );
    expect(re).toMatch(
      new RegExp(`name="part_${partId}__2"[^>]*value="Secondary"[^>]*checked`, 'i'),
    );
  });
});
