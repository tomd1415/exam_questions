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
     VALUES ('Cloze test', $1::bigint, '2025/26') RETURNING id::text`,
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

describe('Pupil widget — cloze_free', () => {
  it('renders gaps inline and round-trips answers into raw_answer', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    await seedClassWithTopic({ teacher, pupil, topicCode: '1.2' });
    await createQuestion(pool(), teacher.id, {
      componentCode: 'J277/01',
      topicCode: '1.2',
      subtopicCode: '1.2.2',
      active: true,
      approvalStatus: 'approved',
      stem: 'Complete the units paragraph.',
      expectedResponseType: 'cloze_free',
      parts: [
        {
          label: '(a)',
          prompt: 'Fill in each gap.',
          marks: 2,
          expectedResponseType: 'cloze_free',
          partConfig: {
            text: 'Eight bits make a {{u1}}. 1024 bytes make a {{u2}}.',
            gaps: [
              { id: 'u1', accept: ['byte'] },
              { id: 'u2', accept: ['kilobyte', 'KB'] },
            ],
          },
          markPoints: [
            { text: 'byte', marks: 1 },
            { text: 'kilobyte', marks: 1 },
          ],
        },
      ],
    });

    const jar = await loginAs(pupil);
    const attemptUrl = await startTopicAttempt(jar, '1.2');

    const editPage = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(jar) },
    });
    updateJar(jar, editPage);
    expect(editPage.statusCode).toBe(200);
    const html = editPage.payload;
    expect(html).toMatch(/class="[^"]*\bcloze\b[^"]*\bcloze--free\b/);
    expect(html).toMatch(/Eight bits make a/);

    const partMatch = /name="part_(\d+)__u1"/.exec(html);
    expect(partMatch).not.toBeNull();
    const partId = partMatch![1]!;
    expect(html).toMatch(new RegExp(`name="part_${partId}__u2"`));

    const csrf = extractCsrfToken(html);
    const payload =
      form({ _csrf: csrf }) +
      `&part_${partId}__u1=${encodeURIComponent('byte')}` +
      `&part_${partId}__u2=${encodeURIComponent('KB')}`;
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
    expect(lines.has('u1=byte')).toBe(true);
    expect(lines.has('u2=KB')).toBe(true);

    const reopen = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(reopen.statusCode).toBe(200);
    expect(reopen.payload).toMatch(new RegExp(`name="part_${partId}__u1"[^>]*value="byte"`));
    expect(reopen.payload).toMatch(new RegExp(`name="part_${partId}__u2"[^>]*value="KB"`));
  });
});

describe('Pupil widget — cloze_with_bank', () => {
  it('renders the bank above the prose with one button per term', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    await seedClassWithTopic({ teacher, pupil, topicCode: '1.3' });
    await createQuestion(pool(), teacher.id, {
      componentCode: 'J277/01',
      topicCode: '1.3',
      subtopicCode: '1.3.1',
      active: true,
      approvalStatus: 'approved',
      stem: 'Complete the device paragraph.',
      expectedResponseType: 'cloze_with_bank',
      parts: [
        {
          label: '(a)',
          prompt: 'Tap a bank term into each gap.',
          marks: 2,
          expectedResponseType: 'cloze_with_bank',
          partConfig: {
            text: 'A {{d1}} forwards within a LAN; a {{d2}} between networks.',
            gaps: [
              { id: 'd1', accept: ['switch'] },
              { id: 'd2', accept: ['router'] },
            ],
            bank: ['switch', 'router', 'hub'],
          },
          markPoints: [
            { text: 'switch', marks: 1 },
            { text: 'router', marks: 1 },
          ],
        },
      ],
    });

    const jar = await loginAs(pupil);
    const attemptUrl = await startTopicAttempt(jar, '1.3');
    const res = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    const html = res.payload;
    expect(html).toMatch(/class="[^"]*\bcloze--with-bank\b/);
    expect(html).toMatch(/<ul class="cloze-bank"/);
    for (const term of ['switch', 'router', 'hub']) {
      expect(html).toContain(`data-cloze-bank-term="${term}"`);
    }
  });
});

describe('Pupil widget — cloze_code', () => {
  it('wraps the prose in a <pre> block and preserves the code newlines', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    await seedClassWithTopic({ teacher, pupil, topicCode: '2.2' });
    await createQuestion(pool(), teacher.id, {
      componentCode: 'J277/02',
      topicCode: '2.2',
      subtopicCode: '2.2.1',
      active: true,
      approvalStatus: 'approved',
      stem: 'Complete the for loop.',
      expectedResponseType: 'cloze_code',
      parts: [
        {
          label: '(a)',
          prompt: 'Fill the gaps.',
          marks: 2,
          expectedResponseType: 'cloze_code',
          partConfig: {
            text: 'for i = 1 to {{stop}}\n  print({{counter}})\nnext i',
            gaps: [
              { id: 'stop', accept: ['5'] },
              { id: 'counter', accept: ['i'] },
            ],
          },
          markPoints: [
            { text: 'stop = 5', marks: 1 },
            { text: 'print(i)', marks: 1 },
          ],
        },
      ],
    });

    const jar = await loginAs(pupil);
    const attemptUrl = await startTopicAttempt(jar, '2.2');
    const res = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    const html = res.payload;
    expect(html).toMatch(/class="[^"]*\bcloze--code\b/);
    expect(html).toMatch(/<pre class="cloze-code"/);
    // Newlines from the authored text should appear inside the <pre> block.
    const preMatch = /<pre class="cloze-code"[^>]*>([\s\S]*?)<\/pre>/.exec(html);
    expect(preMatch).not.toBeNull();
    expect(preMatch![1]).toContain('\n');
  });
});
