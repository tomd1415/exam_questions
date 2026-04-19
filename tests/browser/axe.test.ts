import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { buildApp } from '../../src/app.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createQuestion, createUser, type CreatedUser } from '../helpers/fixtures.js';

// One shared Fastify instance listening on a real TCP port so Playwright
// (which requires an HTTP origin) can drive the app end-to-end. Separate
// browser contexts isolate pupil vs teacher sessions; axe-core runs with
// default rules and the suite fails if any serious/critical violation is
// found on any of the seven core pages.

let app: FastifyInstance;
let baseUrl: string;
let browser: Browser;
let pupilCtx: BrowserContext;
let teacherCtx: BrowserContext;
let anonCtx: BrowserContext;
let attemptId: string;

const SERIOUS_IMPACTS: readonly string[] = ['serious', 'critical'];

async function loginVia(p: Page, user: CreatedUser): Promise<void> {
  await p.goto(`${baseUrl}/login`);
  await p.fill('input[name="username"]', user.username);
  await p.fill('input[name="password"]', user.password);
  await Promise.all([
    p.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/login',
    ),
    p.click('button[type="submit"]'),
  ]);
  await p.waitForLoadState('domcontentloaded');
}

async function axeOn(p: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page: p }).analyze();
  const bad = results.violations.filter((v) => SERIOUS_IMPACTS.includes(v.impact ?? ''));
  if (bad.length > 0) {
    const detail = bad
      .map(
        (v) =>
          `  • [${v.impact}] ${v.id} — ${v.help}\n    ${v.nodes
            .slice(0, 3)
            .map((n) => n.target.join(' '))
            .join('\n    ')}`,
      )
      .join('\n');
    throw new Error(`axe-core found serious/critical violations on ${label}:\n${detail}`);
  }
}

beforeAll(async () => {
  await cleanDb();
  app = await buildApp({ pool: getSharedPool(), logger: false });
  await app.ready();
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = typeof address === 'string' ? address : `http://127.0.0.1:${String(address)}`;

  const pool = getSharedPool();
  const teacher = await createUser(pool, { role: 'teacher' });
  const pupil = await createUser(pool, { role: 'pupil' });
  const cls = await pool.query<{ id: string }>(
    `INSERT INTO classes (name, teacher_id, academic_year)
     VALUES ('Axe class', $1::bigint, '2025/26') RETURNING id::text`,
    [teacher.id],
  );
  const classId = cls.rows[0]!.id;
  await pool.query(`INSERT INTO enrolments (class_id, user_id) VALUES ($1::bigint, $2::bigint)`, [
    classId,
    pupil.id,
  ]);
  await pool.query(
    `INSERT INTO class_assigned_topics (class_id, topic_code, assigned_by)
     VALUES ($1::bigint, '1.1', $2::bigint)`,
    [classId, teacher.id],
  );
  await createQuestion(pool, teacher.id, {
    topicCode: '1.1',
    subtopicCode: '1.1.1',
    active: true,
    approvalStatus: 'approved',
    parts: [
      {
        label: '(a)',
        prompt: 'What does CPU stand for?',
        marks: 1,
        expectedResponseType: 'multiple_choice',
        markPoints: [
          { text: 'Central Processing Unit', marks: 1 },
          { text: 'Computer Programming Unit', marks: 0 },
        ],
      },
    ],
  });

  browser = await chromium.launch({ headless: true });
  anonCtx = await browser.newContext();
  pupilCtx = await browser.newContext();
  teacherCtx = await browser.newContext();

  // Use AttemptService directly to start + fully submit an attempt. This
  // keeps the browser setup focused on auth + rendering, not on business
  // flow quirks like per-question vs whole-attempt submission.
  const startResult = await app.services.attempts.startTopicSet(
    { id: pupil.id, role: 'pupil' },
    '1.1',
    'whole_attempt',
  );
  attemptId = String(startResult.attemptId);
  await pool.query(
    `UPDATE attempts SET submitted_at = now() WHERE id = $1::bigint AND submitted_at IS NULL`,
    [attemptId],
  );
  await pool.query(
    `UPDATE attempt_questions SET submitted_at = now()
      WHERE attempt_id = $1::bigint AND submitted_at IS NULL`,
    [attemptId],
  );

  const pPage = await pupilCtx.newPage();
  await loginVia(pPage, pupil);
  await pPage.close();

  const tPage = await teacherCtx.newPage();
  await loginVia(tPage, teacher);
  await tPage.close();
}, 90_000);

afterAll(async () => {
  await anonCtx?.close();
  await pupilCtx?.close();
  await teacherCtx?.close();
  await browser?.close();
  await app?.close();
});

async function check(ctx: BrowserContext, path: string): Promise<void> {
  const p = await ctx.newPage();
  try {
    const resp = await p.goto(`${baseUrl}${path}`);
    if (resp?.status() !== 200) {
      const body = await p.content();
      throw new Error(
        `expected 200 on ${path}, got ${resp?.status() ?? 'no-response'}. body head: ${body.slice(0, 300)}`,
      );
    }
    await axeOn(p, path);
  } finally {
    await p.close();
  }
}

// Variant of `check` that forces a theme on <html> before scanning, so
// Chunk A3's contrast fix for login + form inputs is locked in for both
// light and dark modes.
async function checkWithTheme(
  ctx: BrowserContext,
  path: string,
  theme: 'light' | 'dark',
): Promise<void> {
  const p = await ctx.newPage();
  try {
    const resp = await p.goto(`${baseUrl}${path}`);
    if (resp?.status() !== 200) {
      throw new Error(`expected 200 on ${path}, got ${resp?.status() ?? 'no-response'}`);
    }
    await p.evaluate((t) => {
      document.documentElement.setAttribute('data-theme', t);
    }, theme);
    await axeOn(p, `${path} (${theme})`);
  } finally {
    await p.close();
  }
}

describe('axe-core pass (Chunk 7)', () => {
  it('/login has no serious violations', async () => {
    await check(anonCtx, '/login');
  }, 30_000);

  it('/topics (pupil) has no serious violations', async () => {
    await check(pupilCtx, '/topics');
  }, 30_000);

  it('/attempts/:id (submitted review) has no serious violations', async () => {
    await check(pupilCtx, `/attempts/${attemptId}`);
  }, 30_000);

  it('/admin/classes (teacher) has no serious violations', async () => {
    await check(teacherCtx, '/admin/classes');
  }, 30_000);

  it('/admin/questions (teacher) has no serious violations', async () => {
    await check(teacherCtx, '/admin/questions');
  }, 30_000);

  it('/admin/attempts/:id (teacher) has no serious violations', async () => {
    await check(teacherCtx, `/admin/attempts/${attemptId}`);
  }, 30_000);

  it('/ (teacher home dashboard) has no serious violations', async () => {
    await check(teacherCtx, '/');
  }, 30_000);

  it('/login in light mode has no serious violations', async () => {
    await checkWithTheme(anonCtx, '/login', 'light');
  }, 30_000);

  it('/login in dark mode has no serious violations', async () => {
    await checkWithTheme(anonCtx, '/login', 'dark');
  }, 30_000);

  it('/attempts/:id (pupil review) in dark mode has no serious violations', async () => {
    await checkWithTheme(pupilCtx, `/attempts/${attemptId}`, 'dark');
  }, 30_000);

  // Dark-theme variants of the core admin and pupil surfaces. These catch
  // regressions where bare <input>/<select>/<textarea>, ink-4 body text, or
  // other low-contrast treatments leak into dark mode.
  it('/topics (pupil) in dark mode has no serious violations', async () => {
    await checkWithTheme(pupilCtx, '/topics', 'dark');
  }, 30_000);

  it('/admin/classes (teacher) in dark mode has no serious violations', async () => {
    await checkWithTheme(teacherCtx, '/admin/classes', 'dark');
  }, 30_000);

  it('/admin/questions (teacher) in dark mode has no serious violations', async () => {
    await checkWithTheme(teacherCtx, '/admin/questions', 'dark');
  }, 30_000);

  it('/admin/attempts/:id (teacher) in dark mode has no serious violations', async () => {
    await checkWithTheme(teacherCtx, `/admin/attempts/${attemptId}`, 'dark');
  }, 30_000);

  it('/ (teacher home) in dark mode has no serious violations', async () => {
    await checkWithTheme(teacherCtx, '/', 'dark');
  }, 30_000);

  it('suite attemptId is defined', () => {
    expect(attemptId).toMatch(/^\d+$/);
  });
});
