import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../helpers/app.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createUser, createQuestion, type CreatedUser } from '../helpers/fixtures.js';
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
  const loginPage = await app.inject({ method: 'GET', url: '/login' });
  updateJar(jar, loginPage);
  const token = extractCsrfToken(loginPage.payload);
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

function happyQuestionFields(csrf: string): Record<string, string> {
  return {
    _csrf: csrf,
    component_code: 'J277/01',
    topic_code: '1.1',
    subtopic_code: '1.1.1',
    command_word_code: 'describe',
    archetype_code: 'explain',
    stem: 'Describe the role of the control unit.',
    expected_response_type: 'short_text',
    model_answer: 'The control unit directs the CPU.',
    feedback_template: '',
    difficulty_band: '3',
    difficulty_step: '1',
    source_type: 'teacher',
    parts_count: '1',
    part_0_label: '(a)',
    part_0_prompt: 'State one role.',
    part_0_marks: '1',
    part_0_response_type: 'short_text',
    part_0_mp_count: '1',
    part_0_mp_0_text: 'Directs the flow of data.',
    part_0_mp_0_marks: '1',
    part_0_mp_0_alternatives: '',
    part_0_misc_count: '0',
  };
}

async function getNewFormCsrf(jar: ReturnType<typeof newJar>): Promise<string> {
  const res = await app.inject({
    method: 'GET',
    url: '/admin/questions/new',
    headers: { cookie: cookieHeader(jar) },
  });
  updateJar(jar, res);
  return extractCsrfToken(res.payload);
}

describe('GET /admin/questions/new', () => {
  it('renders the form for a teacher with the classification selects populated', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/questions/new',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('name="stem"');
    expect(res.payload).toContain('name="component_code"');
    expect(res.payload).toContain('value="J277/01"');
    expect(res.payload).toContain('value="describe"');
    expect(res.payload).toContain('name="parts_count"');
  });

  it('returns 403 for pupils', async () => {
    const pupil = await createUser(pool(), { role: 'pupil' });
    const jar = await loginAs(pupil);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/questions/new',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /admin/questions', () => {
  it('creates a draft and redirects to its detail page', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const csrf = await getNewFormCsrf(jar);

    const res = await app.inject({
      method: 'POST',
      url: '/admin/questions',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form(happyQuestionFields(csrf)),
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^\/admin\/questions\/\d+\?flash=/);

    const created = await pool().query<{ id: string; stem: string; active: boolean }>(
      `SELECT id::text, stem, active FROM questions WHERE stem LIKE 'Describe the role of the control unit.%'`,
    );
    expect(created.rows).toHaveLength(1);
    expect(created.rows[0]!.active).toBe(false);

    const parts = await pool().query<{ c: string }>(
      `SELECT count(*)::text AS c FROM question_parts WHERE question_id = $1::bigint`,
      [created.rows[0]!.id],
    );
    expect(Number.parseInt(parts.rows[0]!.c, 10)).toBe(1);
  });

  it('returns 403 for pupils', async () => {
    const pupil = await createUser(pool(), { role: 'pupil' });
    const jar = await loginAs(pupil);
    // Pupils cannot reach the form to get a CSRF token, so we still POST —
    // authz must reject before accepting the write.
    const loginPage = await app.inject({ method: 'GET', url: '/login' });
    const token = extractCsrfToken(loginPage.payload);
    const res = await app.inject({
      method: 'POST',
      url: '/admin/questions',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form(happyQuestionFields(token)),
    });
    // CSRF will fail first (403) because the pupil's jar doesn't have a
    // signed _csrf cookie from the admin form. Either 403 is acceptable;
    // the important guarantee is "no question row is written".
    expect(res.statusCode).toBe(403);
    const { rows } = await pool().query<{ c: string }>(
      `SELECT count(*)::text AS c FROM questions WHERE stem LIKE 'Describe the role of the control unit.%'`,
    );
    expect(rows[0]!.c).toBe('0');
  });

  it('re-renders the form with issues when the draft is invalid', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const csrf = await getNewFormCsrf(jar);

    const fields = happyQuestionFields(csrf);
    fields['part_0_mp_count'] = '0';
    // Remove the MP-0 fields so the submitted draft really has zero mark points.
    delete fields['part_0_mp_0_text'];
    delete fields['part_0_mp_0_marks'];
    delete fields['part_0_mp_0_alternatives'];

    const res = await app.inject({
      method: 'POST',
      url: '/admin/questions',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form(fields),
    });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toContain('parts.0.mark_points');
    expect(res.payload).toContain('Every part needs at least one mark point');
    // No row got created.
    const { rows } = await pool().query<{ c: string }>(
      `SELECT count(*)::text AS c FROM questions WHERE stem LIKE 'Describe the role of the control unit.%'`,
    );
    expect(rows[0]!.c).toBe('0');
  });

  it('rejects a POST without a CSRF token', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'POST',
      url: '/admin/questions',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ ...happyQuestionFields(''), _csrf: '' }),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /admin/questions/:id', () => {
  async function createOne(jar: ReturnType<typeof newJar>): Promise<string> {
    const csrf = await getNewFormCsrf(jar);
    const res = await app.inject({
      method: 'POST',
      url: '/admin/questions',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form(happyQuestionFields(csrf)),
    });
    updateJar(jar, res);
    return res.headers.location!.split('?')[0]!.split('/').pop()!;
  }

  it('updates a draft without duplicating parts', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const id = await createOne(jar);

    const editPage = await app.inject({
      method: 'GET',
      url: `/admin/questions/${id}/edit`,
      headers: { cookie: cookieHeader(jar) },
    });
    updateJar(jar, editPage);
    const csrf = extractCsrfToken(editPage.payload);

    const fields = happyQuestionFields(csrf);
    fields['stem'] = 'Describe the control unit (revised).';
    fields['part_0_mp_0_text'] = 'Fetches, decodes and executes instructions.';

    const res = await app.inject({
      method: 'POST',
      url: `/admin/questions/${id}`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form(fields),
    });
    expect(res.statusCode).toBe(302);

    const { rows } = await pool().query<{ c: string }>(
      `SELECT count(*)::text AS c FROM question_parts WHERE question_id = $1::bigint`,
      [id],
    );
    expect(Number.parseInt(rows[0]!.c, 10)).toBe(1);

    const q = await pool().query<{ stem: string }>(
      `SELECT stem FROM questions WHERE id = $1::bigint`,
      [id],
    );
    expect(q.rows[0]!.stem).toBe('Describe the control unit (revised).');
  });

  it('refuses to edit another teacher’s draft (403)', async () => {
    const alice = await createUser(pool(), { role: 'teacher' });
    const bob = await createUser(pool(), { role: 'teacher' });
    const aliceJar = await loginAs(alice);
    const id = await createOne(aliceJar);

    const bobJar = await loginAs(bob);
    const newPage = await app.inject({
      method: 'GET',
      url: '/admin/questions/new',
      headers: { cookie: cookieHeader(bobJar) },
    });
    updateJar(bobJar, newPage);
    const csrf = extractCsrfToken(newPage.payload);

    const fields = happyQuestionFields(csrf);
    fields['stem'] = 'Bob tried to rewrite Alice.';
    const res = await app.inject({
      method: 'POST',
      url: `/admin/questions/${id}`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(bobJar),
      },
      payload: form(fields),
    });
    expect(res.statusCode).toBe(403);
    const stem = await pool().query<{ stem: string }>(
      `SELECT stem FROM questions WHERE id = $1::bigint`,
      [id],
    );
    expect(stem.rows[0]!.stem).not.toContain('Bob tried');
  });
});

describe('POST /admin/questions/:id/approve', () => {
  it('flips draft → approved + active=true and audits', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const created = await createQuestion(pool(), teacher.id, {
      approvalStatus: 'draft',
      active: false,
    });

    const jar = await loginAs(teacher);
    const detailPage = await app.inject({
      method: 'GET',
      url: `/admin/questions/${created.id}`,
      headers: { cookie: cookieHeader(jar) },
    });
    updateJar(jar, detailPage);
    const csrf = extractCsrfToken(detailPage.payload);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/questions/${created.id}/approve`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload: form({ _csrf: csrf }),
    });
    expect(res.statusCode).toBe(302);

    const { rows } = await pool().query<{ status: string; active: boolean }>(
      `SELECT approval_status AS status, active FROM questions WHERE id = $1::bigint`,
      [created.id],
    );
    expect(rows[0]!.status).toBe('approved');
    expect(rows[0]!.active).toBe(true);

    const events = await pool().query<{ c: string }>(
      `SELECT count(*)::text AS c FROM audit_events WHERE event_type = 'question.approved'`,
    );
    expect(Number.parseInt(events.rows[0]!.c, 10)).toBe(1);
  });
});
