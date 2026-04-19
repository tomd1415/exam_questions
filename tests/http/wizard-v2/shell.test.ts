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

async function createDraft(
  jar: ReturnType<typeof newJar>,
  opts: {
    step?: number;
    stem?: string;
    component?: string;
    topic?: string;
    subtopic?: string;
    commandWord?: string;
    widget?: string;
    marks?: number;
  } = {},
): Promise<string> {
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
  const loc = create.headers.location ?? '';
  const match = /\/admin\/questions\/wizard\/(\d+)\/step\/1/.exec(loc);
  const id = match?.[1];
  if (!id) throw new Error('Could not extract draft id');
  const payload: Record<string, unknown> = {};
  if (opts.stem) payload['stem'] = opts.stem;
  if (opts.component) payload['component_code'] = opts.component;
  if (opts.topic) payload['topic_code'] = opts.topic;
  if (opts.subtopic) payload['subtopic_code'] = opts.subtopic;
  if (opts.commandWord) payload['command_word_code'] = opts.commandWord;
  if (opts.widget) payload['expected_response_type'] = opts.widget;
  if (typeof opts.marks === 'number') {
    payload['parts'] = [{ marks: opts.marks, expected_response_type: opts.widget ?? 'short_text' }];
  }
  if (Object.keys(payload).length > 0 || typeof opts.step === 'number') {
    const pool = getSharedPool();
    await pool.query(
      `UPDATE question_drafts
          SET current_step = $2,
              payload      = payload || $3::jsonb,
              updated_at   = now()
        WHERE id = $1::bigint`,
      [id, opts.step ?? 1, JSON.stringify(payload)],
    );
  }
  return id;
}

describe('Wizard v2 shell (Chunk 2.5p)', () => {
  it('flag off renders the v1 wizard step template', async () => {
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
    expect(res.payload).toContain('admin-wizard__progress');
    expect(res.payload).not.toContain('data-wizard-shell');
  });

  it('flag on renders the v2 3-pane shell with rail + action bar on step 1', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const id = await createDraft(jar);
    const res = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${id}/step/1`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('data-wizard-shell');
    expect(res.payload).toContain('data-wizard-rail');
    expect(res.payload).toContain('data-wizard-actions');
    expect(res.payload).toContain('data-autosave-chip');
    expect(res.payload).toContain('Wizard steps');
    expect(res.payload).toContain('Step 1 of 9');
  });

  it('rail marks visited steps as links and not-yet-started steps as disabled', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const id = await createDraft(jar, { step: 3 });
    const res = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${id}/step/3`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatch(/wizard__rail-link[^>]*aria-current="step"/);
    expect(res.payload).toContain('wizard__rail-link--disabled');
    expect(res.payload).toContain('aria-disabled="true"');
  });

  it('steps 1–4 render without a preview pane; step 5+ include one', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const id = await createDraft(jar, {
      step: 5,
      component: '1',
      topic: '1.1',
      subtopic: '1.1.1',
      commandWord: 'state',
      widget: 'short_text',
      stem: 'Define the term cache.',
    });

    const early = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${id}/step/1`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(early.statusCode).toBe(200);
    expect(early.payload).not.toContain('data-wizard-preview');
    expect(early.payload).not.toContain('wizard__shell--with-preview');

    const late = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${id}/step/5`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(late.statusCode).toBe(200);
    expect(late.payload).toContain('data-wizard-preview');
    expect(late.payload).toContain('data-wizard-preview-pane');
    expect(late.payload).toContain('wizard__shell--with-preview');
    expect(late.payload).toContain('Define the term cache.');
  });

  it('context banner renders five chips with edit links back to the owning step', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const id = await createDraft(jar, {
      step: 6,
      component: '1',
      topic: '1.1',
      subtopic: '1.1.1',
      commandWord: 'state',
      widget: 'short_text',
      marks: 2,
      stem: 'State two reasons why CPU caches improve performance.',
    });
    const res = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${id}/step/6`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('data-wizard-context');
    expect(res.payload).toContain('data-chip="topic"');
    expect(res.payload).toContain('data-chip="command"');
    expect(res.payload).toContain('data-chip="widget"');
    expect(res.payload).toContain('data-chip="marks"');
    expect(res.payload).toContain('data-chip="stem"');
    expect(res.payload).toMatch(/href="\/admin\/questions\/wizard\/\d+\/step\/1"/);
    expect(res.payload).toMatch(/href="\/admin\/questions\/wizard\/\d+\/step\/4"/);
    expect(res.payload).toContain('1 \u203a 1.1 \u203a 1.1.1');
    expect(res.payload).toContain('short_text');
    expect(res.payload).toContain('State two reasons');
  });

  it('action bar labels Back/Save with the neighbouring step titles', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const id = await createDraft(jar, { step: 3 });
    const res = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${id}/step/3`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('Back to step 2');
    expect(res.payload).toContain('What does the question ask the pupil to do?');
    expect(res.payload).toContain('Save &amp; continue');
    expect(res.payload).toContain('step 4: Write the question');
  });

  it('step 9 swaps the save button for a publish CTA', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const id = await createDraft(jar, {
      step: 9,
      component: '1',
      topic: '1.1',
      subtopic: '1.1.1',
      commandWord: 'state',
      widget: 'short_text',
      stem: 'Define the term cache.',
    });
    const res = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${id}/step/9`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('Publish question');
    expect(res.payload).toContain('wizard__publish-btn');
    expect(res.payload).toContain('Save review notes');
  });

  it('preview pane has a toggle button (for narrow viewports) on step 5+', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const id = await createDraft(jar, {
      step: 5,
      component: '1',
      topic: '1.1',
      subtopic: '1.1.1',
      commandWord: 'state',
      widget: 'short_text',
      stem: 'Define cache.',
    });
    const res = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${id}/step/5`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('data-wizard-preview-toggle');
    expect(res.payload).toContain('aria-controls="wizard-preview-pane"');
    expect(res.payload).toContain('aria-expanded="false"');
  });

  it('loads wizard_shell.js on v2 step pages only', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const id = await createDraft(jar);

    const on = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${id}/step/1`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(on.payload).toContain('/static/v2/wizard_shell.js');

    process.env['WIZARD_V2_ENABLED'] = '0';
    const off = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${id}/step/1`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(off.payload).not.toContain('/static/v2/wizard_shell.js');

    const shellJs = await app.inject({
      method: 'GET',
      url: '/static/v2/wizard_shell.js',
    });
    expect(shellJs.statusCode).toBe(200);
  });

  it('step counter carries a per-step subtitle (chunk 2.5t copy pass)', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const id = await createDraft(jar);
    const step1 = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${id}/step/1`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(step1.payload).toContain('wizard__step-subtitle');
    expect(step1.payload).toContain('Home for the question');
    const step9 = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${id}/step/9`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(step9.payload).toContain('Try it, then publish');
  });

  it('site.css ships the wizard v2 shell primitives', async () => {
    const css = await app.inject({ method: 'GET', url: '/static/site.css' });
    expect(css.statusCode).toBe(200);
    expect(css.payload).toContain('.wizard__rail');
    expect(css.payload).toContain('.wizard__actions');
    expect(css.payload).toContain('.wizard__preview');
    expect(css.payload).toContain('.wizard__context');
    expect(css.payload).toContain('.status-dot');
  });
});
