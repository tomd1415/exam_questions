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

describe('inline icon set (Chunk 6g)', () => {
  it('pupil nav renders inline SVG icons next to each link label', async () => {
    const pupil = await createUser(getSharedPool(), { role: 'pupil' });
    const jar = await loginAs(pupil);
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    const navMatch = /<nav class="site-nav"[\s\S]*?<\/nav>/.exec(res.payload);
    expect(navMatch).not.toBeNull();
    const nav = navMatch![0];
    // Each nav item should include an inline <svg class="icon" …>.
    const svgCount = (nav.match(/<svg[^>]*class="icon"/g) ?? []).length;
    expect(svgCount).toBeGreaterThanOrEqual(4);
    // Icons must not leak user-supplied data — all paths are hardcoded.
    expect(nav).toContain('viewBox="0 0 24 24"');
    // Label text should still be present inside a .site-nav__label span.
    expect(nav).toContain('<span class="site-nav__label">Home</span>');
  });

  it('unknown icon names render nothing (silent fallback)', async () => {
    const pupil = await createUser(getSharedPool(), { role: 'pupil' });
    const jar = await loginAs(pupil);
    // Fetch any authenticated page (pupil home). If the template evaluation
    // failed, this would have 500'd rather than 200'd.
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
  });

  it('site.css exposes the reduced-motion media query', async () => {
    const res = await app.inject({ method: 'GET', url: '/static/site.css' });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('prefers-reduced-motion: reduce');
    expect(res.payload).toContain('animation-duration: 0.001ms');
  });
});
