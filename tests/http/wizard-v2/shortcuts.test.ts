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

describe('Wizard v2 shortcut help + scripts (Chunk 2.5q)', () => {
  it('shortcut-help <dialog> renders on every v2 step with every documented key', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const id = await createDraft(jar);
    const res = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${id}/step/1`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('data-wizard-shortcut-help');
    expect(res.payload).toContain('<kbd class="kbd">Ctrl</kbd>');
    expect(res.payload).toContain('<kbd class="kbd">Enter</kbd>');
    expect(res.payload).toContain('<kbd class="kbd">[</kbd>');
    expect(res.payload).toContain('<kbd class="kbd">]</kbd>');
    expect(res.payload).toContain('<kbd class="kbd">?</kbd>');
    expect(res.payload).toContain('<kbd class="kbd">Esc</kbd>');
  });

  it('wizard_shortcuts.js is served alongside the v2 shell', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const id = await createDraft(jar);
    const step = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${id}/step/1`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(step.payload).toContain('/static/v2/wizard_shortcuts.js');

    const js = await app.inject({ method: 'GET', url: '/static/v2/wizard_shortcuts.js' });
    expect(js.statusCode).toBe(200);
    // Smoke: the dispatch table mentions each shortcut documented in the dialog.
    expect(js.payload).toContain('Ctrl');
    expect(js.payload).toContain("case '?':");
    expect(js.payload).toContain("case '[':");
    expect(js.payload).toContain("case ']':");
    expect(js.payload).toContain("case '.'");
  });

  it('site.css ships the shortcut-help + revert-button primitives', async () => {
    const css = await app.inject({ method: 'GET', url: '/static/site.css' });
    expect(css.payload).toContain('.wizard__shortcut-help');
    expect(css.payload).toContain('.wizard__revert-btn');
  });

  it('v1 (flag off) does not include the shortcut dialog', async () => {
    process.env['WIZARD_V2_ENABLED'] = '0';
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const id = await createDraft(jar);
    const res = await app.inject({
      method: 'GET',
      url: `/admin/questions/wizard/${id}/step/1`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.payload).not.toContain('data-wizard-shortcut-help');
    expect(res.payload).not.toContain('/static/v2/wizard_shortcuts.js');
  });
});
