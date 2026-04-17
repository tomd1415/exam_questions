/**
 * Playwright driver for Phase 2 browser-based steps.
 *
 * Chunk 6 (Print-to-PDF) is the first scope item: headless Chromium
 * renders the teacher's topic preview paper and a pupil's submitted
 * attempt through the app's print routes, saves both to real PDFs,
 * asserts each file is >10 KB (chrome-only pages are ~5 KB) and that
 * the HTML text layer contains the rendered question stem.
 *
 * The shape mirrors scripts/phase1-browser.ts: env-driven, writes a
 * structured JSON result to $PHASE2_OUT, screenshots of failures go
 * to $PHASE2_SCREENSHOTS, PDFs to $PHASE2_PDF_DIR. Exits 0 only if
 * every step in the chosen scope passed.
 *
 * Current steps (§2.F in HUMAN_TEST_GUIDE.md):
 *   1) teacher logs in
 *   2) teacher opens /topics/<code>/print → PDF #1 (preview/blank)
 *   3) teacher opens /attempts/<id>/print?answers=1 → PDF #2 (marked)
 *   4) teacher opens /attempts/<id>/print?answers=0 → PDF #3 (blank copy)
 *
 * Steps 3 and 4 are skipped if $PHASE2_ATTEMPT_ID is not set (for a
 * pure preview-only smoke run).
 */

import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { chromium } from 'playwright';

interface StepResult {
  status: 'pass' | 'fail' | 'skip';
  notes: string;
  screenshot?: string;
  pdf?: string;
  pdfBytes?: number;
}

interface PhaseResult {
  appUrl: string;
  startedAt: string;
  endedAt: string;
  steps: Record<string, StepResult>;
}

const env = (key: string, required = true): string => {
  const v = process.env[key];
  if (!v && required) {
    console.error(`Missing required env var ${key}`);
    process.exit(64);
  }
  return v ?? '';
};

const APP_URL = env('APP_URL').replace(/\/$/, '');
const TEACHER_USER = env('PHASE2_TEACHER_USER');
const TEACHER_PW = env('PHASE2_TEACHER_PW');
const TOPIC_CODE = env('PHASE2_TOPIC_CODE');
const ATTEMPT_ID = env('PHASE2_ATTEMPT_ID', false);
const OUT_PATH = env('PHASE2_OUT');
const SCREENSHOT_DIR = env('PHASE2_SCREENSHOTS');
const PDF_DIR = env('PHASE2_PDF_DIR');

const MIN_PDF_BYTES = 10 * 1024;

const result: PhaseResult = {
  appUrl: APP_URL,
  startedAt: new Date().toISOString(),
  endedAt: '',
  steps: {},
};

const pass = (n: string, notes: string, extras: Partial<StepResult> = {}): void => {
  result.steps[n] = { status: 'pass', notes, ...extras };
  console.log(`[phase2-browser] step ${n}: PASS — ${notes}`);
};

const skip = (n: string, notes: string): void => {
  result.steps[n] = { status: 'skip', notes };
  console.log(`[phase2-browser] step ${n}: SKIP — ${notes}`);
};

const fail = async (
  n: string,
  notes: string,
  page?: Page,
  extras: Partial<StepResult> = {},
): Promise<void> => {
  let shot: string | undefined;
  if (page) {
    shot = join(SCREENSHOT_DIR, `step-${n}-fail.png`);
    try {
      await mkdir(SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: shot, fullPage: true });
    } catch (e) {
      console.error(`[phase2-browser] could not save screenshot for step ${n}: ${String(e)}`);
      shot = undefined;
    }
  }
  const entry: StepResult = { status: 'fail', notes, ...extras };
  if (shot !== undefined) entry.screenshot = shot;
  result.steps[n] = entry;
  console.error(
    `[phase2-browser] step ${n}: FAIL — ${notes}${shot ? ` (screenshot: ${shot})` : ''}`,
  );
};

async function loginAs(page: Page, username: string, password: string): Promise<number> {
  const resp = await page.goto(`${APP_URL}/login`, { waitUntil: 'domcontentloaded' });
  if (!resp?.ok()) throw new Error(`GET /login returned ${resp?.status() ?? 'no response'}`);
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', password);
  const [submitResp] = await Promise.all([
    page.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/login',
    ),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForLoadState('domcontentloaded');
  return submitResp.status();
}

async function printAndVerify(
  page: Page,
  stepId: string,
  pathOnApp: string,
  pdfName: string,
): Promise<void> {
  const url = `${APP_URL}${pathOnApp}`;
  const resp = await page.goto(url, { waitUntil: 'networkidle' });
  const status = resp?.status() ?? 0;
  if (status !== 200) {
    await fail(stepId, `GET ${pathOnApp} returned ${status}`, page);
    return;
  }
  const paperPresent = (await page.locator('section.print-paper').count()) > 0;
  if (!paperPresent) {
    await fail(stepId, `no section.print-paper rendered on ${pathOnApp}`, page);
    return;
  }
  const stem = (await page.locator('.paper-question__stem').first().textContent())?.trim() ?? '';
  if (stem.length === 0) {
    await fail(stepId, `no .paper-question__stem text found on ${pathOnApp}`, page);
    return;
  }
  const pdfPath = join(PDF_DIR, pdfName);
  await mkdir(PDF_DIR, { recursive: true });
  await page.emulateMedia({ media: 'print' });
  await page.pdf({ path: pdfPath, format: 'A4', printBackground: true });
  await page.emulateMedia({ media: 'screen' });
  const s = await stat(pdfPath);
  if (s.size < MIN_PDF_BYTES) {
    await fail(
      stepId,
      `PDF at ${pdfPath} is only ${s.size} bytes (< ${MIN_PDF_BYTES}); stem="${stem.slice(0, 40)}…"`,
      page,
      { pdf: pdfPath, pdfBytes: s.size },
    );
    return;
  }
  pass(stepId, `rendered ${pathOnApp} to PDF (${s.size} bytes); stem="${stem.slice(0, 40)}…"`, {
    pdf: pdfPath,
    pdfBytes: s.size,
  });
}

async function runPrintSteps(browser: Browser): Promise<void> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Step 1 — teacher login
  try {
    const status = await loginAs(page, TEACHER_USER, TEACHER_PW);
    if (status !== 302) {
      await fail('1', `POST /login returned ${status}, expected 302`, page);
      await ctx.close();
      return;
    }
    pass('1', `teacher ${TEACHER_USER} signed in, landed on ${page.url()}`);
  } catch (e) {
    await fail('1', `exception during login: ${String(e)}`, page);
    await ctx.close();
    return;
  }

  // Step 2 — topic preview print
  await printAndVerify(
    page,
    '2',
    `/topics/${encodeURIComponent(TOPIC_CODE)}/print`,
    `topic-${TOPIC_CODE}-preview.pdf`,
  );

  // Steps 3 & 4 — attempt print (answers=1 and answers=0). Skipped unless
  // an attempt id was provided.
  if (ATTEMPT_ID.length === 0) {
    skip('3', 'PHASE2_ATTEMPT_ID not provided; skipping attempt print (answers=1)');
    skip('4', 'PHASE2_ATTEMPT_ID not provided; skipping attempt print (answers=0)');
  } else {
    await printAndVerify(
      page,
      '3',
      `/attempts/${ATTEMPT_ID}/print?answers=1`,
      `attempt-${ATTEMPT_ID}-answers.pdf`,
    );
    await printAndVerify(
      page,
      '4',
      `/attempts/${ATTEMPT_ID}/print?answers=0`,
      `attempt-${ATTEMPT_ID}-blank.pdf`,
    );
  }

  await ctx.close();
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    await runPrintSteps(browser);
  } finally {
    await browser.close();
    result.endedAt = new Date().toISOString();
    await mkdir(dirname(OUT_PATH), { recursive: true });
    await writeFile(OUT_PATH, JSON.stringify(result, null, 2));
  }

  const failed = Object.values(result.steps).filter((s) => s.status === 'fail').length;
  process.exit(failed === 0 ? 0 : 1);
}

await main();
