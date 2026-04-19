import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../../helpers/app.js';
import { cleanDb, getSharedPool } from '../../helpers/db.js';
import { createUser, type CreatedUser } from '../../helpers/fixtures.js';
import { cookieHeader, extractCsrfToken, newJar, updateJar } from '../../helpers/cookies.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

beforeEach(async () => {
  await cleanDb();
  process.env['WIZARD_V2_ENABLED'] = '1';
});

afterEach(() => {
  delete process.env['WIZARD_V2_ENABLED'];
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

async function createDraft(jar: ReturnType<typeof newJar>): Promise<string> {
  const list = await app.inject({
    method: 'GET',
    url: '/admin/questions/wizard',
    headers: { cookie: cookieHeader(jar) },
  });
  updateJar(jar, list);
  const csrf = extractCsrfToken(list.payload);
  const create = await app.inject({
    method: 'POST',
    url: '/admin/questions/wizard/new',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
    payload: form({ _csrf: csrf }),
  });
  expect(create.statusCode).toBe(302);
  const id = /\/admin\/questions\/wizard\/(\d+)\/step\/1/.exec(create.headers.location ?? '')?.[1];
  if (!id) throw new Error('Could not extract draft id');
  return id;
}

describe('Wizard v2 steps 1-3 upgrades (Chunk 2.5r)', () => {
  it('step 1 renders the curriculum filter input with all three cascading selects', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const id = await createDraft(jar);
    const res = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${id}/step/1`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('data-wizard-curriculum');
    expect(res.payload).toContain('data-wizard-curriculum-filter');
    expect(res.payload).toContain('data-curriculum-level="component"');
    expect(res.payload).toContain('data-curriculum-level="topic"');
    expect(res.payload).toContain('data-curriculum-level="subtopic"');
  });

  it('step 1 does NOT render the filter when the flag is off', async () => {
    process.env['WIZARD_V2_ENABLED'] = '0';
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const id = await createDraft(jar);
    const res = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${id}/step/1`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain('data-wizard-curriculum-filter');
  });

  it('step 2 renders a command-word chip grid (radios wrapped in .wizard__chip)', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const id = await createDraft(jar);
    const res = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${id}/step/2`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('data-wizard-chip-grid');
    expect(res.payload).toContain('class="wizard__chip');
    expect(res.payload).toContain('name="command_word_code"');
    // Archetype remains a <select>
    expect(res.payload).toMatch(/<select name="archetype_code"/);
  });

  it('step 2 shows no chip grid when the flag is off', async () => {
    process.env['WIZARD_V2_ENABLED'] = '0';
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const id = await createDraft(jar);
    const res = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${id}/step/2`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.payload).not.toContain('data-wizard-chip-grid');
  });

  it('step 3 tiles include the widget thumbnail <img> + marking badge', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const id = await createDraft(jar);
    const res = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${id}/step/3`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    // multiple_choice is always in the registry; its thumb must render.
    expect(res.payload).toContain('/static/widget_thumbs/multiple_choice.svg');
    expect(res.payload).toContain('widget-tile__thumb');
    expect(res.payload).toContain('widget-tile__marking--deterministic');
    expect(res.payload).toContain('widget-tile__marking--teacher_pending');
  });

  it('step 3 surfaces a "Your recent widgets" section based on the author\u2019s prior drafts', async () => {
    const pool = getSharedPool();
    const teacher = await createUser(pool, { role: 'teacher' });
    const jar = await loginAs(teacher);
    // Seed a prior draft that picked "matching".
    const prior = await createDraft(jar);
    await pool.query(
      `UPDATE question_drafts
          SET payload = payload || '{"expected_response_type":"matching"}'::jsonb,
              updated_at = now()
        WHERE id = $1::bigint`,
      [prior],
    );
    // New draft; step 3 should show the "Your recent widgets" heading.
    const fresh = await createDraft(jar);
    const res = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${fresh}/step/3`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('Your recent widgets');
    expect(res.payload).toContain('/static/widget_thumbs/matching.svg');
  });

  it('step 3 omits "Your recent widgets" for a fresh author with no prior draft', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const id = await createDraft(jar);
    const res = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${id}/step/3`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.payload).not.toContain('Your recent widgets');
  });

  it('serves wizard_curriculum_filter.js and wizard_command_word_grid.js via /static/v2/', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const id = await createDraft(jar);
    const step = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${id}/step/1`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(step.payload).toContain('/static/v2/wizard_curriculum_filter.js');
    expect(step.payload).toContain('/static/v2/wizard_command_word_grid.js');

    const filterJs = await app.inject({
      method: 'GET',
      url: '/static/v2/wizard_curriculum_filter.js',
    });
    expect(filterJs.statusCode).toBe(200);
    const chipJs = await app.inject({
      method: 'GET',
      url: '/static/v2/wizard_command_word_grid.js',
    });
    expect(chipJs.statusCode).toBe(200);
  });

  it('widget thumbnail SVGs are served with a 200 for every registered type', async () => {
    for (const t of [
      'multiple_choice',
      'tick_box',
      'short_text',
      'medium_text',
      'extended_response',
      'code',
      'algorithm',
      'trace_table',
      'matrix_tick_single',
      'matrix_tick_multi',
      'cloze_free',
      'cloze_with_bank',
      'cloze_code',
      'matching',
      'logic_diagram',
      'diagram_labels',
      'flowchart',
    ]) {
      const res = await app.inject({ method: 'GET', url: `/static/widget_thumbs/${t}.svg` });
      expect(res.statusCode, `missing thumbnail for ${t}`).toBe(200);
      expect(res.headers['content-type']).toContain('svg');
    }
  });
});
