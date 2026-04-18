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
     VALUES ('Trace grid test', $1::bigint, '2025/26') RETURNING id::text`,
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

describe('Pupil widget — trace_table grid', () => {
  it('renders prefilled cells as read-only text and round-trips per-cell answers', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    await seedClassWithTopic({ teacher, pupil, topicCode: '2.1' });
    await createQuestion(pool(), teacher.id, {
      componentCode: 'J277/02',
      topicCode: '2.1',
      subtopicCode: '2.1.2',
      active: true,
      approvalStatus: 'approved',
      stem: 'Complete the trace table.',
      expectedResponseType: 'trace_table',
      parts: [
        {
          label: '(a)',
          prompt: 'Trace this algorithm.',
          marks: 2,
          expectedResponseType: 'trace_table',
          partConfig: {
            columns: [{ name: 'i' }, { name: 'total' }],
            rows: 2,
            prefill: { '0,0': '1', '1,0': '2' },
            expected: { '0,1': '2', '1,1': '6' },
            marking: { mode: 'perCell' },
          },
          markPoints: [
            { text: 'row 1: total = 2', marks: 1 },
            { text: 'row 2: total = 6', marks: 1 },
          ],
        },
      ],
    });

    const jar = await loginAs(pupil);
    const attemptUrl = await startTopicAttempt(jar, '2.1');

    const editPage = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(jar) },
    });
    updateJar(jar, editPage);
    expect(editPage.statusCode).toBe(200);
    const html = editPage.payload;
    expect(html).toMatch(/class="trace-grid"/);
    // Pre-filled cells render as read-only text spans, not <input>s.
    expect(html).toMatch(/class="trace-grid__prefill"[^>]*>1</);
    expect(html).toMatch(/class="trace-grid__prefill"[^>]*>2</);

    const partMatch = /name="part_(\d+)__0,1"/.exec(html);
    expect(partMatch).not.toBeNull();
    const partId = partMatch![1]!;
    expect(html).toMatch(new RegExp(`name="part_${partId}__1,1"`));
    // Pre-filled cells must NOT post a value.
    expect(html).not.toMatch(new RegExp(`name="part_${partId}__0,0"`));

    const csrf = extractCsrfToken(html);
    const payload =
      form({ _csrf: csrf }) +
      `&part_${partId}__0,1=${encodeURIComponent('2')}` +
      `&part_${partId}__1,1=${encodeURIComponent('6')}`;
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
    expect(lines.has('0,1=2')).toBe(true);
    expect(lines.has('1,1=6')).toBe(true);

    const reopen = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(reopen.statusCode).toBe(200);
    expect(reopen.payload).toMatch(new RegExp(`name="part_${partId}__0,1"[^>]*value="2"`));
    expect(reopen.payload).toMatch(new RegExp(`name="part_${partId}__1,1"[^>]*value="6"`));
  });
});
