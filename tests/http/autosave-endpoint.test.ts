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
     VALUES ('Autosave test', $1::bigint, '2025/26') RETURNING id::text`,
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

interface StartedAttempt {
  attemptUrl: string;
  partId: string;
  csrf: string;
}

async function startAttemptAndGrabPart(
  jar: ReturnType<typeof newJar>,
  topicCode: string,
): Promise<StartedAttempt> {
  const listPage = await app.inject({
    method: 'GET',
    url: '/topics',
    headers: { cookie: cookieHeader(jar) },
  });
  updateJar(jar, listPage);
  const listCsrf = extractCsrfToken(listPage.payload);
  const startRes = await app.inject({
    method: 'POST',
    url: `/topics/${topicCode}/start`,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: cookieHeader(jar),
    },
    payload: form({ _csrf: listCsrf }),
  });
  expect(startRes.statusCode).toBe(302);
  updateJar(jar, startRes);
  const attemptUrl = startRes.headers.location!;

  const editPage = await app.inject({
    method: 'GET',
    url: attemptUrl,
    headers: { cookie: cookieHeader(jar) },
  });
  expect(editPage.statusCode).toBe(200);
  updateJar(jar, editPage);
  const partMatch = /name="part_(\d+)"/.exec(editPage.payload);
  expect(partMatch).not.toBeNull();
  return {
    attemptUrl,
    partId: partMatch![1]!,
    csrf: extractCsrfToken(editPage.payload),
  };
}

describe('POST /attempts/:id/parts/:pid/autosave', () => {
  it('saves a single part with valid CSRF and returns {ok, saved_at}', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    await seedClassWithTopic({ teacher, pupil, topicCode: '1.2' });
    await createQuestion(pool(), teacher.id, {
      topicCode: '1.2',
      active: true,
      approvalStatus: 'approved',
      parts: [
        {
          label: '(a)',
          prompt: 'Describe.',
          marks: 2,
          expectedResponseType: 'medium_text',
        },
      ],
    });

    const jar = await loginAs(pupil);
    const started = await startAttemptAndGrabPart(jar, '1.2');

    const attemptId = /\/attempts\/(\d+)/.exec(started.attemptUrl)![1]!;
    const res = await app.inject({
      method: 'POST',
      url: `/attempts/${attemptId}/parts/${started.partId}/autosave`,
      headers: {
        'content-type': 'application/json',
        cookie: cookieHeader(jar),
        'x-csrf-token': started.csrf,
      },
      payload: JSON.stringify({ raw_answer: 'draft in progress' }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ ok: boolean; saved_at: string }>();
    expect(body.ok).toBe(true);
    expect(typeof body.saved_at).toBe('string');
    expect(Number.isNaN(Date.parse(body.saved_at))).toBe(false);

    const { rows } = await pool().query<{ raw_answer: string; last_saved_at: Date | null }>(
      `SELECT raw_answer, last_saved_at FROM attempt_parts WHERE id = $1::bigint`,
      [started.partId],
    );
    expect(rows[0]?.raw_answer).toBe('draft in progress');
    expect(rows[0]?.last_saved_at).not.toBeNull();
  });

  it('rejects requests without a CSRF token (header or body)', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    await seedClassWithTopic({ teacher, pupil, topicCode: '1.2' });
    await createQuestion(pool(), teacher.id, {
      topicCode: '1.2',
      active: true,
      approvalStatus: 'approved',
      parts: [
        {
          label: '(a)',
          prompt: 'Describe.',
          marks: 2,
          expectedResponseType: 'medium_text',
        },
      ],
    });

    const jar = await loginAs(pupil);
    const started = await startAttemptAndGrabPart(jar, '1.2');
    const attemptId = /\/attempts\/(\d+)/.exec(started.attemptUrl)![1]!;

    const res = await app.inject({
      method: 'POST',
      url: `/attempts/${attemptId}/parts/${started.partId}/autosave`,
      headers: {
        'content-type': 'application/json',
        cookie: cookieHeader(jar),
      },
      payload: JSON.stringify({ raw_answer: 'no csrf here' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects another pupil writing to the attempt part', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const owner = await createUser(pool(), { role: 'pupil' });
    const intruder = await createUser(pool(), { role: 'pupil' });
    await seedClassWithTopic({ teacher, pupil: owner, topicCode: '1.2' });
    await createQuestion(pool(), teacher.id, {
      topicCode: '1.2',
      active: true,
      approvalStatus: 'approved',
      parts: [
        {
          label: '(a)',
          prompt: 'Describe.',
          marks: 2,
          expectedResponseType: 'medium_text',
        },
      ],
    });

    const ownerJar = await loginAs(owner);
    const started = await startAttemptAndGrabPart(ownerJar, '1.2');
    const attemptId = /\/attempts\/(\d+)/.exec(started.attemptUrl)![1]!;

    // Intruder logs in and grabs their own CSRF token (not valid for owner's session,
    // but that's the point — server must reject on ownership grounds even if CSRF passes).
    const intruderJar = await loginAs(intruder);
    const probe = await app.inject({
      method: 'GET',
      url: '/topics',
      headers: { cookie: cookieHeader(intruderJar) },
    });
    updateJar(intruderJar, probe);
    const intruderCsrf = extractCsrfToken(probe.payload);

    const res = await app.inject({
      method: 'POST',
      url: `/attempts/${attemptId}/parts/${started.partId}/autosave`,
      headers: {
        'content-type': 'application/json',
        cookie: cookieHeader(intruderJar),
        'x-csrf-token': intruderCsrf,
      },
      payload: JSON.stringify({ raw_answer: 'not mine to write' }),
    });
    expect(res.statusCode).toBe(403);
    const body = res.json<{ ok: boolean; error: string }>();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('not_owner');
  });

  it('rejects autosave against a submitted attempt with 409', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    await seedClassWithTopic({ teacher, pupil, topicCode: '1.2' });
    await createQuestion(pool(), teacher.id, {
      topicCode: '1.2',
      active: true,
      approvalStatus: 'approved',
      parts: [
        {
          label: '(a)',
          prompt: 'Pick one.',
          marks: 1,
          expectedResponseType: 'multiple_choice',
          markPoints: [{ text: 'CPU', marks: 1 }],
        },
      ],
    });

    const jar = await loginAs(pupil);
    const started = await startAttemptAndGrabPart(jar, '1.2');
    const attemptId = /\/attempts\/(\d+)/.exec(started.attemptUrl)![1]!;

    const submit = await app.inject({
      method: 'POST',
      url: `${started.attemptUrl}/submit`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ _csrf: started.csrf, [`part_${started.partId}`]: 'CPU' }),
    });
    expect(submit.statusCode).toBe(302);
    updateJar(jar, submit);

    const res = await app.inject({
      method: 'POST',
      url: `/attempts/${attemptId}/parts/${started.partId}/autosave`,
      headers: {
        'content-type': 'application/json',
        cookie: cookieHeader(jar),
        'x-csrf-token': started.csrf,
      },
      payload: JSON.stringify({ raw_answer: 'too late' }),
    });
    expect(res.statusCode).toBe(409);
    const body = res.json<{ ok: boolean; error: string }>();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('already_submitted');
  });
});
