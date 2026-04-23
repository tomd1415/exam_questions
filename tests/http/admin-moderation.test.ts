import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../helpers/app.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createUser, createQuestion, type CreatedUser } from '../helpers/fixtures.js';
import { cookieHeader, extractCsrfToken, newJar, updateJar } from '../helpers/cookies.js';

// HTTP surface for the admin-only AI moderation queue.
// The integration test in tests/integration/moderation-queue.test.ts
// covers the flag-on-submit end-to-end; here we seed a flagged row
// directly so we can exercise the admin UI (auth, list render, detail
// render, accept POST, override POST, flashes) without running the LLM.

let app: FastifyInstance;
const pool = getSharedPool();

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
  const loginGet = await app.inject({ method: 'GET', url: '/login' });
  updateJar(jar, loginGet);
  const token = extractCsrfToken(loginGet.payload);
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

async function getPageWithCsrf(
  jar: ReturnType<typeof newJar>,
  url: string,
): Promise<{ status: number; payload: string; csrf: string }> {
  const res = await app.inject({
    method: 'GET',
    url,
    headers: { cookie: cookieHeader(jar) },
  });
  updateJar(jar, res);
  if (res.statusCode !== 200) {
    return { status: res.statusCode, payload: res.payload, csrf: '' };
  }
  return { status: 200, payload: res.payload, csrf: extractCsrfToken(res.payload) };
}

interface SeedResult {
  teacher: CreatedUser;
  pupil: CreatedUser;
  admin: CreatedUser;
  attemptPartId: string;
  awardedMarkId: string;
  partMarks: number;
  markPointIds: string[];
}

async function seedFlaggedAwardedMark(): Promise<SeedResult> {
  const teacher = await createUser(pool, { role: 'teacher' });
  const pupil = await createUser(pool, { role: 'pupil', displayName: 'Pupil Under Review' });
  const admin = await createUser(pool, { role: 'admin' });

  const cls = await pool.query<{ id: string }>(
    `INSERT INTO classes (name, teacher_id, academic_year)
     VALUES ('Moderation HTTP class', $1::bigint, '2025/26')
     RETURNING id::text`,
    [teacher.id],
  );
  const classId = cls.rows[0]!.id;
  await pool.query(`INSERT INTO enrolments (class_id, user_id) VALUES ($1::bigint, $2::bigint)`, [
    classId,
    pupil.id,
  ]);

  const question = await createQuestion(pool, teacher.id, {
    topicCode: '1.2',
    active: true,
    approvalStatus: 'approved',
    modelAnswer: 'CPU executes instructions; GPU renders pixels.',
    parts: [
      {
        label: '(a)',
        prompt: 'Explain the difference between the CPU and the GPU.',
        marks: 4,
        expectedResponseType: 'medium_text',
        markPoints: [
          { text: 'CPU executes instructions', marks: 2 },
          { text: 'GPU renders pixels', marks: 2 },
        ],
      },
    ],
  });

  const attempt = await pool.query<{ id: string }>(
    `INSERT INTO attempts (user_id, class_id, target_topic_code, mode)
     VALUES ($1::bigint, $2::bigint, '1.2', 'topic_set')
     RETURNING id::text`,
    [pupil.id, classId],
  );
  const attemptId = attempt.rows[0]!.id;

  const aq = await pool.query<{ id: string }>(
    `INSERT INTO attempt_questions (attempt_id, question_id, display_order)
     VALUES ($1::bigint, $2::bigint, 1)
     RETURNING id::text`,
    [attemptId, question.id],
  );
  const attemptQuestionId = aq.rows[0]!.id;

  const qp = await pool.query<{ id: string; marks: number }>(
    `SELECT id::text, marks FROM question_parts WHERE question_id = $1::bigint ORDER BY display_order ASC`,
    [question.id],
  );
  const questionPartId = qp.rows[0]!.id;
  const partMarks = qp.rows[0]!.marks;

  const ap = await pool.query<{ id: string }>(
    `INSERT INTO attempt_parts (attempt_question_id, question_part_id, raw_answer)
     VALUES ($1::bigint, $2::bigint, 'CPU runs things and GPU draws pixels.')
     RETURNING id::text`,
    [attemptQuestionId, questionPartId],
  );
  const attemptPartId = ap.rows[0]!.id;

  const mps = await pool.query<{ id: string }>(
    `SELECT id::text FROM mark_points WHERE question_part_id = $1::bigint ORDER BY display_order ASC`,
    [questionPartId],
  );
  const markPointIds = mps.rows.map((r) => r.id);

  const notes = JSON.stringify([{ kind: 'low_confidence', confidence: 0.3, threshold: 0.6 }]);

  const am = await pool.query<{ id: string }>(
    `INSERT INTO awarded_marks
       (attempt_part_id, marks_awarded, marks_total,
        mark_points_hit, mark_points_missed, evidence_quotes,
        marker, confidence, moderation_required, moderation_status,
        moderation_notes, prompt_version, model_id)
     VALUES ($1::bigint, 2, $2, $3::bigint[], $4::bigint[], $5::text[],
             'llm', 0.30, true, 'pending',
             $6::jsonb, 'mark_open_response@v0.1.0-http', 'gpt-5-mini')
     RETURNING id::text`,
    [attemptPartId, partMarks, [markPointIds[0]!], [markPointIds[1]!], ['CPU runs things'], notes],
  );
  const awardedMarkId = am.rows[0]!.id;

  return { teacher, pupil, admin, attemptPartId, awardedMarkId, partMarks, markPointIds };
}

describe('GET /admin/moderation (queue)', () => {
  it('redirects anonymous users to /login', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/moderation' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('forbids a pupil', async () => {
    const pupil = await createUser(pool, { role: 'pupil' });
    const jar = await loginAs(pupil);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/moderation',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('forbids a teacher (admin-only for now)', async () => {
    const teacher = await createUser(pool, { role: 'teacher' });
    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/moderation',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('lists a flagged row for an admin', async () => {
    const seed = await seedFlaggedAwardedMark();
    const jar = await loginAs(seed.admin);
    const { status, payload } = await getPageWithCsrf(jar, '/admin/moderation');
    expect(status).toBe(200);
    expect(payload).toContain('AI moderation');
    expect(payload).toContain('Pupil Under Review');
    expect(payload).toContain('1.2');
    expect(payload).toContain(`/admin/moderation/${seed.awardedMarkId}`);
  });

  it('shows an empty state when nothing is pending', async () => {
    const admin = await createUser(pool, { role: 'admin' });
    const jar = await loginAs(admin);
    const { status, payload } = await getPageWithCsrf(jar, '/admin/moderation');
    expect(status).toBe(200);
    // The template greets admins with the heading and a zero count.
    expect(payload).toContain('AI moderation');
    expect(payload).not.toContain('Pupil Under Review');
  });
});

describe('GET /admin/moderation/:id (detail)', () => {
  it('renders the detail page including the pupil answer and decision forms', async () => {
    const seed = await seedFlaggedAwardedMark();
    const jar = await loginAs(seed.admin);
    const { status, payload } = await getPageWithCsrf(
      jar,
      `/admin/moderation/${seed.awardedMarkId}`,
    );
    expect(status).toBe(200);
    expect(payload).toContain('Pupil Under Review');
    // Evidence quote is wrapped in a <mark>; surrounding text is not.
    expect(payload).toContain('<mark class="evidence-highlight">CPU runs things</mark>');
    expect(payload).toContain(' and GPU draws pixels.');
    expect(payload).toContain(`action="/admin/moderation/${seed.awardedMarkId}/accept"`);
    expect(payload).toContain(`action="/admin/moderation/${seed.awardedMarkId}/override"`);
    // Reason list renders the low-confidence label.
    expect(payload).toContain('Low confidence');
  });

  it('404s on unknown ids', async () => {
    const admin = await createUser(pool, { role: 'admin' });
    const jar = await loginAs(admin);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/moderation/99999999',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /admin/moderation/:id/accept', () => {
  it('flips the row to accepted and redirects with a flash', async () => {
    const seed = await seedFlaggedAwardedMark();
    const jar = await loginAs(seed.admin);
    const { csrf } = await getPageWithCsrf(jar, `/admin/moderation/${seed.awardedMarkId}`);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/moderation/${seed.awardedMarkId}/accept`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ _csrf: csrf }),
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('/admin/moderation');
    expect(res.headers.location).toContain('Mark%20accepted');

    const { rows } = await pool.query<{ moderation_status: string; reviewed: string | null }>(
      `SELECT moderation_status, moderation_reviewed_by::text AS reviewed
         FROM awarded_marks WHERE id = $1::bigint`,
      [seed.awardedMarkId],
    );
    expect(rows[0]!.moderation_status).toBe('accepted');
    expect(rows[0]!.reviewed).toBe(seed.admin.id);
  });

  it('rejects accept without CSRF', async () => {
    const seed = await seedFlaggedAwardedMark();
    const jar = await loginAs(seed.admin);
    const res = await app.inject({
      method: 'POST',
      url: `/admin/moderation/${seed.awardedMarkId}/accept`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: '',
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });
});

describe('POST /admin/moderation/:id/override', () => {
  it('inserts a teacher_override row and redirects with a flash', async () => {
    const seed = await seedFlaggedAwardedMark();
    const jar = await loginAs(seed.admin);
    const { csrf } = await getPageWithCsrf(jar, `/admin/moderation/${seed.awardedMarkId}`);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/moderation/${seed.awardedMarkId}/override`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({
        marks_awarded: String(seed.partMarks),
        reason: 'Answer actually covers both mark points.',
        _csrf: csrf,
      }),
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('Mark%20overridden');

    const { rows } = await pool.query<{
      marker: string;
      moderation_status: string;
      marks_awarded: number;
    }>(
      `SELECT marker, moderation_status, marks_awarded
         FROM awarded_marks
        WHERE attempt_part_id = $1::bigint
        ORDER BY created_at ASC`,
      [seed.attemptPartId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.marker).toBe('llm');
    expect(rows[0]!.moderation_status).toBe('overridden');
    expect(rows[1]!.marker).toBe('teacher_override');
    expect(rows[1]!.moderation_status).toBe('not_required');
    expect(rows[1]!.marks_awarded).toBe(seed.partMarks);
  });

  it('redirects back to the detail page with a flash when marks are out of range', async () => {
    const seed = await seedFlaggedAwardedMark();
    const jar = await loginAs(seed.admin);
    const { csrf } = await getPageWithCsrf(jar, `/admin/moderation/${seed.awardedMarkId}`);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/moderation/${seed.awardedMarkId}/override`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({
        marks_awarded: String(seed.partMarks + 10),
        reason: 'too many',
        _csrf: csrf,
      }),
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain(`/admin/moderation/${seed.awardedMarkId}`);
    expect(res.headers.location).toContain('outside');

    const { rows } = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM awarded_marks WHERE attempt_part_id = $1::bigint`,
      [seed.attemptPartId],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('redirects with a validation flash when reason is missing', async () => {
    const seed = await seedFlaggedAwardedMark();
    const jar = await loginAs(seed.admin);
    const { csrf } = await getPageWithCsrf(jar, `/admin/moderation/${seed.awardedMarkId}`);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/moderation/${seed.awardedMarkId}/override`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({
        marks_awarded: String(seed.partMarks),
        reason: '',
        _csrf: csrf,
      }),
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain(`/admin/moderation/${seed.awardedMarkId}`);
  });
});

// Chunk 3i. Pilot-shadow queue lives at /admin/moderation?mode=pilot.
// A row here is characterised by pilot_shadow_status='pending_shadow'.
// Submitting at /admin/moderation/:id/pilot-review always writes a
// teacher_override row — even when the teacher's mark matches the AI —
// because full agreement IS the load-bearing accuracy signal.
async function seedPilotShadowAwardedMark(): Promise<SeedResult> {
  const seed = await seedFlaggedAwardedMark();
  // Turn the flagged row into a clean pilot-shadow row: not flagged
  // for the pupil (moderation_status='not_required'), but queued for
  // teacher shadow review via pilot_shadow_status='pending_shadow'.
  await pool.query(
    `UPDATE awarded_marks
        SET moderation_required = false,
            moderation_status = 'not_required',
            moderation_notes = NULL,
            pilot_shadow_status = 'pending_shadow'
      WHERE id = $1::bigint`,
    [seed.awardedMarkId],
  );
  return seed;
}

describe('GET /admin/moderation?mode=pilot', () => {
  it('lists pilot-shadow rows and not safety-gate rows', async () => {
    const pilot = await seedPilotShadowAwardedMark();
    // A second row that's only in the safety-gate queue.
    await seedFlaggedAwardedMark();
    const jar = await loginAs(pilot.admin);
    const page = await getPageWithCsrf(jar, '/admin/moderation?mode=pilot');
    expect(page.status).toBe(200);
    expect(page.payload).toContain('Pilot shadow review queue');
    expect(page.payload).toContain(pilot.awardedMarkId);
    // Non-pilot row must not appear on the pilot tab.
    const defaultPage = await getPageWithCsrf(jar, '/admin/moderation');
    expect(defaultPage.payload).not.toContain(`/admin/moderation/${pilot.awardedMarkId}`);
  });

  it('shows an empty state when no pilot rows exist', async () => {
    await seedFlaggedAwardedMark(); // default-queue row only
    const admin = await createUser(pool, { role: 'admin', username: `admin_empty_${Date.now()}` });
    const jar = await loginAs(admin);
    const page = await getPageWithCsrf(jar, '/admin/moderation?mode=pilot');
    expect(page.status).toBe(200);
    expect(page.payload).toContain('Nothing to shadow-review');
  });
});

describe('POST /admin/moderation/:id/pilot-review', () => {
  it('writes a teacher_override row even when marks match the AI (agreement is a signal)', async () => {
    const seed = await seedPilotShadowAwardedMark();
    const jar = await loginAs(seed.admin);
    const page = await getPageWithCsrf(jar, `/admin/moderation/${seed.awardedMarkId}?mode=pilot`);
    expect(page.status).toBe(200);
    expect(page.payload).toContain('Shadow review');

    const res = await app.inject({
      method: 'POST',
      url: `/admin/moderation/${seed.awardedMarkId}/pilot-review`,
      headers: {
        cookie: cookieHeader(jar),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: form({
        marks_awarded: '2', // same as the AI awarded
        reason: 'Teacher agrees with AI.',
        _csrf: page.csrf,
      }),
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('mode=pilot');

    const { rows: shadowRow } = await pool.query<{
      pilot_shadow_status: string | null;
    }>(`SELECT pilot_shadow_status FROM awarded_marks WHERE id = $1::bigint`, [seed.awardedMarkId]);
    expect(shadowRow[0]!.pilot_shadow_status).toBe('reviewed');

    const { rows: overrides } = await pool.query<{
      new_marks_awarded: number;
      reason: string;
    }>(
      `SELECT o.new_marks_awarded, o.reason
         FROM teacher_overrides o
         JOIN awarded_marks am ON am.id = o.awarded_mark_id
        WHERE am.attempt_part_id = $1::bigint AND am.marker = 'teacher_override'`,
      [seed.attemptPartId],
    );
    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.new_marks_awarded).toBe(2);
    expect(overrides[0]!.reason).toBe('Teacher agrees with AI.');
  });

  it('leaves the pupil-facing row alive (moderation_status stays not_required)', async () => {
    const seed = await seedPilotShadowAwardedMark();
    const jar = await loginAs(seed.admin);
    const page = await getPageWithCsrf(jar, `/admin/moderation/${seed.awardedMarkId}?mode=pilot`);

    await app.inject({
      method: 'POST',
      url: `/admin/moderation/${seed.awardedMarkId}/pilot-review`,
      headers: {
        cookie: cookieHeader(jar),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: form({
        marks_awarded: '3',
        reason: 'Teacher would have given 3.',
        _csrf: page.csrf,
      }),
    });

    const { rows } = await pool.query<{ moderation_status: string }>(
      `SELECT moderation_status FROM awarded_marks WHERE id = $1::bigint`,
      [seed.awardedMarkId],
    );
    // Pilot reviews never flip the AI row's moderation_status —
    // the pupil keeps seeing the AI mark; the teacher's mark is a
    // parallel record for the accuracy calculation.
    expect(rows[0]!.moderation_status).toBe('not_required');
  });

  it('rejects marks outside the part range', async () => {
    const seed = await seedPilotShadowAwardedMark();
    const jar = await loginAs(seed.admin);
    const page = await getPageWithCsrf(jar, `/admin/moderation/${seed.awardedMarkId}?mode=pilot`);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/moderation/${seed.awardedMarkId}/pilot-review`,
      headers: {
        cookie: cookieHeader(jar),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: form({
        marks_awarded: String(seed.partMarks + 5),
        reason: 'too many marks',
        _csrf: page.csrf,
      }),
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain(`/admin/moderation/${seed.awardedMarkId}`);
  });

  it('rejects a second pilot review (already_resolved)', async () => {
    const seed = await seedPilotShadowAwardedMark();
    const jar = await loginAs(seed.admin);
    const page = await getPageWithCsrf(jar, `/admin/moderation/${seed.awardedMarkId}?mode=pilot`);

    await app.inject({
      method: 'POST',
      url: `/admin/moderation/${seed.awardedMarkId}/pilot-review`,
      headers: {
        cookie: cookieHeader(jar),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: form({ marks_awarded: '2', reason: 'first', _csrf: page.csrf }),
    });

    const page2 = await getPageWithCsrf(jar, `/admin/moderation/${seed.awardedMarkId}?mode=pilot`);
    const res = await app.inject({
      method: 'POST',
      url: `/admin/moderation/${seed.awardedMarkId}/pilot-review`,
      headers: {
        cookie: cookieHeader(jar),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: form({ marks_awarded: '3', reason: 'second', _csrf: page2.csrf }),
    });
    expect(res.statusCode).toBe(302);
    // Flash is URL-encoded in the Location header.
    expect(res.headers.location).toContain('already');
  });
});
