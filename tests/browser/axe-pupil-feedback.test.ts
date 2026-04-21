/// <reference lib="dom" />
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { buildApp } from '../../src/app.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createQuestion, createUser, type CreatedUser } from '../helpers/fixtures.js';

// axe-core sweep for the chunk-3e pupil review surface. The review
// page gains two new visually-distinct blocks (AI-feedback card +
// teacher-override card) with pill badges, so the dark-theme colour
// pairings need a separate check alongside light.

let app: FastifyInstance;
let baseUrl: string;
let browser: Browser;
let pupilCtx: BrowserContext;
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

async function check(ctx: BrowserContext, path: string, theme: 'light' | 'dark'): Promise<void> {
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
  const pupil = await createUser(pool, { role: 'pupil' });
  const { rows: cls } = await pool.query<{ id: string }>(
    `INSERT INTO classes (name, teacher_id, academic_year)
     VALUES ('Axe feedback class', $1::bigint, '2025/26') RETURNING id::text`,
    [teacher.id],
  );
  const classId = cls[0]!.id;
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
      {
        label: '(b)',
        prompt: 'Why is parallelism useful in graphics?',
        marks: 3,
        expectedResponseType: 'medium_text',
        markPoints: [{ text: 'GPU has many cores', marks: 1 }],
      },
    ],
  });
  const { rows: qpRows } = await pool.query<{ id: string }>(
    `SELECT id::text FROM question_parts WHERE question_id = $1::bigint ORDER BY display_order`,
    [question.id],
  );
  const { rows: aRows } = await pool.query<{ id: string }>(
    `INSERT INTO attempts (user_id, class_id, target_topic_code, mode, submitted_at)
     VALUES ($1::bigint, $2::bigint, '1.2', 'topic_set', now())
     RETURNING id::text`,
    [pupil.id, classId],
  );
  attemptId = aRows[0]!.id;
  const { rows: aqRows } = await pool.query<{ id: string }>(
    `INSERT INTO attempt_questions (attempt_id, question_id, display_order, submitted_at)
     VALUES ($1::bigint, $2::bigint, 1, now())
     RETURNING id::text`,
    [attemptId, question.id],
  );
  const { rows: apA } = await pool.query<{ id: string }>(
    `INSERT INTO attempt_parts (attempt_question_id, question_part_id, raw_answer, submitted_at)
     VALUES ($1::bigint, $2::bigint, 'CPU does things and GPU draws pixels.', now())
     RETURNING id::text`,
    [aqRows[0]!.id, qpRows[0]!.id],
  );
  const { rows: apB } = await pool.query<{ id: string }>(
    `INSERT INTO attempt_parts (attempt_question_id, question_part_id, raw_answer, submitted_at)
     VALUES ($1::bigint, $2::bigint, 'GPUs have many cores.', now())
     RETURNING id::text`,
    [aqRows[0]!.id, qpRows[1]!.id],
  );

  // Part A: LLM + accepted → AI feedback card is rendered.
  await pool.query(
    `INSERT INTO awarded_marks
       (attempt_part_id, marks_awarded, marks_total,
        mark_points_hit, mark_points_missed,
        marker, confidence, moderation_required, moderation_status,
        prompt_version, model_id, feedback_for_pupil)
     VALUES ($1::bigint, 2, 4, '{}'::bigint[], '{}'::bigint[],
             'llm', 0.82, false, 'accepted',
             'mark_open_response@axe', 'gpt-5-mini', $2::jsonb)`,
    [
      apA[0]!.id,
      JSON.stringify({
        what_went_well: 'You named both parts clearly.',
        how_to_gain_more: 'Say what each one does in short sentences.',
        next_focus: 'Practise comparing them with one example each.',
      }),
    ],
  );
  // Part B: teacher override → override card is rendered.
  const { rows: omRows } = await pool.query<{ id: string }>(
    `INSERT INTO awarded_marks
       (attempt_part_id, marks_awarded, marks_total,
        mark_points_hit, mark_points_missed, marker, moderation_status)
     VALUES ($1::bigint, 3, 3, '{}'::bigint[], '{}'::bigint[],
             'teacher_override', 'not_required')
     RETURNING id::text`,
    [apB[0]!.id],
  );
  await pool.query(
    `INSERT INTO teacher_overrides (awarded_mark_id, teacher_id, new_marks_awarded, reason)
     VALUES ($1::bigint, $2::bigint, 3, $3)`,
    [omRows[0]!.id, teacher.id, 'Full marks — the answer clearly covers the mark point.'],
  );

  browser = await chromium.launch({ headless: true });
  pupilCtx = await browser.newContext();
  const p = await pupilCtx.newPage();
  await loginVia(p, pupil);
  await p.close();
}, 90_000);

afterAll(async () => {
  await pupilCtx?.close();
  await browser?.close();
  await app?.close();
});

describe('axe-core sweep: pupil review with AI feedback (Chunk 3e)', () => {
  it('/attempts/:id in light mode has no serious violations', async () => {
    await check(pupilCtx, `/attempts/${attemptId}`, 'light');
  }, 30_000);

  it('/attempts/:id in dark mode has no serious violations', async () => {
    await check(pupilCtx, `/attempts/${attemptId}`, 'dark');
  }, 30_000);
});
