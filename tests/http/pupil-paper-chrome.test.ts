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
     VALUES ('Paper chrome test', $1::bigint, '2025/26') RETURNING id::text`,
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
  const attemptUrl = startRes.headers.location!;
  expect(attemptUrl).toMatch(/^\/attempts\/\d+$/);
  return attemptUrl;
}

describe('Pupil attempt edit — OCR paper chrome', () => {
  it('renders paper-style layout with header, marks gutter, and no teacher-metadata badges', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), {
      role: 'pupil',
      pseudonym: 'CANDIDATE-01',
    });
    await seedClassWithTopic({ teacher, pupil, topicCode: '1.2' });
    await createQuestion(pool(), teacher.id, {
      componentCode: 'J277/01',
      topicCode: '1.2',
      subtopicCode: '1.2.1',
      active: true,
      approvalStatus: 'approved',
      parts: [
        {
          label: '(a)',
          prompt: 'Name one example of primary storage.',
          marks: 1,
          expectedResponseType: 'short_text',
          markPoints: [{ text: 'RAM', marks: 1 }],
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
    const body = res.payload;

    expect(body).toContain('class="paper-root"');
    expect(body).toContain('class="paper-header"');
    expect(body).toContain('paper-header__meta');
    expect(body).toContain('paper-marks-gutter');
    expect(body).toContain('paper-question');
    expect(body).toContain('paper-part');

    expect(body).toContain('CANDIDATE-01');
    expect(body).toContain('1.2');
    expect(body).toContain('Memory and storage');
    expect(body).toContain('J277/01');
    expect(body).toContain('Computer systems');

    expect(body).toContain('/static/paper.css');

    expect(body).not.toContain('badge--muted');
    expect(body).not.toContain('command_word_code');
  });

  it('serves the paper stylesheet from /static/paper.css', async () => {
    const res = await app.inject({ method: 'GET', url: '/static/paper.css' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/css');
    expect(res.payload).toContain('.paper-root');
    expect(res.payload).toContain('--paper-gutter');
  });
});
