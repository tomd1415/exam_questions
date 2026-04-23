/// <reference lib="dom" />
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { buildApp } from '../../src/app.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createUser, type CreatedUser } from '../helpers/fixtures.js';
import { buildReport, writeReport } from '../../src/services/eval/report.js';
import type { FixtureResult, PromptAggregate } from '../../src/services/eval/scoring.js';

// Chunk 3h axe sweep. The eval dashboard shares the band-accent pattern
// with the cost card plus a new offender list. Red and green aggregate
// cards must both be present so both pill variants are exercised in
// light and dark themes.

let app: FastifyInstance;
let baseUrl: string;
let browser: Browser;
let adminCtx: BrowserContext;
let outDir: string;
const ORIG_OUT_DIR = process.env['EVAL_OUT_DIR'];

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

async function check(ctx: BrowserContext, urlPath: string, theme: 'light' | 'dark'): Promise<void> {
  const p = await ctx.newPage();
  try {
    const resp = await p.goto(`${baseUrl}${urlPath}`);
    if (resp?.status() !== 200) {
      throw new Error(`expected 200 on ${urlPath}, got ${resp?.status() ?? 'no-response'}`);
    }
    await p.evaluate((t) => {
      document.documentElement.setAttribute('data-theme', t);
    }, theme);
    await axeOn(p, `${urlPath} (${theme})`);
  } finally {
    await p.close();
  }
}

function result(overrides: Partial<FixtureResult> = {}): FixtureResult {
  return {
    fixtureId: 'open_pass',
    description: 'all marks',
    promptName: 'mark_open_response',
    promptVersion: 'v0.1.0',
    outcomeKind: 'awarded',
    marksAwarded: 2,
    expectedRange: [2, 2],
    absoluteError: 0,
    hitIds: ['mp_1', 'mp_2'],
    missedIds: [],
    missingRequiredHits: [],
    unexpectedHits: [],
    refused: false,
    refusalExpected: false,
    passed: true,
    failReasons: [],
    latencyMs: 200,
    costPence: 4,
    ...overrides,
  };
}

function greenAggregate(): PromptAggregate {
  return {
    promptName: 'mark_open_response',
    promptVersion: 'v0.1.0',
    fixtures: 2,
    passed: 2,
    failed: 0,
    passRate: 1,
    meanAbsoluteError: 0,
    totalCostPence: 8,
    meanLatencyMs: 200,
    worstOffenders: [],
  };
}

function redAggregate(): PromptAggregate {
  const fail = result({
    fixtureId: 'code_fail',
    promptName: 'mark_code_response',
    passed: false,
    marksAwarded: 0,
    absoluteError: 2,
    failReasons: ['marks 0 outside expected range [2, 2]'],
  });
  return {
    promptName: 'mark_code_response',
    promptVersion: 'v0.1.0',
    fixtures: 2,
    passed: 1,
    failed: 1,
    passRate: 0.5,
    meanAbsoluteError: 1,
    totalCostPence: 10,
    meanLatencyMs: 300,
    worstOffenders: [fail],
  };
}

beforeAll(async () => {
  await cleanDb();
  outDir = mkdtempSync(path.join(tmpdir(), 'axe-evals-'));
  process.env['EVAL_OUT_DIR'] = outDir;

  const report = buildReport(
    [greenAggregate(), redAggregate()],
    [
      result(),
      result({ fixtureId: 'open_pass_2' }),
      result({
        fixtureId: 'code_fail',
        promptName: 'mark_code_response',
        passed: false,
        marksAwarded: 0,
        absoluteError: 2,
        failReasons: ['marks 0 outside expected range [2, 2]'],
      }),
    ],
    new Date(),
  );
  await writeReport(outDir, report);

  app = await buildApp({ pool: getSharedPool(), logger: false });
  await app.ready();
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = typeof address === 'string' ? address : `http://127.0.0.1:${String(address)}`;

  const admin = await createUser(getSharedPool(), { role: 'admin' });
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
  rmSync(outDir, { recursive: true, force: true });
  if (ORIG_OUT_DIR === undefined) delete process.env['EVAL_OUT_DIR'];
  else process.env['EVAL_OUT_DIR'] = ORIG_OUT_DIR;
});

describe('axe-core sweep: admin prompt eval dashboard (Chunk 3h)', () => {
  it('/admin/evals/latest in light mode has no serious violations', async () => {
    await check(adminCtx, '/admin/evals/latest', 'light');
  }, 30_000);

  it('/admin/evals/latest in dark mode has no serious violations', async () => {
    await check(adminCtx, '/admin/evals/latest', 'dark');
  }, 30_000);
});
