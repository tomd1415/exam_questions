/// <reference lib="dom" />
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { buildApp } from '../../src/app.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createQuestion, createUser, type CreatedUser } from '../helpers/fixtures.js';

// axe-core sweep for the chunk-3d admin surfaces:
//   /admin/moderation                   (queue with one flagged row)
//   /admin/moderation/:awardedMarkId    (detail + accept/override forms)
//   /admin/content-guards               (pattern CRUD with one seeded row)
// Each is scanned in both light and dark themes because the dark
// styles for pill--warn/reason-list/pupil-answer-box live in site.css.

let app: FastifyInstance;
let baseUrl: string;
let browser: Browser;
let adminCtx: BrowserContext;
let awardedMarkId: string;

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

async function check(ctx: BrowserContext, path: string): Promise<void> {
  const p = await ctx.newPage();
  try {
    const resp = await p.goto(`${baseUrl}${path}`);
    if (resp?.status() !== 200) {
      throw new Error(`expected 200 on ${path}, got ${resp?.status() ?? 'no-response'}`);
    }
    await axeOn(p, path);
  } finally {
    await p.close();
  }
}

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

beforeAll(async () => {
  await cleanDb();
  app = await buildApp({ pool: getSharedPool(), logger: false });
  await app.ready();
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = typeof address === 'string' ? address : `http://127.0.0.1:${String(address)}`;

  const pool = getSharedPool();
  const teacher = await createUser(pool, { role: 'teacher' });
  const pupil = await createUser(pool, { role: 'pupil', displayName: 'Pupil Under Axe' });
  const admin = await createUser(pool, { role: 'admin' });

  const cls = await pool.query<{ id: string }>(
    `INSERT INTO classes (name, teacher_id, academic_year)
     VALUES ('Axe moderation class', $1::bigint, '2025/26')
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
    modelAnswer: 'The CPU executes instructions; the GPU renders pixels.',
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
  const aq = await pool.query<{ id: string }>(
    `INSERT INTO attempt_questions (attempt_id, question_id, display_order)
     VALUES ($1::bigint, $2::bigint, 1)
     RETURNING id::text`,
    [attempt.rows[0]!.id, question.id],
  );
  const qp = await pool.query<{ id: string; marks: number }>(
    `SELECT id::text, marks FROM question_parts WHERE question_id = $1::bigint ORDER BY display_order`,
    [question.id],
  );
  const ap = await pool.query<{ id: string }>(
    `INSERT INTO attempt_parts (attempt_question_id, question_part_id, raw_answer)
     VALUES ($1::bigint, $2::bigint, 'CPU runs things and GPU draws pixels.')
     RETURNING id::text`,
    [aq.rows[0]!.id, qp.rows[0]!.id],
  );
  const mps = await pool.query<{ id: string }>(
    `SELECT id::text FROM mark_points WHERE question_part_id = $1::bigint ORDER BY display_order`,
    [qp.rows[0]!.id],
  );

  const notes = JSON.stringify([
    { kind: 'low_confidence', confidence: 0.3, threshold: 0.6 },
    {
      kind: 'evidence_not_in_answer',
      quote: 'pixels on the screen',
    },
  ]);
  const am = await pool.query<{ id: string }>(
    `INSERT INTO awarded_marks
       (attempt_part_id, marks_awarded, marks_total,
        mark_points_hit, mark_points_missed, evidence_quotes,
        marker, confidence, moderation_required, moderation_status,
        moderation_notes, prompt_version, model_id)
     VALUES ($1::bigint, 2, $2, $3::bigint[], $4::bigint[], $5::text[],
             'llm', 0.30, true, 'pending',
             $6::jsonb, 'mark_open_response@v0.1.0-axe', 'gpt-5-mini')
     RETURNING id::text`,
    [
      ap.rows[0]!.id,
      qp.rows[0]!.marks,
      [mps.rows[0]!.id],
      [mps.rows[1]!.id],
      ['CPU runs things'],
      notes,
    ],
  );
  awardedMarkId = am.rows[0]!.id;

  await pool.query(
    `INSERT INTO content_guard_patterns (kind, pattern, note, created_by)
     VALUES ('safeguarding', 'sample safeguarding pattern', 'axe seed', $1::bigint)`,
    [admin.id],
  );

  browser = await chromium.launch({ headless: true });
  adminCtx = await browser.newContext();
  const p = await adminCtx.newPage();
  await loginVia(p, admin);
  await p.close();
}, 90_000);

afterAll(async () => {
  await adminCtx?.close();
  await browser?.close();
  await app?.close();
});

describe('axe-core sweep: moderation admin surfaces (Chunk 3d)', () => {
  it('/admin/moderation has no serious violations', async () => {
    await check(adminCtx, '/admin/moderation');
  }, 30_000);

  it('/admin/moderation in dark mode has no serious violations', async () => {
    await checkWithTheme(adminCtx, '/admin/moderation', 'dark');
  }, 30_000);

  it('/admin/moderation/:id has no serious violations', async () => {
    await check(adminCtx, `/admin/moderation/${awardedMarkId}`);
  }, 30_000);

  it('/admin/moderation/:id in dark mode has no serious violations', async () => {
    await checkWithTheme(adminCtx, `/admin/moderation/${awardedMarkId}`, 'dark');
  }, 30_000);

  it('/admin/content-guards has no serious violations', async () => {
    await check(adminCtx, '/admin/content-guards');
  }, 30_000);

  it('/admin/content-guards in dark mode has no serious violations', async () => {
    await checkWithTheme(adminCtx, '/admin/content-guards', 'dark');
  }, 30_000);
});
