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
     VALUES ('Widget test', $1::bigint, '2025/26') RETURNING id::text`,
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

describe('Pupil attempt edit — per-type widgets', () => {
  it('dispatches each expected_response_type to its widget', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    await seedClassWithTopic({ teacher, pupil, topicCode: '1.2' });

    await createQuestion(pool(), teacher.id, {
      componentCode: 'J277/01',
      topicCode: '1.2',
      subtopicCode: '1.2.1',
      active: true,
      approvalStatus: 'approved',
      stem: 'Answer every part using the intended input.',
      parts: [
        {
          label: '(a)',
          prompt: 'Pick one.',
          marks: 1,
          expectedResponseType: 'multiple_choice',
          markPoints: [
            { text: 'CPU', marks: 1 },
            { text: 'RAM', marks: 0 },
          ],
        },
        {
          label: '(b)',
          prompt: 'Tick all storage types.',
          marks: 2,
          expectedResponseType: 'tick_box',
          markPoints: [
            { text: 'SSD', marks: 1 },
            { text: 'HDD', marks: 1 },
            { text: 'CPU', marks: 0 },
          ],
        },
        {
          label: '(c)',
          prompt: 'Name it.',
          marks: 1,
          expectedResponseType: 'short_text',
          markPoints: [{ text: 'RAM', marks: 1 }],
        },
        {
          label: '(d)',
          prompt: 'Describe it.',
          marks: 2,
          expectedResponseType: 'medium_text',
        },
        {
          label: '(e)',
          prompt: 'Explain in detail.',
          marks: 6,
          expectedResponseType: 'extended_response',
        },
        {
          label: '(f)',
          prompt: 'Write the code.',
          marks: 4,
          expectedResponseType: 'code',
        },
        {
          label: '(g)',
          prompt: 'Write pseudocode.',
          marks: 3,
          expectedResponseType: 'algorithm',
        },
        {
          label: '(h)',
          prompt: 'Show the trace.',
          marks: 3,
          expectedResponseType: 'trace_table',
        },
      ],
    });

    const jar = await loginAs(pupil);
    const attemptUrl = await startTopicAttempt(jar, '1.2');

    const res = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    const html = res.payload;

    expect(html).toContain('widget widget--mc');
    expect(html).toMatch(/type="radio"[^>]*value="CPU"/);
    expect(html).toMatch(/type="radio"[^>]*value="RAM"/);

    expect(html).toContain('widget widget--tick');
    expect(html).toMatch(/type="checkbox"[^>]*value="SSD"/);
    expect(html).toMatch(/type="checkbox"[^>]*value="HDD"/);

    expect(html).toContain('widget widget--short');
    expect(html).toMatch(/<input class="widget widget--short"[\s\S]*?type="text"/);

    expect(html).toContain('widget widget--medium');
    expect(html).toContain('widget widget--extended');
    expect(html).toMatch(/class="widget widget--extended"[^>]*rows="18"/);

    expect(html).toContain('widget widget--code');
    expect(html).toMatch(/class="widget widget--code"[^>]*spellcheck="false"/);

    expect(html).toContain('widget widget--algorithm');
    expect(html).toContain('widget widget--trace-table');

    expect(html).not.toMatch(/widget--fallback/);
    expect(html).not.toMatch(/<textarea[^>]*rows="5"[^>]*name="part_/);
  });

  it('round-trips tick-box selections via checkboxes as newline-joined raw_answer', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    await seedClassWithTopic({ teacher, pupil, topicCode: '1.2' });

    await createQuestion(pool(), teacher.id, {
      componentCode: 'J277/01',
      topicCode: '1.2',
      subtopicCode: '1.2.2',
      active: true,
      approvalStatus: 'approved',
      stem: 'Tick all secondary storage types.',
      expectedResponseType: 'tick_box',
      parts: [
        {
          label: '(a)',
          prompt: 'Tick all secondary storage.',
          marks: 2,
          expectedResponseType: 'tick_box',
          markPoints: [
            { text: 'SSD', marks: 1 },
            { text: 'HDD', marks: 1 },
            { text: 'CPU', marks: 0 },
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
    const partMatch = /name="part_(\d+)"/.exec(editPage.payload);
    expect(partMatch).not.toBeNull();
    const partId = partMatch![1]!;
    const csrf = extractCsrfToken(editPage.payload);

    // Submit two checked boxes — the browser sends the field twice,
    // which reaches the server as a string[].
    const payload = form({ _csrf: csrf }) + `&part_${partId}=SSD&part_${partId}=HDD`;
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
    expect(rows[0]?.raw_answer).toBe('SSD\nHDD');

    // Reopen and assert both boxes are checked.
    const reopen = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(reopen.statusCode).toBe(200);
    expect(reopen.payload).toMatch(/type="checkbox"[^>]*value="SSD"[^>]*checked/);
    expect(reopen.payload).toMatch(/type="checkbox"[^>]*value="HDD"[^>]*checked/);
    expect(reopen.payload).not.toMatch(/type="checkbox"[^>]*value="CPU"[^>]*checked/);
  });
});
