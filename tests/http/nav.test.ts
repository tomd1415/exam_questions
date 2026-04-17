import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../helpers/app.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createUser, type CreatedUser } from '../helpers/fixtures.js';
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

function extractNavLinks(payload: string): { href: string; label: string; active: boolean }[] {
  const navMatch = /<nav class="site-nav"[\s\S]*?<\/nav>/.exec(payload);
  if (!navMatch) return [];
  const nav = navMatch[0];
  const items = Array.from(
    nav.matchAll(/<li class="site-nav__item([^"]*)">\s*<a href="([^"]+)"([^>]*)>([^<]+)<\/a>/g),
  );
  return items.map((m) => ({
    href: m[2]!,
    label: m[4]!.trim(),
    active: (m[1] ?? '').includes('active') || (m[3] ?? '').includes('aria-current'),
  }));
}

describe('primary nav (Chunk 6b)', () => {
  it('unauthenticated /login does not render the primary nav', async () => {
    const res = await app.inject({ method: 'GET', url: '/login' });
    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toMatch(/<nav class="site-nav"/);
  });

  it('pupil sees pupil link set with Home/Topics/My attempts/Preferences', async () => {
    const pupil = await createUser(getSharedPool(), { role: 'pupil' });
    const jar = await loginAs(pupil);
    const res = await app.inject({
      method: 'GET',
      url: '/topics',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    const links = extractNavLinks(res.payload);
    const labels = links.map((l) => l.label);
    expect(labels).toEqual(['Home', 'Topics', 'My attempts', 'Preferences']);
    const topics = links.find((l) => l.label === 'Topics');
    expect(topics?.active).toBe(true);
  });

  it('teacher sees teacher link set with Marking queue and no Users/Audit', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/classes',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    const labels = extractNavLinks(res.payload).map((l) => l.label);
    expect(labels).toContain('Marking queue');
    expect(labels).toContain('Classes');
    expect(labels).not.toContain('Users');
    expect(labels).not.toContain('Audit log');
  });

  it('admin sees teacher links plus Users and Audit log', async () => {
    const admin = await createUser(getSharedPool(), { role: 'admin' });
    const jar = await loginAs(admin);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/classes',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    const labels = extractNavLinks(res.payload).map((l) => l.label);
    expect(labels).toContain('Users');
    expect(labels).toContain('Audit log');
  });

  it('active link on nested admin URL still highlights its root', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const jar = await loginAs(teacher);
    const pool = getSharedPool();
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO classes (name, teacher_id, academic_year)
       VALUES ('Nav active test', $1::bigint, '2025/26') RETURNING id::text`,
      [teacher.id],
    );
    const classId = rows[0]!.id;
    const res = await app.inject({
      method: 'GET',
      url: `/admin/classes/${classId}`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    const links = extractNavLinks(res.payload);
    const classes = links.find((l) => l.label === 'Classes');
    expect(classes?.active).toBe(true);
  });

  it('footer renders version and exposes /healthz to admins only', async () => {
    const teacher = await createUser(getSharedPool(), { role: 'teacher' });
    const tJar = await loginAs(teacher);
    const teacherRes = await app.inject({
      method: 'GET',
      url: '/admin/classes',
      headers: { cookie: cookieHeader(tJar) },
    });
    expect(teacherRes.payload).toMatch(/<footer class="site-footer"/);
    expect(teacherRes.payload).toMatch(/site-footer__version">v\d/);
    expect(teacherRes.payload).not.toContain('href="/healthz"');

    const admin = await createUser(getSharedPool(), { role: 'admin' });
    const aJar = await loginAs(admin);
    const adminRes = await app.inject({
      method: 'GET',
      url: '/admin/classes',
      headers: { cookie: cookieHeader(aJar) },
    });
    expect(adminRes.payload).toContain('href="/healthz"');
  });
});
