/**
 * Playwright driver for Phase 0 browser-based steps.
 *
 * Invoked by scripts/human-test-phase0.sh. Reads everything via env vars
 * (so the bash walker stays the source of truth for credentials, paths
 * and report timestamps) and writes a structured JSON result to
 * $PHASE0_OUT. Screenshots for failed steps land in $PHASE0_SCREENSHOTS.
 *
 * Two phases:
 *   PHASE0_PHASE=primary       runs steps 4-9 (login, view, submit, pupil)
 *                              and saves teacher storage state to $PHASE0_STORAGE
 *   PHASE0_PHASE=post-reboot   runs step 16 (reload teacher storage, refresh)
 *
 * Exits 0 if every step in the chosen phase passed, 1 otherwise.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';

interface StepResult {
  status: 'pass' | 'fail' | 'skip';
  notes: string;
  screenshot?: string;
}

interface PhaseResult {
  phase: 'primary' | 'post-reboot';
  appUrl: string;
  startedAt: string;
  endedAt: string;
  steps: Record<string, StepResult>;
  teacherAttemptId?: string;
  pupilAttemptId?: string;
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
const TEACHER_USER = env('HTG_TEACHER_USER');
const TEACHER_PW = env('HTG_TEACHER_PW');
const PUPIL_USER = env('HTG_PUPIL_USER');
const PUPIL_PW = env('HTG_PUPIL_PW');
const OUT_PATH = env('PHASE0_OUT');
const SCREENSHOT_DIR = env('PHASE0_SCREENSHOTS');
const STORAGE_PATH = env('PHASE0_STORAGE');
const PHASE = env('PHASE0_PHASE') as 'primary' | 'post-reboot';

const TEACHER_ANSWER = 'It performs arithmetic and logical operations on data.';
const PUPIL_ANSWER = 'The ALU does the maths and the logic for the CPU.';

const result: PhaseResult = {
  phase: PHASE,
  appUrl: APP_URL,
  startedAt: new Date().toISOString(),
  endedAt: '',
  steps: {},
};

const pass = (n: string, notes: string): void => {
  result.steps[n] = { status: 'pass', notes };
  console.log(`[phase0-browser] step ${n}: PASS — ${notes}`);
};

const fail = async (n: string, notes: string, page?: Page): Promise<void> => {
  let shot: string | undefined;
  if (page) {
    shot = join(SCREENSHOT_DIR, `step-${n}-fail.png`);
    try {
      await mkdir(SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: shot, fullPage: true });
    } catch (e) {
      console.error(`[phase0-browser] could not save screenshot for step ${n}: ${String(e)}`);
      shot = undefined;
    }
  }
  const entry: StepResult = { status: 'fail', notes };
  if (shot !== undefined) entry.screenshot = shot;
  result.steps[n] = entry;
  console.error(
    `[phase0-browser] step ${n}: FAIL — ${notes}${shot ? ` (screenshot: ${shot})` : ''}`,
  );
};

async function loginAs(
  page: Page,
  username: string,
  password: string,
): Promise<{ status: number; url: string }> {
  const resp = await page.goto(`${APP_URL}/login`, { waitUntil: 'domcontentloaded' });
  if (!resp?.ok()) {
    throw new Error(`GET /login returned ${resp?.status() ?? 'no response'}`);
  }
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', password);
  // Submit and wait for the navigation that follows (302 → /).
  const [submitResp] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/login')),
    page.click('button[type="submit"]'),
  ]);
  // Then settle on whatever the redirect chain ends at.
  await page.waitForLoadState('domcontentloaded');
  return { status: submitResp.status(), url: page.url() };
}

async function runPrimary(browser: Browser): Promise<void> {
  // -----------------------------------------------------------------------
  // Step 4 — bad password produces the flash + stays on /login
  // -----------------------------------------------------------------------
  const teacherCtx = await browser.newContext();
  const teacher = await teacherCtx.newPage();
  try {
    await teacher.goto(`${APP_URL}/login`, { waitUntil: 'domcontentloaded' });
    await teacher.fill('input[name="username"]', TEACHER_USER);
    await teacher.fill('input[name="password"]', 'definitely-not-the-password');
    await Promise.all([
      teacher.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/login')),
      teacher.click('button[type="submit"]'),
    ]);
    await teacher.waitForLoadState('domcontentloaded');
    const flashText =
      (await teacher.locator('.flash, .flash--err, [class*="flash"]').first().textContent()) ?? '';
    if (!teacher.url().endsWith('/login')) {
      await fail(
        '4',
        `expected to remain on /login after bad password; got ${teacher.url()}`,
        teacher,
      );
    } else if (!flashText.includes('Username or password is incorrect')) {
      await fail('4', `flash text unexpected: ${JSON.stringify(flashText)}`, teacher);
    } else {
      pass('4', `flash read "${flashText.trim()}"`);
    }
  } catch (e) {
    await fail('4', `exception: ${String(e)}`, teacher);
  }

  // -----------------------------------------------------------------------
  // Step 5 — correct password → / → /q/1 (auth root redirect)
  // -----------------------------------------------------------------------
  try {
    const { status, url } = await loginAs(teacher, TEACHER_USER, TEACHER_PW);
    if (status !== 302) {
      await fail('5', `POST /login returned ${status}, expected 302`, teacher);
    } else if (!url.endsWith('/q/1')) {
      await fail('5', `landed on ${url}, expected /q/1`, teacher);
    } else {
      const title = await teacher.title();
      if (!title.includes('Question 1')) {
        await fail('5', `page title was "${title}", expected to contain "Question 1"`, teacher);
      } else {
        pass('5', `redirected to /q/1, title "${title}"`);
      }
    }
  } catch (e) {
    await fail('5', `exception: ${String(e)}`, teacher);
  }

  // -----------------------------------------------------------------------
  // Step 6 — question card content
  // -----------------------------------------------------------------------
  try {
    const badges = await teacher.locator('.question-card__meta .badge').allTextContents();
    const stem = (await teacher.locator('.question-card__stem').textContent()) ?? '';
    const partLabel = (await teacher.locator('.question-part__label').first().textContent()) ?? '';
    const partPrompt =
      (await teacher.locator('.question-part__prompt').first().textContent()) ?? '';
    const partMarks = (await teacher.locator('.question-part__marks').first().textContent()) ?? '';
    const expectedBadges = ['Question 1', '1.1 · 1.1.1', 'describe', '2 marks'];
    const badgeMisses = expectedBadges.filter((e) => !badges.some((b) => b.trim() === e));
    const errs: string[] = [];
    if (badgeMisses.length)
      errs.push(`badges missing: ${JSON.stringify(badgeMisses)} (got ${JSON.stringify(badges)})`);
    if (!stem.includes('Arithmetic Logic Unit'))
      errs.push(`stem does not mention "Arithmetic Logic Unit": ${JSON.stringify(stem)}`);
    if (!partLabel.includes('(a)')) errs.push(`part label "${partLabel}" missing "(a)"`);
    if (!partPrompt.toLowerCase().includes('describe'))
      errs.push(`part prompt "${partPrompt}" missing "describe"`);
    if (!partMarks.includes('2')) errs.push(`part marks "${partMarks}" missing "2"`);
    if (errs.length) {
      await fail('6', errs.join('; '), teacher);
    } else {
      pass('6', `badges ${JSON.stringify(badges.map((b) => b.trim()))}, stem ok, part ok`);
    }
  } catch (e) {
    await fail('6', `exception: ${String(e)}`, teacher);
  }

  // -----------------------------------------------------------------------
  // Step 7 — teacher submits an answer
  // -----------------------------------------------------------------------
  try {
    await teacher.locator('form.question-form textarea').first().fill(TEACHER_ANSWER);
    await Promise.all([
      teacher.waitForURL(/\/q\/1\?saved=\d+/),
      teacher.locator('form.question-form button[type="submit"]').click(),
    ]);
    const u = new URL(teacher.url());
    const savedId = u.searchParams.get('saved') ?? '';
    if (!/^\d+$/.test(savedId)) {
      await fail('7', `expected ?saved=<int>, got "${savedId}"`, teacher);
    } else {
      result.teacherAttemptId = savedId;
      const flashText = (await teacher.locator('.flash--ok').first().textContent()) ?? '';
      const taValue = await teacher.locator('form.question-form textarea').first().inputValue();
      const errs: string[] = [];
      if (!flashText.includes(`attempt #${savedId}`))
        errs.push(`flash "${flashText.trim()}" missing "attempt #${savedId}"`);
      if (taValue !== '') errs.push(`textarea was not cleared after submit: "${taValue}"`);
      if (errs.length) {
        await fail('7', errs.join('; '), teacher);
      } else {
        pass('7', `redirected to ?saved=${savedId}, flash ok, textarea cleared`);
      }
    }
  } catch (e) {
    await fail('7', `exception: ${String(e)}`, teacher);
  }

  // Save teacher storage state for the post-reboot phase (step 16).
  try {
    await mkdir(dirname(STORAGE_PATH), { recursive: true });
    await teacherCtx.storageState({ path: STORAGE_PATH });
  } catch (e) {
    console.error(`[phase0-browser] failed to save storage state: ${String(e)}`);
  }

  // -----------------------------------------------------------------------
  // Step 8 — pupil context, fresh cookies, sees form NOT teacher's answer
  // -----------------------------------------------------------------------
  const pupilCtx = await browser.newContext();
  const pupil = await pupilCtx.newPage();
  try {
    const { status, url } = await loginAs(pupil, PUPIL_USER, PUPIL_PW);
    if (status !== 302 || !url.endsWith('/q/1')) {
      await fail('8', `pupil login: status ${status}, url ${url}`, pupil);
    } else {
      const taValue = await pupil.locator('form.question-form textarea').first().inputValue();
      const bodyText = (await pupil.locator('body').textContent()) ?? '';
      const errs: string[] = [];
      if (taValue !== '') errs.push(`pupil textarea is not empty: "${taValue}"`);
      if (bodyText.includes(TEACHER_ANSWER)) {
        errs.push(`pupil page leaked the teacher's submitted answer text!`);
      }
      // Sanity: header should show the pupil's display name, not the teacher's.
      const headerText = (await pupil.locator('.site-header').textContent()) ?? '';
      if (headerText.includes('HTG Teacher')) {
        errs.push(`pupil page header shows teacher's display name`);
      }
      if (errs.length) {
        await fail('8', errs.join('; '), pupil);
      } else {
        pass('8', `pupil on /q/1 with empty textarea; no teacher answer leaked`);
      }
    }
  } catch (e) {
    await fail('8', `exception: ${String(e)}`, pupil);
  }

  // -----------------------------------------------------------------------
  // Step 9 — pupil submits a different answer
  // -----------------------------------------------------------------------
  try {
    await pupil.locator('form.question-form textarea').first().fill(PUPIL_ANSWER);
    await Promise.all([
      pupil.waitForURL(/\/q\/1\?saved=\d+/),
      pupil.locator('form.question-form button[type="submit"]').click(),
    ]);
    const u = new URL(pupil.url());
    const savedId = u.searchParams.get('saved') ?? '';
    if (!/^\d+$/.test(savedId)) {
      await fail('9', `expected ?saved=<int>, got "${savedId}"`, pupil);
    } else if (savedId === result.teacherAttemptId) {
      await fail(
        '9',
        `pupil's attempt id ${savedId} is the same as teacher's — attribution leak?`,
        pupil,
      );
    } else {
      result.pupilAttemptId = savedId;
      pass(
        '9',
        `pupil submitted, new attempt id ${savedId} (teacher's was ${result.teacherAttemptId ?? '?'})`,
      );
    }
  } catch (e) {
    await fail('9', `exception: ${String(e)}`, pupil);
  }

  await pupilCtx.close();
  await teacherCtx.close();
}

async function runPostReboot(browser: Browser): Promise<void> {
  // -----------------------------------------------------------------------
  // Step 16 — reload teacher storage state, /q/1 is either OK or → /login
  // -----------------------------------------------------------------------
  let ctx: BrowserContext;
  try {
    ctx = await browser.newContext({ storageState: STORAGE_PATH });
  } catch (e) {
    await fail('16', `could not load saved storage state from ${STORAGE_PATH}: ${String(e)}`);
    return;
  }
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(`${APP_URL}/q/1`, { waitUntil: 'domcontentloaded' });
    const status = resp?.status() ?? 0;
    const finalUrl = page.url();
    const onQuestion = finalUrl.endsWith('/q/1');
    const onLogin = finalUrl.endsWith('/login');
    if (status === 200 && onQuestion) {
      pass('16', `session survived: GET /q/1 returned 200`);
    } else if (onLogin) {
      pass('16', `session lost (cookie cleared): /q/1 → /login (also acceptable)`);
    } else {
      await fail('16', `unexpected: status ${status}, final url ${finalUrl}`, page);
    }
  } catch (e) {
    await fail('16', `exception: ${String(e)}`, page);
  } finally {
    await ctx.close();
  }
}

async function main(): Promise<void> {
  if (PHASE !== 'primary' && PHASE !== 'post-reboot') {
    console.error(`PHASE0_PHASE must be 'primary' or 'post-reboot', got "${String(PHASE)}"`);
    process.exit(64);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    if (PHASE === 'primary') {
      await runPrimary(browser);
    } else {
      await runPostReboot(browser);
    }
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
