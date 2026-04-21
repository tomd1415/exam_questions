/// <reference lib="dom" />
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../../src/app.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createUser, type CreatedUser } from '../helpers/fixtures.js';

// Chunk 3g axe sweep. The cost dashboard adds a band accent, a new
// `pill--danger` variant, and a numeric table. All of these need to
// stay WCAG AA in both themes — red is the tightest because the dark
// theme uses translucent fills against the card surface.

let app: FastifyInstance;
let baseUrl: string;
let browser: Browser;
let adminCtx: BrowserContext;

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
  await pool.query(`DELETE FROM llm_calls`);
  await pool.query(`DELETE FROM prompt_versions WHERE name LIKE 'axe_dash_%'`);
  const { rows: promptRows } = await pool.query<{ id: string }>(
    `INSERT INTO prompt_versions (name, version, model_id, system_prompt, output_schema, status)
     VALUES ('axe_dash_open', $1, 'gpt-5-mini', 'test', '{}'::jsonb, 'draft')
     RETURNING id::text`,
    [`v0.1.0-axe-${randomBytes(3).toString('hex')}`],
  );
  const promptId = promptRows[0]!.id;

  // One row in each card's window plus one big row to push one card into
  // the red band, so the a11y sweep exercises both pill variants.
  const now = new Date();
  const hour = 60 * 60 * 1000;
  await pool.query(
    `INSERT INTO llm_calls
       (prompt_version_id, attempt_part_id, model_id, input_tokens, output_tokens,
        cost_pence, latency_ms, status, error_message, created_at)
     VALUES ($1::bigint, NULL, 'gpt-5-mini', 200, 80, 50, 40, 'ok', NULL, $2),
            ($1::bigint, NULL, 'gpt-5-mini', 200, 80, 5000, 40, 'ok', NULL, $3)`,
    [promptId, new Date(now.getTime() - 2 * hour), new Date(now.getTime() - 1 * hour)],
  );

  const admin = await createUser(pool, { role: 'admin' });
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

describe('axe-core sweep: admin LLM cost dashboard (Chunk 3g)', () => {
  it('/admin/llm/costs in light mode has no serious violations', async () => {
    await check(adminCtx, '/admin/llm/costs', 'light');
  }, 30_000);

  it('/admin/llm/costs in dark mode has no serious violations', async () => {
    await check(adminCtx, '/admin/llm/costs', 'dark');
  }, 30_000);
});
