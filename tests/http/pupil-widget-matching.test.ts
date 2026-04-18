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
     VALUES ('Matching test', $1::bigint, '2025/26') RETURNING id::text`,
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

describe('Pupil widget — matching', () => {
  it('renders a select per left row + drag targets, and round-trips answers', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    await seedClassWithTopic({ teacher, pupil, topicCode: '1.3' });
    await createQuestion(pool(), teacher.id, {
      componentCode: 'J277/01',
      topicCode: '1.3',
      subtopicCode: '1.3.2',
      active: true,
      approvalStatus: 'approved',
      stem: 'Match each protocol to its role.',
      expectedResponseType: 'matching',
      parts: [
        {
          label: '(a)',
          prompt: 'Pair each protocol with its role.',
          marks: 2,
          expectedResponseType: 'matching',
          partConfig: {
            left: ['HTTP', 'SMTP'],
            right: ['web pages', 'email', 'remote shell'],
            correctPairs: [
              [0, 0],
              [1, 1],
            ],
          },
          markPoints: [
            { text: 'HTTP — web pages', marks: 1 },
            { text: 'SMTP — email', marks: 1 },
          ],
        },
      ],
    });

    const jar = await loginAs(pupil);
    const attemptUrl = await startTopicAttempt(jar, '1.3');

    const editPage = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(jar) },
    });
    updateJar(jar, editPage);
    expect(editPage.statusCode).toBe(200);
    const html = editPage.payload;
    expect(html).toMatch(/class="[^"]*\bwidget--matching\b/);
    // Left prompts render as labels; right options appear as drag targets.
    expect(html).toContain('HTTP');
    expect(html).toContain('SMTP');
    expect(html).toMatch(/data-matching-right="0"[^>]*>web pages</);
    expect(html).toMatch(/data-matching-right="1"[^>]*>email</);
    // Distractor target present but never in correctPairs.
    expect(html).toMatch(/data-matching-right="2"[^>]*>remote shell</);

    const partMatch = /name="part_(\d+)__0"/.exec(html);
    expect(partMatch).not.toBeNull();
    const partId = partMatch![1]!;
    expect(html).toMatch(new RegExp(`name="part_${partId}__1"`));
    // Both selects should include every right option as a value.
    expect(html).toMatch(new RegExp(`<select[^>]*name="part_${partId}__0"[\\s\\S]*?value="2"`));

    const csrf = extractCsrfToken(html);
    const payload =
      form({ _csrf: csrf }) +
      `&part_${partId}__0=${encodeURIComponent('0')}` +
      `&part_${partId}__1=${encodeURIComponent('1')}`;
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
    expect(lines.has('0=0')).toBe(true);
    expect(lines.has('1=1')).toBe(true);

    const reopen = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(reopen.statusCode).toBe(200);
    // Reopen must reselect the prior picks.
    expect(reopen.payload).toMatch(new RegExp(`<option value="0"\\s+selected[^>]*>web pages`));
    expect(reopen.payload).toMatch(new RegExp(`<option value="1"\\s+selected[^>]*>email`));
  });
});
