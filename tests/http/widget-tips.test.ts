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
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
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
     VALUES ('Widget tips test', $1::bigint, '2025/26') RETURNING id::text`,
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
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
    payload: form({ _csrf: csrf }),
  });
  expect(startRes.statusCode).toBe(302);
  updateJar(jar, startRes);
  return startRes.headers.location!;
}

async function seedFlowchartQuestion(teacher: CreatedUser): Promise<void> {
  await createQuestion(pool(), teacher.id, {
    componentCode: 'J277/02',
    topicCode: '2.1',
    subtopicCode: '2.1.1',
    active: true,
    approvalStatus: 'approved',
    stem: 'Draw the flowchart.',
    expectedResponseType: 'flowchart',
    parts: [
      {
        label: '(a)',
        prompt: 'Draw a flowchart.',
        marks: 4,
        expectedResponseType: 'flowchart',
        partConfig: { variant: 'image', canvas: { width: 400, height: 300 } },
        markPoints: [{ text: 'Start and Stop terminators', marks: 1 }],
      },
    ],
  });
}

describe('Widget tips — first-render, dismiss, persistence', () => {
  it('renders the flowchart tip on first attempt-edit view, hides it after dismiss', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    await seedClassWithTopic({ teacher, pupil, topicCode: '2.1' });
    await seedFlowchartQuestion(teacher);

    const jar = await loginAs(pupil);
    const attemptUrl = await startTopicAttempt(jar, '2.1');

    const first = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(jar) },
    });
    updateJar(jar, first);
    expect(first.statusCode).toBe(200);
    expect(first.payload).toContain('data-widget-tip-key="flowchart"');
    expect(first.payload).toContain('Draw the flowchart');

    const csrf = extractCsrfToken(first.payload);
    const dismiss = await app.inject({
      method: 'POST',
      url: '/me/widget-tips/dismiss',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ _csrf: csrf, key: 'flowchart' }),
    });
    expect(dismiss.statusCode).toBe(302);
    updateJar(jar, dismiss);

    const dbRow = await pool().query<{ widget_tips_dismissed: Record<string, string> }>(
      `SELECT widget_tips_dismissed FROM users WHERE id = $1::bigint`,
      [pupil.id],
    );
    expect(Object.keys(dbRow.rows[0]!.widget_tips_dismissed)).toContain('flowchart');

    const second = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(second.statusCode).toBe(200);
    expect(second.payload).not.toContain('data-widget-tip-key="flowchart"');
  });

  it('rejects an unknown widget key with 400', async () => {
    const pupil = await createUser(pool(), { role: 'pupil' });
    const jar = await loginAs(pupil);
    const prefs = await app.inject({
      method: 'GET',
      url: '/me/preferences',
      headers: { cookie: cookieHeader(jar) },
    });
    updateJar(jar, prefs);
    const csrf = extractCsrfToken(prefs.payload);
    const res = await app.inject({
      method: 'POST',
      url: '/me/widget-tips/dismiss',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ _csrf: csrf, key: 'definitely-not-a-widget' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('one pupil cannot dismiss for another pupil (per-session writes only)', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const a = await createUser(pool(), { role: 'pupil' });
    const b = await createUser(pool(), { role: 'pupil' });
    await seedClassWithTopic({ teacher, pupil: a, topicCode: '2.1' });
    await seedFlowchartQuestion(teacher);

    const jarA = await loginAs(a);
    const attemptUrl = await startTopicAttempt(jarA, '2.1');
    const first = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(jarA) },
    });
    const csrf = extractCsrfToken(first.payload);
    await app.inject({
      method: 'POST',
      url: '/me/widget-tips/dismiss',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jarA),
      },
      payload: form({ _csrf: csrf, key: 'flowchart' }),
    });

    const rowB = await pool().query<{ widget_tips_dismissed: Record<string, string> }>(
      `SELECT widget_tips_dismissed FROM users WHERE id = $1::bigint`,
      [b.id],
    );
    expect(rowB.rows[0]!.widget_tips_dismissed).toEqual({});
  });

  it('rejects missing CSRF token', async () => {
    const pupil = await createUser(pool(), { role: 'pupil' });
    const jar = await loginAs(pupil);
    const res = await app.inject({
      method: 'POST',
      url: '/me/widget-tips/dismiss',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ key: 'flowchart' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('records a user.widget_tip.dismissed audit event', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    await seedClassWithTopic({ teacher, pupil, topicCode: '2.1' });
    await seedFlowchartQuestion(teacher);
    const jar = await loginAs(pupil);
    const attemptUrl = await startTopicAttempt(jar, '2.1');
    const first = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(jar) },
    });
    const csrf = extractCsrfToken(first.payload);
    await app.inject({
      method: 'POST',
      url: '/me/widget-tips/dismiss',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ _csrf: csrf, key: 'flowchart' }),
    });
    const audit = await pool().query<{ event_type: string; details: { widget_key: string } }>(
      `SELECT event_type, details FROM audit_events
        WHERE actor_user_id = $1::bigint AND event_type = 'user.widget_tip.dismissed'`,
      [pupil.id],
    );
    expect(audit.rows.length).toBe(1);
    expect(audit.rows[0]!.details.widget_key).toBe('flowchart');
  });
});
