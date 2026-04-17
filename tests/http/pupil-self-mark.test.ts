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

/**
 * Build: class + enrolment + one open-response question; start an attempt
 * for the pupil and submit the single question so the part is eligible
 * for a self-estimate. Returns the attempt id and the part id.
 */
async function seedSubmittedOpenAttempt(pupil: CreatedUser): Promise<{
  attemptId: string;
  partId: string;
  partMarks: number;
  jar: ReturnType<typeof newJar>;
}> {
  const teacher = await createUser(pool(), { role: 'teacher' });
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO classes (name, teacher_id, academic_year)
     VALUES ('Self-mark test', $1::bigint, '2025/26') RETURNING id::text`,
    [teacher.id],
  );
  const classId = rows[0]!.id;
  await pool().query(`INSERT INTO enrolments (class_id, user_id) VALUES ($1::bigint, $2::bigint)`, [
    classId,
    pupil.id,
  ]);
  await pool().query(
    `INSERT INTO class_assigned_topics (class_id, topic_code, assigned_by)
     VALUES ($1::bigint, '1.2', $2::bigint)`,
    [classId, teacher.id],
  );
  await pool().query(`UPDATE classes SET topic_set_size = 1 WHERE id = $1::bigint`, [classId]);
  await createQuestion(pool(), teacher.id, {
    topicCode: '1.2',
    active: true,
    approvalStatus: 'approved',
    parts: [
      {
        label: '(a)',
        prompt: 'Explain TCP/IP layers.',
        marks: 4,
        expectedResponseType: 'long_text',
        markPoints: [{ text: 'application layer', marks: 1 }],
      },
    ],
  });

  const jar = await loginAs(pupil);
  const topics = await app.inject({
    method: 'GET',
    url: '/topics',
    headers: { cookie: cookieHeader(jar) },
  });
  updateJar(jar, topics);
  const startRes = await app.inject({
    method: 'POST',
    url: '/topics/1.2/start',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: cookieHeader(jar),
    },
    payload: form({ _csrf: extractCsrfToken(topics.payload) }),
  });
  expect(startRes.statusCode).toBe(302);
  updateJar(jar, startRes);
  const attemptUrl = startRes.headers.location!;
  const attemptId = attemptUrl.split('/').pop()!;

  const edit = await app.inject({
    method: 'GET',
    url: attemptUrl,
    headers: { cookie: cookieHeader(jar) },
  });
  updateJar(jar, edit);
  const partMatch = /name="part_(\d+)"/.exec(edit.payload);
  expect(partMatch).not.toBeNull();
  const partId = partMatch![1]!;
  const questionAction = /action="(\/attempts\/\d+\/questions\/\d+\/submit)"/.exec(
    edit.payload,
  )![1]!;

  const submit = await app.inject({
    method: 'POST',
    url: questionAction,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: cookieHeader(jar),
    },
    payload: form({
      _csrf: extractCsrfToken(edit.payload),
      [`part_${partId}`]: 'Long open-response body text.',
    }),
  });
  expect(submit.statusCode).toBe(302);
  updateJar(jar, submit);

  return { attemptId, partId, partMarks: 4, jar };
}

async function csrfFromAttempt(jar: ReturnType<typeof newJar>, attemptId: string): Promise<string> {
  const page = await app.inject({
    method: 'GET',
    url: `/attempts/${attemptId}`,
    headers: { cookie: cookieHeader(jar) },
  });
  updateJar(jar, page);
  return extractCsrfToken(page.payload);
}

describe('POST /attempts/:id/parts/:pid/self-mark', () => {
  it('accepts a valid integer and writes attempt_parts.pupil_self_marks', async () => {
    const pupil = await createUser(pool(), { role: 'pupil' });
    const { attemptId, partId, jar } = await seedSubmittedOpenAttempt(pupil);
    const csrf = await csrfFromAttempt(jar, attemptId);

    const res = await app.inject({
      method: 'POST',
      url: `/attempts/${attemptId}/parts/${partId}/self-mark`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ _csrf: csrf, marks: '2' }),
    });
    expect(res.statusCode).toBe(302);
    expect(decodeURIComponent(res.headers.location!)).toContain('Self-estimate saved');

    const row = (
      await pool().query<{ pupil_self_marks: number | null }>(
        `SELECT pupil_self_marks FROM attempt_parts WHERE id = $1::bigint`,
        [partId],
      )
    ).rows[0];
    expect(row?.pupil_self_marks).toBe(2);

    // No awarded_marks row created by self-marking.
    const awarded = await pool().query<{ c: string }>(
      `SELECT count(*)::text AS c FROM awarded_marks WHERE attempt_part_id = $1::bigint`,
      [partId],
    );
    expect(Number(awarded.rows[0]!.c)).toBe(0);

    // No teacher_override row created by self-marking.
    const override = await pool().query<{ c: string }>(
      `SELECT count(*)::text AS c FROM teacher_overrides tov
         JOIN awarded_marks am ON am.id = tov.awarded_mark_id
        WHERE am.attempt_part_id = $1::bigint`,
      [partId],
    );
    expect(Number(override.rows[0]!.c)).toBe(0);

    // Audit event recorded.
    const audit = await pool().query<{ event_type: string }>(
      `SELECT event_type FROM audit_events WHERE actor_user_id = $1::bigint`,
      [pupil.id],
    );
    expect(audit.rows.map((r) => r.event_type)).toContain('attempt.part.self_mark');
  });

  it('accepts zero and an empty string (clears the self-estimate)', async () => {
    const pupil = await createUser(pool(), { role: 'pupil' });
    const { attemptId, partId, jar } = await seedSubmittedOpenAttempt(pupil);

    const csrf1 = await csrfFromAttempt(jar, attemptId);
    await app.inject({
      method: 'POST',
      url: `/attempts/${attemptId}/parts/${partId}/self-mark`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ _csrf: csrf1, marks: '0' }),
    });
    expect(
      (
        await pool().query<{ pupil_self_marks: number | null }>(
          `SELECT pupil_self_marks FROM attempt_parts WHERE id = $1::bigint`,
          [partId],
        )
      ).rows[0]?.pupil_self_marks,
    ).toBe(0);

    const csrf2 = await csrfFromAttempt(jar, attemptId);
    await app.inject({
      method: 'POST',
      url: `/attempts/${attemptId}/parts/${partId}/self-mark`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ _csrf: csrf2, marks: '' }),
    });
    expect(
      (
        await pool().query<{ pupil_self_marks: number | null }>(
          `SELECT pupil_self_marks FROM attempt_parts WHERE id = $1::bigint`,
          [partId],
        )
      ).rows[0]?.pupil_self_marks,
    ).toBeNull();
  });

  it('redirects with a flash for out-of-range values (not 400)', async () => {
    const pupil = await createUser(pool(), { role: 'pupil' });
    const { attemptId, partId, partMarks, jar } = await seedSubmittedOpenAttempt(pupil);
    const csrf = await csrfFromAttempt(jar, attemptId);

    const res = await app.inject({
      method: 'POST',
      url: `/attempts/${attemptId}/parts/${partId}/self-mark`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ _csrf: csrf, marks: String(partMarks + 1) }),
    });
    expect(res.statusCode).toBe(302);
    expect(decodeURIComponent(res.headers.location!)).toContain('between 0 and the part max');

    expect(
      (
        await pool().query<{ pupil_self_marks: number | null }>(
          `SELECT pupil_self_marks FROM attempt_parts WHERE id = $1::bigint`,
          [partId],
        )
      ).rows[0]?.pupil_self_marks,
    ).toBeNull();
  });

  it('rejects non-integer input with 400', async () => {
    const pupil = await createUser(pool(), { role: 'pupil' });
    const { attemptId, partId, jar } = await seedSubmittedOpenAttempt(pupil);
    const csrf = await csrfFromAttempt(jar, attemptId);

    const res = await app.inject({
      method: 'POST',
      url: `/attempts/${attemptId}/parts/${partId}/self-mark`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ _csrf: csrf, marks: '2.5' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 403 for a different pupil trying to self-mark', async () => {
    const pupilA = await createUser(pool(), { role: 'pupil' });
    const pupilB = await createUser(pool(), { role: 'pupil' });
    const { attemptId, partId } = await seedSubmittedOpenAttempt(pupilA);

    const jarB = await loginAs(pupilB);
    const page = await app.inject({
      method: 'GET',
      url: '/topics',
      headers: { cookie: cookieHeader(jarB) },
    });
    updateJar(jarB, page);
    const csrf = extractCsrfToken(page.payload);

    const res = await app.inject({
      method: 'POST',
      url: `/attempts/${attemptId}/parts/${partId}/self-mark`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jarB),
      },
      payload: form({ _csrf: csrf, marks: '3' }),
    });
    expect(res.statusCode).toBe(403);
  });
});
