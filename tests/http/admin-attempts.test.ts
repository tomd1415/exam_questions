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

async function seedMixedSubmission(params: {
  teacher: CreatedUser;
  pupil: CreatedUser;
  topicCode: string;
}): Promise<{ classId: string; attemptId: string; openPartId: string; mcPartId: string }> {
  const p = pool();
  const { rows } = await p.query<{ id: string }>(
    `INSERT INTO classes (name, teacher_id, academic_year)
     VALUES ('Marking test', $1::bigint, '2025/26') RETURNING id::text`,
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
  await createQuestion(p, params.teacher.id, {
    topicCode: params.topicCode,
    subtopicCode: `${params.topicCode}.1`,
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
      {
        label: '(b)',
        prompt: 'Explain at length.',
        marks: 6,
        expectedResponseType: 'extended_response',
      },
    ],
  });

  // Pupil starts + submits.
  const pupilJar = await loginAs(params.pupil);
  const topics = await app.inject({
    method: 'GET',
    url: '/topics',
    headers: { cookie: cookieHeader(pupilJar) },
  });
  updateJar(pupilJar, topics);
  const csrfStart = extractCsrfToken(topics.payload);
  const start = await app.inject({
    method: 'POST',
    url: `/topics/${params.topicCode}/start`,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: cookieHeader(pupilJar),
    },
    payload: form({ _csrf: csrfStart }),
  });
  expect(start.statusCode).toBe(302);
  const attemptUrl = start.headers.location!;
  updateJar(pupilJar, start);
  const attemptId = attemptUrl.split('/').pop()!;

  const editPage = await app.inject({
    method: 'GET',
    url: attemptUrl,
    headers: { cookie: cookieHeader(pupilJar) },
  });
  expect(editPage.statusCode).toBe(200);
  updateJar(pupilJar, editPage);
  const csrfSubmit = extractCsrfToken(editPage.payload);
  const partIds = Array.from(editPage.payload.matchAll(/name="part_(\d+)"/g)).map((m) => m[1]!);
  expect(partIds.length).toBe(2);
  const submit = await app.inject({
    method: 'POST',
    url: `${attemptUrl}/submit`,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: cookieHeader(pupilJar),
    },
    payload: form({
      _csrf: csrfSubmit,
      [`part_${partIds[0]!}`]: 'CPU',
      [`part_${partIds[1]!}`]: 'An essay answer.',
    }),
  });
  expect(submit.statusCode).toBe(302);

  const parts = await pool().query<{ id: string; part_label: string }>(
    `SELECT ap.id::text, qp.part_label
       FROM attempt_parts ap
       JOIN attempt_questions aq ON aq.id = ap.attempt_question_id
       JOIN question_parts qp    ON qp.id = ap.question_part_id
      WHERE aq.attempt_id = $1::bigint`,
    [attemptId],
  );
  const mcPartId = parts.rows.find((r) => r.part_label === '(a)')!.id;
  const openPartId = parts.rows.find((r) => r.part_label === '(b)')!.id;
  return { classId, attemptId, openPartId, mcPartId };
}

describe('GET /admin/classes/:id/attempts', () => {
  it('redirects unauthenticated users to /login', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/classes/1/attempts' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('returns 403 to pupils', async () => {
    const pupil = await createUser(pool(), { role: 'pupil' });
    const jar = await loginAs(pupil);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/classes/1/attempts',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('teacher A cannot see teacher B\u2019s class attempts', async () => {
    const teacherA = await createUser(pool(), { role: 'teacher' });
    const teacherB = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    const { classId } = await seedMixedSubmission({
      teacher: teacherB,
      pupil,
      topicCode: '1.2',
    });
    const jar = await loginAs(teacherA);
    const res = await app.inject({
      method: 'GET',
      url: `/admin/classes/${classId}/attempts`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('teacher sees a submission row for their own class', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    const { classId } = await seedMixedSubmission({ teacher, pupil, topicCode: '1.2' });
    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: `/admin/classes/${classId}/attempts`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain(pupil.display_name);
    expect(res.payload).toContain('1 pending');
  });
});

describe('GET /admin/attempts/:id', () => {
  it('teacher gets 403 for an attempt in another teacher\u2019s class', async () => {
    const teacherA = await createUser(pool(), { role: 'teacher' });
    const teacherB = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    const { attemptId } = await seedMixedSubmission({
      teacher: teacherB,
      pupil,
      topicCode: '1.2',
    });
    const jar = await loginAs(teacherA);
    const res = await app.inject({
      method: 'GET',
      url: `/admin/attempts/${attemptId}`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('teacher sees the attempt detail page with mark forms for their class', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    const { attemptId } = await seedMixedSubmission({ teacher, pupil, topicCode: '1.2' });
    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: `/admin/attempts/${attemptId}`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('Pupil answer:');
    expect(res.payload).toContain('Save mark');
    // Mark-scheme reveal contains the rubric text (teacher-only view).
    expect(res.payload).toContain('Mark scheme');
  });
});

describe('POST /admin/attempts/:id/parts/:partId/mark', () => {
  it('teacher can set a mark on an open-response part; pupil review reflects it', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    const { attemptId, openPartId } = await seedMixedSubmission({
      teacher,
      pupil,
      topicCode: '1.2',
    });
    const jar = await loginAs(teacher);
    const detail = await app.inject({
      method: 'GET',
      url: `/admin/attempts/${attemptId}`,
      headers: { cookie: cookieHeader(jar) },
    });
    updateJar(jar, detail);
    const csrf = extractCsrfToken(detail.payload);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/attempts/${attemptId}/parts/${openPartId}/mark`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({
        _csrf: csrf,
        marks_awarded: '4',
        reason: 'Strong on stages, missed the clock tie-in.',
      }),
    });
    expect(res.statusCode).toBe(302);
    expect(decodeURIComponent(res.headers.location!)).toContain('Mark updated.');

    // Pupil revisits their review — updated score.
    const pupilJar = await loginAs(pupil);
    const review = await app.inject({
      method: 'GET',
      url: `/attempts/${attemptId}`,
      headers: { cookie: cookieHeader(pupilJar) },
    });
    expect(review.statusCode).toBe(200);
    // 1 (MC) + 4 (teacher override) = 5 / 7
    expect(review.payload).toContain('5 / 7');
    // No more pending banner on part (b).
    expect(review.payload).not.toContain('awaiting teacher marking');
  });

  it('rejects marks above the part\u2019s maximum with a flash', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    const { attemptId, openPartId } = await seedMixedSubmission({
      teacher,
      pupil,
      topicCode: '1.2',
    });
    const jar = await loginAs(teacher);
    const detail = await app.inject({
      method: 'GET',
      url: `/admin/attempts/${attemptId}`,
      headers: { cookie: cookieHeader(jar) },
    });
    updateJar(jar, detail);
    const csrf = extractCsrfToken(detail.payload);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/attempts/${attemptId}/parts/${openPartId}/mark`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({
        _csrf: csrf,
        marks_awarded: '99',
        reason: 'Attempting an impossible mark.',
      }),
    });
    expect(res.statusCode).toBe(302);
    expect(decodeURIComponent(res.headers.location!)).toContain('outside the allowed range');
  });

  it('rejects an empty reason', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    const { attemptId, openPartId } = await seedMixedSubmission({
      teacher,
      pupil,
      topicCode: '1.2',
    });
    const jar = await loginAs(teacher);
    const detail = await app.inject({
      method: 'GET',
      url: `/admin/attempts/${attemptId}`,
      headers: { cookie: cookieHeader(jar) },
    });
    updateJar(jar, detail);
    const csrf = extractCsrfToken(detail.payload);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/attempts/${attemptId}/parts/${openPartId}/mark`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ _csrf: csrf, marks_awarded: '3', reason: '   ' }),
    });
    expect(res.statusCode).toBe(302);
    expect(decodeURIComponent(res.headers.location!)).toContain('reason');
  });

  it('403s a teacher marking an attempt that belongs to a different teacher\u2019s class', async () => {
    const teacherA = await createUser(pool(), { role: 'teacher' });
    const teacherB = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    const { attemptId, openPartId } = await seedMixedSubmission({
      teacher: teacherB,
      pupil,
      topicCode: '1.2',
    });
    // Teacher A logs in and grabs a valid CSRF token from somewhere they can load.
    const jar = await loginAs(teacherA);
    const page = await app.inject({
      method: 'GET',
      url: '/admin/classes/new',
      headers: { cookie: cookieHeader(jar) },
    });
    updateJar(jar, page);
    const csrf = extractCsrfToken(page.payload);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/attempts/${attemptId}/parts/${openPartId}/mark`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ _csrf: csrf, marks_awarded: '3', reason: 'Cheeky.' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('does not let a pupil mark an attempt as a teacher (pupils 403 at the role gate)', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    const { attemptId, openPartId } = await seedMixedSubmission({
      teacher,
      pupil,
      topicCode: '1.2',
    });
    const pupilJar = await loginAs(pupil);
    const topics = await app.inject({
      method: 'GET',
      url: '/topics',
      headers: { cookie: cookieHeader(pupilJar) },
    });
    updateJar(pupilJar, topics);
    const csrf = extractCsrfToken(topics.payload);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/attempts/${attemptId}/parts/${openPartId}/mark`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(pupilJar),
      },
      payload: form({ _csrf: csrf, marks_awarded: '3', reason: 'Self mark.' }),
    });
    expect(res.statusCode).toBe(403);
  });
});

// Regression guard for the 500 that bit the teacher on day one of
// the chunk 3i pilot: clicking an attempt containing a drawn
// flowchart answer produced
//   "it.buildPupilAnswerView is not a function"
// because the template was calling a function threaded through the
// view context from the route. We now compute the decoded views in
// the route and pass them as data (a Map keyed by attempt_part_id);
// the template falls back to a plain text render if the map is
// absent. This test seeds an attempt with every tricky widget
// shape — flowchart image, matching, trace_table — and asserts the
// detail page still 200s and renders the decoded output.
async function seedStructuredSubmission(params: {
  teacher: CreatedUser;
  pupil: CreatedUser;
  topicCode: string;
}): Promise<{ classId: string; attemptId: string }> {
  const p = pool();
  const cls = await p.query<{ id: string }>(
    `INSERT INTO classes (name, teacher_id, academic_year)
     VALUES ('Structured widgets regression', $1::bigint, '2025/26')
     RETURNING id::text`,
    [params.teacher.id],
  );
  const classId = cls.rows[0]!.id;
  await p.query(`INSERT INTO enrolments (class_id, user_id) VALUES ($1::bigint, $2::bigint)`, [
    classId,
    params.pupil.id,
  ]);

  const matchingCfg = {
    left: ['Sodium', 'Iron'],
    right: ['Metal', 'Alkali metal'],
    correctPairs: [
      [0, 1],
      [1, 0],
    ],
  };
  const traceCfg = {
    rows: 2,
    columns: [{ name: 'i' }, { name: 'sum' }],
    expected: { '0,0': '0', '0,1': '0', '1,0': '1', '1,1': '1' },
    marking: { mode: 'perCell' },
  };
  const flowchartCfg = { variant: 'image', canvas: { width: 400, height: 300 } };

  const q = await createQuestion(p, params.teacher.id, {
    topicCode: params.topicCode,
    subtopicCode: `${params.topicCode}.1`,
    active: true,
    approvalStatus: 'approved',
    parts: [
      {
        label: '(a)',
        prompt: 'Draw the flowchart.',
        marks: 3,
        expectedResponseType: 'flowchart',
        partConfig: flowchartCfg,
      },
      {
        label: '(b)',
        prompt: 'Match elements to categories.',
        marks: 2,
        expectedResponseType: 'matching',
        partConfig: matchingCfg,
        markPoints: [
          { text: 'Sodium ↔ Alkali metal', marks: 1 },
          { text: 'Iron ↔ Metal', marks: 1 },
        ],
      },
      {
        label: '(c)',
        prompt: 'Trace the loop.',
        marks: 4,
        expectedResponseType: 'trace_table',
        partConfig: traceCfg,
      },
    ],
  });

  const attempt = await p.query<{ id: string }>(
    `INSERT INTO attempts (user_id, class_id, target_topic_code, mode, submitted_at)
     VALUES ($1::bigint, $2::bigint, $3, 'topic_set', now())
     RETURNING id::text`,
    [params.pupil.id, classId, params.topicCode],
  );
  const attemptId = attempt.rows[0]!.id;
  const aq = await p.query<{ id: string }>(
    `INSERT INTO attempt_questions (attempt_id, question_id, display_order)
     VALUES ($1::bigint, $2::bigint, 1)
     RETURNING id::text`,
    [attemptId, q.id],
  );
  const aqId = aq.rows[0]!.id;
  const parts = await p.query<{ id: string; part_label: string }>(
    `INSERT INTO attempt_parts (attempt_question_id, question_part_id, raw_answer)
     SELECT $1::bigint, qp.id,
            CASE qp.part_label
              WHEN '(a)' THEN 'image=data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII='
              WHEN '(b)' THEN E'0=1\n1=0'
              WHEN '(c)' THEN E'0,0=0\n0,1=0\n1,0=1\n1,1=1'
            END
       FROM question_parts qp
      WHERE qp.question_id = $2::bigint
      ORDER BY qp.display_order
    RETURNING id::text, (SELECT part_label FROM question_parts qp2 WHERE qp2.id = question_part_id)`,
    [aqId, q.id],
  );
  expect(parts.rowCount).toBe(3);
  return { classId, attemptId };
}

describe('GET /admin/attempts/:id — structured widget rendering (regression)', () => {
  it('renders a 200 for an attempt with flowchart image + matching + trace_table parts', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    const { attemptId } = await seedStructuredSubmission({
      teacher,
      pupil,
      topicCode: '1.2',
    });
    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: `/admin/attempts/${attemptId}`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    // Flowchart image: rendered as <img>, not as the raw base64 string.
    expect(res.payload).toMatch(/<img\s+class="pupil-answer-image"/);
    expect(res.payload).not.toContain('image=data:image/png');
    // Matching: decoded into left-prompt rows using the authored labels.
    expect(res.payload).toContain('Sodium');
    expect(res.payload).toContain('Alkali metal');
    expect(res.payload).toContain('Iron');
    // Trace table: rendered as a 2D grid with the pupil's values.
    expect(res.payload).toMatch(/class="pupil-answer-grid"/);
    // And the raw `0,0=0` wire format must not leak through.
    expect(res.payload).not.toContain('0,0=0');
  });

  it('falls back to a plain-text render if answerViewByPart is not passed', async () => {
    // Belt-and-braces: the template's fallback branch protects a
    // future route that renders admin_attempt_detail.eta without
    // wiring the map — better to show the raw encoded answer than
    // 500 the page. The real routes always pass the map; this test
    // validates the fallback without having to remove it from the
    // real route.
    const Eta = await import('eta');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const templatesDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'src',
      'templates',
    );
    const eta = new Eta.Eta({ views: templatesDir, cache: false });
    const bundle = {
      attempt: {
        id: '1',
        user_id: '1',
        class_id: '1',
        started_at: new Date(),
        submitted_at: new Date(),
        mode: 'topic_set' as const,
        target_topic_code: '1.2',
        reveal_mode: 'per_question' as const,
        timer_minutes: null,
        elapsed_seconds: null,
      },
      questions: [
        {
          id: '10',
          attempt_id: '1',
          question_id: '100',
          display_order: 1,
          stem: 'Stem',
          model_answer: 'Model',
          topic_code: '1.2',
          subtopic_code: '1.2.1',
          command_word_code: 'explain',
          marks_total: 2,
          submitted_at: new Date(),
        },
      ],
      partsByQuestion: new Map([
        [
          '10',
          [
            {
              id: '20',
              attempt_question_id: '10',
              question_part_id: '200',
              part_label: '(a)',
              prompt: 'Describe.',
              marks: 2,
              expected_response_type: 'medium_text',
              part_config: null,
              display_order: 1,
              raw_answer: 'Prose answer.',
              last_saved_at: new Date(),
              submitted_at: null,
              pupil_self_marks: null,
              pupil_feedback_fallback: null,
            },
          ],
        ],
      ]),
      markPointsByPart: new Map(),
      awardedByAttemptPart: new Map(),
    };
    // Intentionally omit answerViewByPart from the render context.
    const html = await eta.renderAsync('admin_attempt_detail', {
      title: 't',
      currentUser: { id: '1', role: 'admin' },
      csrfToken: 'x',
      bundle,
      flash: null,
    });
    expect(html).toContain('Prose answer.');
    expect(html).not.toContain('buildPupilAnswerView is not a function');
  });
});
