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
  opts: { step?: number; stem?: string; topic?: string; widget?: string } = {},
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
  if (opts.stem || opts.topic || opts.widget || opts.step) {
    const pool = getSharedPool();
    const payload: Record<string, unknown> = {};
    if (opts.stem) payload['stem'] = opts.stem;
    if (opts.topic) {
      payload['component_code'] = '1';
      payload['topic_code'] = opts.topic;
    }
    if (opts.widget) payload['expected_response_type'] = opts.widget;
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

describe('Wizard v2 drafts list (Chunk 2.5o)', () => {
  it('flag off renders the v1 drafts list', async () => {
    process.env['WIZARD_V2_ENABLED'] = '0';
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/questions/wizard',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('My question drafts');
    expect(res.payload).not.toContain('v2-drafts');
    expect(res.payload).not.toContain('data-drafts-root');
  });

  it('flag on renders the v2 drafts list with hero CTA and tab switcher', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/questions/wizard',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('Your question drafts');
    expect(res.payload).toContain('data-drafts-root');
    expect(res.payload).toContain('Start a new question');
    expect(res.payload).toContain('<kbd class="kbd kbd--on-accent">N</kbd>');
    expect(res.payload).toContain('v2-tabs__tab');
    expect(res.payload).toContain('In progress');
    expect(res.payload).toContain('Recently published');
    expect(res.payload).toContain('All drafts');
  });

  it('renders empty state with a first-question CTA when there are no drafts', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/questions/wizard',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('data-drafts-empty');
    expect(res.payload).toContain('No drafts yet');
    expect(res.payload).toContain('Start your first question');
  });

  it('renders a draft card with progress ring, staleness chip, and widget chip', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    await createDraft(jar, {
      step: 4,
      stem: 'State two reasons why caches improve CPU performance.',
      topic: '1.1',
      widget: 'short_text',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/admin/questions/wizard',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('v2-draft-card');
    expect(res.payload).toContain('State two reasons why caches');
    expect(res.payload).toContain('progress-ring');
    expect(res.payload).toContain('4/9');
    expect(res.payload).toContain('data-widget="short_text"');
    expect(res.payload).toContain('just now');
  });

  it('filter query narrows the visible cards server-side', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    await createDraft(jar, { stem: 'Define the term cache.', widget: 'short_text' });
    await createDraft(jar, {
      stem: 'Describe the fetch-execute cycle.',
      widget: 'extended_response',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/admin/questions/wizard?q=cache',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('Define the term cache');
    expect(res.payload).not.toContain('fetch-execute cycle');
  });

  it('widget chip filter narrows the visible cards', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    await createDraft(jar, { stem: 'Short-text question', widget: 'short_text' });
    await createDraft(jar, { stem: 'Multiple-choice question', widget: 'multiple_choice' });
    const res = await app.inject({
      method: 'GET',
      url: '/admin/questions/wizard?widget=short_text',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('Short-text question');
    expect(res.payload).not.toContain('Multiple-choice question');
  });

  it('tab switcher URL is the shareable filter state', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    await createDraft(jar, { stem: 'A draft', widget: 'short_text' });
    const res = await app.inject({
      method: 'GET',
      url: '/admin/questions/wizard?tab=published',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    // With no published drafts, the "published" tab should render the
    // "no drafts yet" empty state (not the unfiltered draft list).
    expect(res.payload).toContain('data-drafts-empty');
    expect(res.payload).not.toContain('A draft');
    expect(res.payload).toMatch(/aria-current="page"[^>]*>\s*Recently published/);
  });

  it('loads drafts_filter.js and drafts_shortcuts.js on the v2 drafts page', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/questions/wizard',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.payload).toContain('/static/v2/drafts_filter.js');
    expect(res.payload).toContain('/static/v2/drafts_shortcuts.js');

    const filterJs = await app.inject({
      method: 'GET',
      url: '/static/v2/drafts_filter.js',
    });
    expect(filterJs.statusCode).toBe(200);
    const shortcutsJs = await app.inject({
      method: 'GET',
      url: '/static/v2/drafts_shortcuts.js',
    });
    expect(shortcutsJs.statusCode).toBe(200);
  });

  it('drafts list css primitives are served by the flag-off chrome too', async () => {
    // The new chip-toggle/v2-drafts CSS lives in site.css so it's available
    // on every page. Confirm the class names are present so later chunks
    // can rely on them.
    const css = await app.inject({ method: 'GET', url: '/static/site.css' });
    expect(css.statusCode).toBe(200);
    expect(css.payload).toContain('.v2-drafts');
    expect(css.payload).toContain('.v2-draft-card');
    expect(css.payload).toContain('.chip--toggle');
  });

  it('staleness chip reflects age buckets (fresh/aging/stale)', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const freshId = await createDraft(jar, { stem: 'Fresh draft', widget: 'short_text' });
    const agingId = await createDraft(jar, { stem: 'Aging draft', widget: 'short_text' });
    const staleId = await createDraft(jar, { stem: 'Stale draft', widget: 'short_text' });
    const pool = getSharedPool();
    await pool.query(
      `UPDATE question_drafts SET updated_at = now() - interval '3 days' WHERE id = $1::bigint`,
      [agingId],
    );
    await pool.query(
      `UPDATE question_drafts SET updated_at = now() - interval '14 days' WHERE id = $1::bigint`,
      [staleId],
    );
    const res = await app.inject({
      method: 'GET',
      url: '/admin/questions/wizard',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatch(
      /Fresh draft[\s\S]*?data-stale="fresh"|data-stale="fresh"[\s\S]*?Fresh draft/,
    );
    expect(res.payload).toContain('data-stale="aging"');
    expect(res.payload).toContain('data-stale="stale"');
    expect(res.payload).toContain('2 weeks ago');
    // Unused variable keeps TS happy while explicitly binding fresh.
    void freshId;
  });
});
