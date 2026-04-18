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
     VALUES ('Matrix tick multi test', $1::bigint, '2025/26') RETURNING id::text`,
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

const ROWS = ['HTTPS', 'SMTP', 'IMAP', 'FTP'];
const COLUMNS = [
  'Transfers web pages',
  'Encrypts the traffic',
  'Sends email',
  'Retrieves email',
  'Transfers files',
];
const CORRECT: readonly (readonly string[])[] = [
  ['Transfers web pages', 'Encrypts the traffic'],
  ['Sends email'],
  ['Retrieves email'],
  ['Transfers files'],
];

async function seedMatrixTickMultiQuestion(teacherId: string, topicCode: string): Promise<void> {
  await createQuestion(pool(), teacherId, {
    componentCode: 'J277/01',
    topicCode,
    subtopicCode: '1.3.2',
    active: true,
    approvalStatus: 'approved',
    stem: 'Tick every box that describes each protocol.',
    expectedResponseType: 'matrix_tick_multi',
    parts: [
      {
        label: '(a)',
        prompt: 'Some rows need more than one tick.',
        marks: 5,
        expectedResponseType: 'matrix_tick_multi',
        partConfig: {
          rows: ROWS,
          columns: COLUMNS,
          correctByRow: CORRECT,
        },
        markPoints: CORRECT.flatMap((row, i) =>
          row.map((col) => ({ text: `${ROWS[i]!}: ${col}`, marks: 1 })),
        ),
      },
    ],
  });
}

describe('Pupil widget — matrix_tick_multi', () => {
  it('renders one checkbox per (row, column) with the right field name', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    await seedClassWithTopic({ teacher, pupil, topicCode: '1.3' });
    await seedMatrixTickMultiQuestion(teacher.id, '1.3');

    const jar = await loginAs(pupil);
    const attemptUrl = await startTopicAttempt(jar, '1.3');
    const res = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    const html = res.payload;

    expect(html).toMatch(/class="[^"]*\bmatrix-tick-multi\b[^"]*"/);
    for (const col of COLUMNS) expect(html).toContain(col);
    for (const row of ROWS) expect(html).toContain(row);

    const partMatch = /name="part_(\d+)__0"/.exec(html);
    expect(partMatch).not.toBeNull();
    const partId = partMatch![1]!;
    for (let i = 0; i < ROWS.length; i++) {
      for (const col of COLUMNS) {
        const rx = new RegExp(
          `type="checkbox"[^>]*name="part_${partId}__${String(i)}"[^>]*value="${col.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}"`,
        );
        expect(html).toMatch(rx);
      }
    }
    // Each row that has a known correct count gets a per-row counter chip.
    expect(html).toMatch(/data-tick-counter-row[^>]*data-target="2"/);
  });

  it('round-trips multi-pick selections into raw_answer (one line per pick)', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    await seedClassWithTopic({ teacher, pupil, topicCode: '1.3' });
    await seedMatrixTickMultiQuestion(teacher.id, '1.3');

    const jar = await loginAs(pupil);
    const attemptUrl = await startTopicAttempt(jar, '1.3');

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
      `&part_${partId}__0=${encodeURIComponent('Transfers web pages')}` +
      `&part_${partId}__0=${encodeURIComponent('Encrypts the traffic')}` +
      `&part_${partId}__1=${encodeURIComponent('Sends email')}` +
      `&part_${partId}__3=${encodeURIComponent('Transfers files')}`;

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
    expect(lines.has('0=Transfers web pages')).toBe(true);
    expect(lines.has('0=Encrypts the traffic')).toBe(true);
    expect(lines.has('1=Sends email')).toBe(true);
    expect(lines.has('3=Transfers files')).toBe(true);

    const reopen = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(reopen.statusCode).toBe(200);
    const re = reopen.payload;
    expect(re).toMatch(
      new RegExp(`name="part_${partId}__0"[^>]*value="Transfers web pages"[^>]*checked`, 'i'),
    );
    expect(re).toMatch(
      new RegExp(`name="part_${partId}__0"[^>]*value="Encrypts the traffic"[^>]*checked`, 'i'),
    );
    expect(re).toMatch(
      new RegExp(`name="part_${partId}__3"[^>]*value="Transfers files"[^>]*checked`, 'i'),
    );
  });
});

describe('Pupil widget — tick_box with tickExactly + options', () => {
  it('renders distractor checkboxes from options and shows the counter chip', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    await seedClassWithTopic({ teacher, pupil, topicCode: '1.4' });
    await createQuestion(pool(), teacher.id, {
      componentCode: 'J277/01',
      topicCode: '1.4',
      subtopicCode: '1.4.2',
      active: true,
      approvalStatus: 'approved',
      stem: 'Choose the strong-password guidelines.',
      expectedResponseType: 'tick_box',
      parts: [
        {
          label: '(a)',
          prompt: 'Tick exactly two boxes.',
          marks: 2,
          expectedResponseType: 'tick_box',
          partConfig: {
            tickExactly: 2,
            options: [
              'Use a long passphrase mixing letters, numbers and symbols.',
              'Use a different password for every account.',
              'Use the same password everywhere.',
              'Write the password on a sticky note.',
            ],
          },
          markPoints: [
            {
              text: 'Use a long passphrase mixing letters, numbers and symbols.',
              marks: 1,
            },
            { text: 'Use a different password for every account.', marks: 1 },
          ],
        },
      ],
    });

    const jar = await loginAs(pupil);
    const attemptUrl = await startTopicAttempt(jar, '1.4');
    const res = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    const html = res.payload;

    expect(html).toContain('widget--tick-exactly');
    expect(html).toMatch(/data-tick-counter[^>]*data-target="2"/);
    expect(html).toContain('Use the same password everywhere.');
    expect(html).toContain('Write the password on a sticky note.');
  });
});
