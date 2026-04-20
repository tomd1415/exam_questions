/// <reference lib="dom" />
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { buildApp } from '../../src/app.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createQuestion, createUser, type CreatedUser } from '../helpers/fixtures.js';

// Axe sweep scoped to the drawing-toolbar buttons (logic_diagram widget)
// under both the default (light) theme and [data-theme='dark']. Issue 5
// in POST_TEST_FIXES_PLAN — pen/eraser/clear were hard to read against
// the canvas surface. A theme-parameterised test locks the contrast fix
// so future CSS tweaks can't quietly regress either mode.

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
  const results = await new AxeBuilder({ page: p }).include('.widget--logic-diagram').analyze();
  const bad = results.violations.filter((v) => SERIOUS_IMPACTS.includes(v.impact ?? ''));
  if (bad.length > 0) {
    const detail = bad
      .map(
        (v) =>
          `  • [${v.impact}] ${v.id} — ${v.help}\n    ${v.nodes
            .slice(0, 3)
            .map(
              (n) =>
                `${n.target.join(' ')}\n      ${(n.failureSummary ?? '').split('\n').join(' / ')}`,
            )
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
     VALUES ('Draw axe class', $1::bigint, '2025/26') RETURNING id::text`,
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
    expectedResponseType: 'logic_diagram',
    parts: [
      {
        label: '(a)',
        prompt: 'Draw an AND gate.',
        marks: 2,
        expectedResponseType: 'logic_diagram',
        partConfig: { variant: 'freehand', width: 480, height: 320 },
        markPoints: [{ text: 'AND gate drawn', marks: 2 }],
      },
    ],
  });

  browser = await chromium.launch({ headless: true });
  pupilCtx = await browser.newContext();

  const startResult = await app.services.attempts.startTopicSet(
    { id: pupil.id, role: 'pupil' },
    '1.1',
    'whole_attempt',
  );
  attemptId = String(startResult.attemptId);

  const pPage = await pupilCtx.newPage();
  await loginVia(pPage, pupil);
  await pPage.close();
}, 90_000);

afterAll(async () => {
  await pupilCtx?.close();
  await browser?.close();
  await app?.close();
});

async function checkTheme(theme: 'light' | 'dark'): Promise<void> {
  const p = await pupilCtx.newPage();
  try {
    const resp = await p.goto(`${baseUrl}/attempts/${attemptId}`);
    if (resp?.status() !== 200) {
      throw new Error(`expected 200, got ${resp?.status() ?? 'no-response'}`);
    }
    await p.evaluate((t) => {
      document.documentElement.setAttribute('data-theme', t);
    }, theme);
    await p.waitForSelector('.widget--logic-diagram');
    await axeOn(p, `logic_diagram widget (${theme})`);
  } finally {
    await p.close();
  }
}

describe('axe-core pass over the drawing toolbar (Chunk A2)', () => {
  it('logic_diagram toolbar passes in light mode', async () => {
    await checkTheme('light');
  }, 30_000);

  it('logic_diagram toolbar passes in dark mode', async () => {
    await checkTheme('dark');
  }, 30_000);
});
