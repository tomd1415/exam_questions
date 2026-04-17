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

function extractCrumbs(payload: string): { labels: string[]; leafAriaCurrent: boolean } {
  const nav = /<nav class="breadcrumbs"[\s\S]*?<\/nav>/.exec(payload);
  if (!nav) return { labels: [], leafAriaCurrent: false };
  const block = nav[0];
  const items = Array.from(block.matchAll(/<li class="breadcrumbs__item">([\s\S]*?)<\/li>/g));
  const labels = items.map((m) => {
    const inner = m[1]!;
    const match = /<(?:a|span)[^>]*>([^<]+)<\/(?:a|span)>/.exec(inner);
    return match ? match[1]!.trim() : inner.trim();
  });
  const leafAriaCurrent = (items[items.length - 1]?.[0] ?? '').includes('aria-current="page"');
  return { labels, leafAriaCurrent };
}

describe('breadcrumbs (Chunk 6c)', () => {
  it('admin class detail renders Classes › {className} with aria-current on leaf', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const { rows } = await getSharedPool().query<{ id: string }>(
      `INSERT INTO classes (name, teacher_id, academic_year)
       VALUES ('Crumb class', $1::bigint, '2025/26') RETURNING id::text`,
      [teacher.id],
    );
    const classId = rows[0]!.id;
    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: `/admin/classes/${classId}`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    const { labels, leafAriaCurrent } = extractCrumbs(res.payload);
    expect(labels).toEqual(['Classes', 'Crumb class']);
    expect(leafAriaCurrent).toBe(true);
  });

  it('admin submissions list renders Classes › {className} › Submissions', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const { rows } = await getSharedPool().query<{ id: string }>(
      `INSERT INTO classes (name, teacher_id, academic_year)
       VALUES ('Subs crumb', $1::bigint, '2025/26') RETURNING id::text`,
      [teacher.id],
    );
    const classId = rows[0]!.id;
    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: `/admin/classes/${classId}/attempts`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    const { labels, leafAriaCurrent } = extractCrumbs(res.payload);
    expect(labels).toEqual(['Classes', 'Subs crumb', 'Submissions']);
    expect(leafAriaCurrent).toBe(true);
  });

  it('admin attempt detail renders Marking queue › Class submissions › Attempt N', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const pupil = await createUser(getSharedPool(), { role: 'pupil' });
    const pool = getSharedPool();
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO classes (name, teacher_id, academic_year)
       VALUES ('Attempt crumb', $1::bigint, '2025/26') RETURNING id::text`,
      [teacher.id],
    );
    const classId = rows[0]!.id;
    await pool.query(`INSERT INTO enrolments (class_id, user_id) VALUES ($1::bigint, $2::bigint)`, [
      classId,
      pupil.id,
    ]);
    await pool.query(
      `INSERT INTO class_assigned_topics (class_id, topic_code, assigned_by)
       VALUES ($1::bigint, '1.5', $2::bigint)`,
      [classId, teacher.id],
    );
    await createQuestion(pool, teacher.id, {
      topicCode: '1.5',
      subtopicCode: '1.5.1',
      active: true,
      approvalStatus: 'approved',
      parts: [
        {
          label: '(a)',
          prompt: 'Explain.',
          marks: 2,
          expectedResponseType: 'extended_response',
        },
      ],
    });

    const pupilJar = await loginAs(pupil);
    const topics = await app.inject({
      method: 'GET',
      url: '/topics',
      headers: { cookie: cookieHeader(pupilJar) },
    });
    updateJar(pupilJar, topics);
    const csrfStart = extractCsrfToken(topics.payload);
    const start = await app.inject({
      method: 'POST',
      url: `/topics/1.5/start`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(pupilJar),
      },
      payload: form({ _csrf: csrfStart }),
    });
    expect(start.statusCode).toBe(302);
    const attemptUrl = start.headers.location!;
    const attemptId = attemptUrl.split('/').pop()!;
    updateJar(pupilJar, start);
    const edit = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(pupilJar) },
    });
    updateJar(pupilJar, edit);
    const csrfSubmit = extractCsrfToken(edit.payload);
    const partIds = Array.from(edit.payload.matchAll(/name="part_(\d+)"/g)).map((m) => m[1]!);
    const submitRes = await app.inject({
      method: 'POST',
      url: `${attemptUrl}/submit`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(pupilJar),
      },
      payload: form({ _csrf: csrfSubmit, [`part_${partIds[0]!}`]: 'An answer.' }),
    });
    expect(submitRes.statusCode).toBe(302);

    const teacherJar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: `/admin/attempts/${attemptId}`,
      headers: { cookie: cookieHeader(teacherJar) },
    });
    expect(res.statusCode).toBe(200);
    const { labels, leafAriaCurrent } = extractCrumbs(res.payload);
    expect(labels).toEqual(['Marking queue', 'Class submissions', `Attempt ${attemptId}`]);
    expect(leafAriaCurrent).toBe(true);
  });

  it('pupil attempt edit page renders My attempts › Attempt N breadcrumb', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const pupil = await createUser(getSharedPool(), { role: 'pupil' });
    const pool = getSharedPool();
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO classes (name, teacher_id, academic_year)
       VALUES ('Edit crumb', $1::bigint, '2025/26') RETURNING id::text`,
      [teacher.id],
    );
    const classId = rows[0]!.id;
    await pool.query(`INSERT INTO enrolments (class_id, user_id) VALUES ($1::bigint, $2::bigint)`, [
      classId,
      pupil.id,
    ]);
    await pool.query(
      `INSERT INTO class_assigned_topics (class_id, topic_code, assigned_by)
       VALUES ($1::bigint, '1.6', $2::bigint)`,
      [classId, teacher.id],
    );
    await createQuestion(pool, teacher.id, {
      topicCode: '1.6',
      subtopicCode: '1.6.1',
      active: true,
      approvalStatus: 'approved',
      parts: [{ label: '(a)', prompt: 'Describe.', marks: 2, expectedResponseType: 'short_text' }],
    });
    const pupilJar = await loginAs(pupil);
    const topics = await app.inject({
      method: 'GET',
      url: '/topics',
      headers: { cookie: cookieHeader(pupilJar) },
    });
    updateJar(pupilJar, topics);
    const csrf = extractCsrfToken(topics.payload);
    const start = await app.inject({
      method: 'POST',
      url: '/topics/1.6/start',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(pupilJar),
      },
      payload: form({ _csrf: csrf }),
    });
    const attemptUrl = start.headers.location!;
    const attemptId = attemptUrl.split('/').pop()!;
    updateJar(pupilJar, start);
    const edit = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(pupilJar) },
    });
    expect(edit.statusCode).toBe(200);
    const { labels, leafAriaCurrent } = extractCrumbs(edit.payload);
    expect(labels).toEqual(['My attempts', `Attempt ${attemptId}`]);
    expect(leafAriaCurrent).toBe(true);
  });
});
