import { afterAll, beforeAll, describe, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { buildApp } from '../../src/app.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createUser, type CreatedUser } from '../helpers/fixtures.js';

// axe-core sweep over the v2 wizard surface: drafts list + 9 step pages.
// The flag is read at call time by src/routes/admin-question-wizard.ts, so
// setting WIZARD_V2_ENABLED=1 before the tests fire routes every request
// through the v2 templates without rebuilding the app.

let app: FastifyInstance;
let baseUrl: string;
let browser: Browser;
let teacherCtx: BrowserContext;
let draftId: string;
let teacherId: string;

// Flip the teacher's theme_preference at the DB level rather than using
// page.evaluate(setAttribute). Server-side `_chrome.eta` reads the value
// at render-time, so the first byte of HTML already carries
// `<html data-theme="dark">`. That guarantees every CSS custom-property
// override resolves on the initial cascade — no flash of light styles, no
// ambiguity about whether the attribute landed before axe scanned.
async function setTheme(theme: 'light' | 'dark'): Promise<void> {
  await getSharedPool().query(
    `UPDATE users SET theme_preference = $1 WHERE id = $2::bigint`,
    [theme, teacherId],
  );
}

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
  // Exclude the pupil-preview pane: its widgets are rendered by the shared
  // `_paper_part_widget.eta` dispatcher which is tested elsewhere against
  // pupil-facing pages. The preview is a render-preview, not a form surface
  // the teacher submits, so per-widget label coverage belongs to the pupil
  // flow's own axe pass.
  const results = await new AxeBuilder({ page: p })
    .exclude('[data-wizard-preview]')
    .exclude('[data-wizard-preview-pane]')
    .analyze();
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
  process.env['WIZARD_V2_ENABLED'] = '1';
  await cleanDb();
  app = await buildApp({ pool: getSharedPool(), logger: false });
  await app.ready();
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = typeof address === 'string' ? address : `http://127.0.0.1:${String(address)}`;

  const pool = getSharedPool();
  const teacher = await createUser(pool, { role: 'teacher' });
  teacherId = teacher.id;

  // Seed a draft whose payload contains every field the nine step templates
  // render. This lets axe hit all nine steps on a realistic DOM (context
  // banner, preview pane, mark-point list, difficulty slider, publish form)
  // instead of the skeletal "nothing filled in yet" variant.
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO question_drafts (author_user_id, current_step, payload)
     VALUES ($1::bigint, 9, $2::jsonb)
     RETURNING id::text`,
    [
      teacher.id,
      JSON.stringify({
        component_code: '01',
        topic_code: '1.1',
        subtopic_code: '1.1.1',
        command_word_code: 'state',
        archetype_code: 'knowledge_recall',
        expected_response_type: 'short_text',
        stem: 'What does CPU stand for?',
        difficulty_band: 3,
        difficulty_step: 2,
        source_type: 'teacher',
        parts: [
          {
            label: '(a)',
            prompt: 'What does CPU stand for?',
            marks: 1,
            expected_response_type: 'short_text',
            mark_points: [{ text: 'Central Processing Unit', marks: 1 }],
          },
        ],
      }),
    ],
  );
  draftId = rows[0]!.id;

  browser = await chromium.launch({ headless: true });
  teacherCtx = await browser.newContext();
  const tPage = await teacherCtx.newPage();
  await loginVia(tPage, teacher);
  await tPage.close();
}, 90_000);

afterAll(async () => {
  await teacherCtx?.close();
  await browser?.close();
  await app?.close();
  delete process.env['WIZARD_V2_ENABLED'];
});

async function check(path: string, theme: 'light' | 'dark' = 'light'): Promise<void> {
  await setTheme(theme);
  const p = await teacherCtx.newPage();
  try {
    const resp = await p.goto(`${baseUrl}${path}`);
    if (resp?.status() !== 200) {
      const body = await p.content();
      throw new Error(
        `expected 200 on ${path}, got ${resp?.status() ?? 'no-response'}. body head: ${body.slice(0, 300)}`,
      );
    }
    await axeOn(p, `${path} (${theme})`);
  } finally {
    await p.close();
  }
}

describe('axe-core pass over the wizard v2 surface (Chunk 2.5t)', () => {
  it('/admin/questions/wizard (drafts list) has no serious violations', async () => {
    await check('/admin/questions/wizard');
  }, 30_000);

  for (let n = 1; n <= 9; n++) {
    it(`/admin/questions/wizard/:id/step/${n} has no serious violations`, async () => {
      await check(`/admin/questions/wizard/${draftId}/step/${n}`);
    }, 30_000);
  }
});

// Dark-mode parallel pass (Chunk A4). Re-uses the seeded draft but flips
// <html data-theme="dark"> before the axe scan so any contrast regression
// in the dark variant fails CI alongside the light one.
describe('axe-core pass over the wizard v2 surface in dark mode (Chunk A4)', () => {
  it('/admin/questions/wizard (drafts list, dark) has no serious violations', async () => {
    await check('/admin/questions/wizard', 'dark');
  }, 30_000);

  for (let n = 1; n <= 9; n++) {
    it(`/admin/questions/wizard/:id/step/${n} (dark) has no serious violations`, async () => {
      await check(`/admin/questions/wizard/${draftId}/step/${n}`, 'dark');
    }, 30_000);
  }
});
