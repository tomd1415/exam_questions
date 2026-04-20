/**
 * Playwright driver for Phase 2 browser-based steps.
 *
 * Invoked by scripts/human-test-phase2.sh. Reads everything via env vars
 * (so the bash walker stays the source of truth for credentials and
 * report paths) and writes a structured JSON result to $PHASE2_OUT.
 * Screenshots for failed steps land in $PHASE2_SCREENSHOTS, generated
 * print PDFs in $PHASE2_PDF_DIR.
 *
 * Covers Chunk 8's "automate everything but the final paper-feel verdict"
 * scope:
 *
 *   3) teacher setup (login, class create/reuse, enrol, assign topic)
 *   4) teacher sets a class countdown timer
 *   5) pupil logs in and sees the assigned topic
 *   6) pupil starts attempt → paper-layout chrome assertions
 *   7) countdown timer pill is rendered with the right data attributes
 *   8) autosave round-trip: fill, blur, observe POST 200, reopen, restored
 *   9) pupil fully submits the attempt → review page
 *  10) /topics/:code/print renders to a non-trivial PDF
 *  11) /attempts/:id/print?answers=1 renders to a non-trivial PDF
 *  12) /attempts/:id/print?answers=0 renders to a non-trivial PDF
 *  13–19) axe-core runs over 7 core pages and fails on any
 *         serious/critical violation
 *
 * Step numbering matches HUMAN_TEST_GUIDE.md §Phase 2 walker (Chunk 8).
 *
 * Exits 0 if every step in the chosen scope passed, 1 otherwise.
 */

import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

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
  classId?: string;
  attemptId?: string;
  firstPartId?: string;
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
const PUPIL_USER = env('PHASE2_PUPIL_USER');
const PUPIL_PW = env('PHASE2_PUPIL_PW');
const CLASS_NAME = env('PHASE2_CLASS_NAME');
const ACADEMIC_YEAR = env('PHASE2_ACADEMIC_YEAR');
const TOPIC_CODE = env('PHASE2_TOPIC_CODE');
const TIMER_MINUTES = env('PHASE2_TIMER_MINUTES', false) || '30';
const OUT_PATH = env('PHASE2_OUT');
const SCREENSHOT_DIR = env('PHASE2_SCREENSHOTS');
const PDF_DIR = env('PHASE2_PDF_DIR');

const AUTOSAVE_PROBE = 'Walker autosave probe — survives a fresh context.';
const FINAL_FILLER = 'Phase 2 walker auto-filler answer.';
const MIN_PDF_BYTES = 10 * 1024;
const SERIOUS_IMPACTS: ReadonlySet<string> = new Set(['serious', 'critical']);

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

async function submitAndWait(
  page: Page,
  clickSelector: string,
  opts: { urlPattern?: RegExp } = {},
): Promise<void> {
  const navPromise = opts.urlPattern
    ? page.waitForURL(opts.urlPattern, { waitUntil: 'domcontentloaded', timeout: 15000 })
    : page.waitForLoadState('domcontentloaded', { timeout: 15000 });
  await Promise.all([navPromise, page.click(clickSelector)]);
}

// ---------------------------------------------------------------------------
// Step 3 — teacher setup: login, class, enrol, assign topic.
// Mirrors phase1-browser.ts steps 4-7 in a single browser step.
// ---------------------------------------------------------------------------
async function runTeacherSetup(browser: Browser): Promise<BrowserContext | null> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    const status = await loginAs(page, TEACHER_USER, TEACHER_PW);
    if (status !== 302) {
      await fail('3', `teacher login: POST /login returned ${status}`, page);
      return ctx;
    }
    // Create or reuse the class.
    await page.goto(`${APP_URL}/admin/classes/new`, { waitUntil: 'domcontentloaded' });
    await page.fill('input[name="name"]', CLASS_NAME);
    await page.fill('input[name="academic_year"]', ACADEMIC_YEAR);
    try {
      await submitAndWait(page, 'form.admin-form button[type="submit"]', {
        urlPattern: /\/admin\/classes(\/\d+)?$/,
      });
    } catch {
      /* duplicate ⇒ stays on /admin/classes/new with an error flash */
    }
    let onDetail = /\/admin\/classes\/\d+$/.test(page.url());
    if (!onDetail) {
      await page.goto(`${APP_URL}/admin/classes`, { waitUntil: 'domcontentloaded' });
      const row = page.locator('table.admin-table tbody tr').filter({ hasText: CLASS_NAME });
      if (await row.count()) {
        await Promise.all([
          page.waitForURL(/\/admin\/classes\/\d+$/, {
            waitUntil: 'domcontentloaded',
            timeout: 15000,
          }),
          row.first().locator('a', { hasText: 'Open' }).click(),
        ]);
        onDetail = /\/admin\/classes\/\d+$/.test(page.url());
      }
    }
    if (!onDetail) {
      await fail('3', `could not reach a class detail page; url=${page.url()}`, page);
      return ctx;
    }
    const idMatch = /\/admin\/classes\/(\d+)$/.exec(page.url());
    if (idMatch?.[1]) result.classId = idMatch[1];

    // Enrol the pupil (idempotent).
    await page.fill('input[name="pupil_username"]', PUPIL_USER);
    await submitAndWait(page, 'form[action$="/enrol"] button[type="submit"]');

    // Assign the topic (idempotent — if already assigned the option is gone).
    const assignSelect = page.locator('select[name="topic_code"]');
    if ((await assignSelect.count()) > 0) {
      const hasOpt = await assignSelect.locator(`option[value="${TOPIC_CODE}"]`).count();
      if (hasOpt > 0) {
        await assignSelect.selectOption(TOPIC_CODE);
        await submitAndWait(page, 'form[action$="/topics"] button[type="submit"]');
      }
    }
    const enrolled = await page.locator('td', { hasText: PUPIL_USER }).count();
    const assigned = await page.locator('td', { hasText: TOPIC_CODE }).count();
    if (!enrolled || !assigned) {
      await fail(
        '3',
        `setup incomplete: enrolled=${enrolled}, assigned=${assigned} (class id=${result.classId ?? '?'})`,
        page,
      );
    } else {
      pass('3', `class ${result.classId} ready: pupil enrolled, topic ${TOPIC_CODE} assigned`);
    }
  } catch (e) {
    await fail('3', `exception: ${String(e)}`, page);
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Step 4 — teacher sets the class countdown timer. Issues a class.timer_set
// audit row that the bash walker cross-checks.
// ---------------------------------------------------------------------------
async function runTimerSet(browser: Browser): Promise<void> {
  if (!result.classId) {
    await fail('4', 'no classId from step 3 — cannot set timer');
    return;
  }
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    const status = await loginAs(page, TEACHER_USER, TEACHER_PW);
    if (status !== 302) {
      await fail('4', `teacher login: POST /login returned ${status}`, page);
      await ctx.close();
      return;
    }
    await page.goto(`${APP_URL}/admin/classes/${result.classId}`, {
      waitUntil: 'domcontentloaded',
    });
    const timerInput = page.locator('input[name="timer_minutes"]');
    if (!(await timerInput.count())) {
      await fail('4', 'no input[name="timer_minutes"] on the class detail page', page);
      await ctx.close();
      return;
    }
    await timerInput.fill(TIMER_MINUTES);
    await submitAndWait(
      page,
      `form[action="/admin/classes/${result.classId}/timer"] button[type="submit"]`,
    );
    const flash = (await page.locator('.flash--ok, .flash').first().textContent()) ?? '';
    if (!new RegExp(`set to ${TIMER_MINUTES} minutes`).test(flash)) {
      await fail('4', `unexpected timer flash: "${flash.trim()}"`, page);
    } else {
      pass('4', `timer set to ${TIMER_MINUTES} min; flash="${flash.trim()}"`);
    }
  } catch (e) {
    await fail('4', `exception: ${String(e)}`, page);
  }
  await ctx.close();
}

// ---------------------------------------------------------------------------
// Steps 5-9 — pupil flow on a single context: login, see topic, start
// attempt + paper-layout assertions, timer-pill assertions, autosave round-
// trip across a fresh context, then full submission.
// ---------------------------------------------------------------------------
async function runPupilFlow(browser: Browser): Promise<void> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    // Step 5 — pupil login + /topics.
    const status = await loginAs(page, PUPIL_USER, PUPIL_PW);
    if (status !== 302) {
      await fail('5', `pupil login: POST /login returned ${status}`, page);
      await ctx.close();
      return;
    }
    await page.goto(`${APP_URL}/topics`, { waitUntil: 'domcontentloaded' });
    if (!(await page.locator('td', { hasText: TOPIC_CODE }).count())) {
      await fail('5', `topic ${TOPIC_CODE} not listed for pupil`, page);
      await ctx.close();
      return;
    }
    pass('5', `pupil signed in; /topics shows ${TOPIC_CODE}`);

    // Step 6 — start the topic set; assert paper-layout chrome.
    const startFormSel = `form[action="/topics/${encodeURIComponent(TOPIC_CODE)}/start"] button[type="submit"]`;
    const topicRow = page
      .locator('table.admin-table tbody tr')
      .filter({ hasText: TOPIC_CODE })
      .first();
    const resumeLink = topicRow.locator('a', { hasText: 'Resume attempt' });
    const hasStart = (await page.locator(startFormSel).count()) > 0;
    const hasResume = (await resumeLink.count()) > 0;
    if (!hasStart && !hasResume) {
      await fail('6', `no start form and no resume link for topic ${TOPIC_CODE}`, page);
      await ctx.close();
      return;
    }
    if (hasStart) {
      await submitAndWait(page, startFormSel, { urlPattern: /\/attempts\/\d+/ });
    } else {
      await Promise.all([
        page.waitForURL(/\/attempts\/\d+/, { waitUntil: 'domcontentloaded', timeout: 15000 }),
        resumeLink.click(),
      ]);
    }
    const m = /\/attempts\/(\d+)(?:\?|$)/.exec(page.url());
    if (!m?.[1]) {
      await fail('6', `did not land on /attempts/<id>; url=${page.url()}`, page);
      await ctx.close();
      return;
    }
    result.attemptId = m[1];

    const paperRoot = await page.locator('section.paper-root').count();
    const qNum = await page.locator('.paper-question__number').first().textContent();
    const totalChip = await page.locator('.paper-question__total-marks').first().textContent();
    if (!paperRoot) {
      await fail('6', 'no section.paper-root rendered on /attempts/<id>', page);
    } else if (!qNum?.match(/^Q\d+\.$/)) {
      await fail('6', `paper-question__number unexpected: "${qNum?.trim() ?? ''}"`, page);
    } else if (!totalChip?.match(/\[\s*\d+\s*marks?\s*\]/)) {
      await fail('6', `paper-question__total-marks unexpected: "${totalChip?.trim() ?? ''}"`, page);
    } else {
      pass(
        '6',
        `paper layout present: ${qNum.trim()} ${totalChip.trim()} on attempt ${result.attemptId}`,
      );
    }

    // Step 7 — timer pill on the same page.
    const timerEl = page.locator('#paper-timer');
    if (!(await timerEl.count())) {
      await fail('7', 'no #paper-timer pill rendered (timer should be set by step 4)', page);
    } else {
      const minutes = await timerEl.getAttribute('data-timer-minutes');
      const startedAt = await timerEl.getAttribute('data-timer-started-at');
      if (minutes !== TIMER_MINUTES) {
        await fail('7', `data-timer-minutes="${minutes}" did not match ${TIMER_MINUTES}`, page);
      } else if (!startedAt || !/\d{4}-\d{2}-\d{2}T/.test(startedAt)) {
        await fail('7', `data-timer-started-at="${startedAt ?? ''}" not ISO-shaped`, page);
      } else {
        pass('7', `timer pill: minutes=${minutes}, startedAt=${startedAt}`);
      }
    }

    // Step 8 — autosave round-trip on the first textarea-shaped widget.
    // Phase 2.5 widget types (trace_table_grid, matrix_tick, cloze, logic
    // diagram, flowchart, diagram labels, matching) do not surface their
    // raw_answer as a single DOM value the walker can fill + re-read, so
    // walk forward through the attempt's questions via the "Next →" link
    // until a <textarea>-shaped question is found. If none of the topic's
    // questions render as plain text, skip step 8 rather than failing —
    // the autosave path itself is still covered by widget-specific tests.
    const MAX_NAV = 20;
    let usableTa = page.locator('form.question-form textarea').first();
    let probeUrl: string | null = null;
    let probeQuestionNo: string | null = null;
    for (let i = 0; i < MAX_NAV; i++) {
      if (await usableTa.count()) {
        probeUrl = page.url();
        probeQuestionNo =
          (await page.locator('.paper-question__number').first().textContent())?.trim() ?? null;
        break;
      }
      const nextLink = page.locator('nav.paper-nav a', { hasText: 'Next' }).first();
      if (!(await nextLink.count())) break;
      await Promise.all([
        page.waitForURL(/\/attempts\/\d+\?q=\d+/, {
          waitUntil: 'domcontentloaded',
          timeout: 15000,
        }),
        nextLink.click(),
      ]);
      usableTa = page.locator('form.question-form textarea').first();
    }
    let ctxForSubmit: BrowserContext = ctx;
    let pageForSubmit: Page = page;
    if (!(await usableTa.count())) {
      skip(
        '8',
        `no <textarea>-shaped question found in topic ${TOPIC_CODE} after walking ${MAX_NAV} questions; autosave round-trip requires a plain-text widget`,
      );
    } else {
      const partIdAttr =
        (await usableTa.getAttribute('data-autosave-part-id')) ??
        ((await usableTa.getAttribute('name')) ?? '').replace(/^part_/, '');
      if (/^\d+$/.test(partIdAttr)) result.firstPartId = partIdAttr;
      try {
        await usableTa.fill(AUTOSAVE_PROBE);
        const [autosaveResp] = await Promise.all([
          page.waitForResponse(
            (r) =>
              r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/autosave'),
            { timeout: 10000 },
          ),
          usableTa.blur(),
        ]);
        if (autosaveResp.status() !== 200) {
          await fail('8', `autosave POST returned ${autosaveResp.status()}`, page);
        } else {
          // Round-trip across a fresh context — re-open the same question URL
          // because /attempts/<id> defaults to the first question, which may
          // not be the one we probed.
          await ctx.close();
          const ctx2 = await browser.newContext();
          const page2 = await ctx2.newPage();
          const s2 = await loginAs(page2, PUPIL_USER, PUPIL_PW);
          if (s2 !== 302) {
            await fail('8', `re-login returned ${s2}`, page2);
            await ctx2.close();
            return;
          }
          await page2.goto(probeUrl ?? `${APP_URL}/attempts/${result.attemptId}`, {
            waitUntil: 'domcontentloaded',
          });
          const restored = await page2.locator('form.question-form textarea').first().inputValue();
          if (restored !== AUTOSAVE_PROBE) {
            await fail(
              '8',
              `${probeQuestionNo ?? 'first'} textarea did not restore autosave probe; got ${JSON.stringify(restored)}`,
              page2,
            );
            await ctx2.close();
            return;
          }
          pass(
            '8',
            `autosave POST 200 on ${probeQuestionNo ?? 'first text question'}, raw_answer survived a fresh context+login`,
          );
          ctxForSubmit = ctx2;
          pageForSubmit = page2;
        }
      } catch (e) {
        await fail('8', `exception: ${String(e)}`, page);
      }
    }
    await runPupilSubmit(browser, ctxForSubmit, pageForSubmit);
    return;
  } catch (e) {
    await fail('5', `exception: ${String(e)}`, page);
  }
  await ctx.close();
}

// ---------------------------------------------------------------------------
// Step 9 — submit the attempt fully (per_question loop) so print steps 10-12
// have a submitted attempt and the review page exists for axe.
// Reuses the post-autosave context to avoid yet another login.
// ---------------------------------------------------------------------------
async function runPupilSubmit(_browser: Browser, ctx: BrowserContext, page: Page): Promise<void> {
  try {
    const MAX_QUESTIONS = 30;
    let submittedQuestions = 0;
    let onReview = false;
    for (let i = 0; i < MAX_QUESTIONS; i++) {
      if (i > 0) {
        await page.goto(`${APP_URL}/attempts/${result.attemptId}`, {
          waitUntil: 'domcontentloaded',
        });
      }
      if ((await page.locator('form.question-form').count()) === 0) {
        onReview = (await page.locator('h1', { hasText: '· review' }).count()) > 0;
        break;
      }
      const tas = page.locator('form.question-form textarea');
      const n = await tas.count();
      for (let j = 0; j < n; j++) {
        const existing = await tas.nth(j).inputValue();
        if (existing.length === 0) {
          await tas.nth(j).fill(`${FINAL_FILLER} (#Q${i + 1}-P${j + 1})`);
        }
      }
      // Also make sure radio-groups have something selected so per-question
      // submit does not bounce us.
      const radioGroups = page.locator('fieldset.widget--mc');
      const rgCount = await radioGroups.count();
      for (let j = 0; j < rgCount; j++) {
        const first = radioGroups.nth(j).locator('input[type="radio"]').first();
        if ((await first.count()) && !(await first.isChecked())) {
          await first.check({ force: true });
        }
      }
      await submitAndWait(page, 'form.question-form button[type="submit"]:not([formaction])');
      submittedQuestions += 1;
      const flash = (await page.locator('.flash--ok').first().textContent()) ?? '';
      if (flash.includes('All questions submitted')) break;
    }
    if (!onReview) {
      await page.goto(`${APP_URL}/attempts/${result.attemptId}`, {
        waitUntil: 'domcontentloaded',
      });
      onReview = (await page.locator('h1', { hasText: '· review' }).count()) > 0;
    }
    if (!onReview) {
      await fail(
        '9',
        `no "· review" header on /attempts/${result.attemptId} after ${submittedQuestions} submits`,
        page,
      );
    } else {
      pass('9', `submitted ${submittedQuestions} question(s); landed on review`);
    }
  } catch (e) {
    await fail('9', `exception: ${String(e)}`, page);
  }
  await ctx.close();
}

// ---------------------------------------------------------------------------
// Steps 10-12 — print routes render to non-trivial PDFs.
// ---------------------------------------------------------------------------
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
  if (!(await page.locator('section.print-paper').count())) {
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
    await fail(stepId, `PDF at ${pdfPath} is only ${s.size} bytes (< ${MIN_PDF_BYTES})`, page, {
      pdf: pdfPath,
      pdfBytes: s.size,
    });
    return;
  }
  pass(stepId, `${pathOnApp} → ${pdfName} (${s.size} bytes); stem="${stem.slice(0, 40)}…"`, {
    pdf: pdfPath,
    pdfBytes: s.size,
  });
}

async function runPrintSteps(browser: Browser): Promise<void> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    const status = await loginAs(page, TEACHER_USER, TEACHER_PW);
    if (status !== 302) {
      await fail('10', `teacher login (print): ${status}`, page);
      await fail('11', 'skipped — teacher login failed', page);
      await fail('12', 'skipped — teacher login failed', page);
      await ctx.close();
      return;
    }
    await printAndVerify(
      page,
      '10',
      `/topics/${encodeURIComponent(TOPIC_CODE)}/print`,
      `topic-${TOPIC_CODE}-preview.pdf`,
    );
    if (!result.attemptId) {
      skip('11', 'no attemptId — pupil flow did not produce one');
      skip('12', 'no attemptId — pupil flow did not produce one');
    } else {
      await printAndVerify(
        page,
        '11',
        `/attempts/${result.attemptId}/print?answers=1`,
        `attempt-${result.attemptId}-answers.pdf`,
      );
      await printAndVerify(
        page,
        '12',
        `/attempts/${result.attemptId}/print?answers=0`,
        `attempt-${result.attemptId}-blank.pdf`,
      );
    }
  } catch (e) {
    await fail('10', `exception during print steps: ${String(e)}`, page);
  }
  await ctx.close();
}

// ---------------------------------------------------------------------------
// Steps 13-19 — axe-core run over seven core pages.
// One context per role; fail on any serious/critical violation.
// ---------------------------------------------------------------------------
async function runAxeStep(
  ctx: BrowserContext,
  stepId: string,
  pathOnApp: string,
  label: string,
): Promise<void> {
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(`${APP_URL}${pathOnApp}`, { waitUntil: 'domcontentloaded' });
    const status = resp?.status() ?? 0;
    if (status !== 200) {
      await fail(stepId, `GET ${pathOnApp} returned ${status}`, page);
      return;
    }
    const results = await new AxeBuilder({ page }).analyze();
    const bad = results.violations.filter((v) => SERIOUS_IMPACTS.has(v.impact ?? ''));
    if (bad.length === 0) {
      pass(stepId, `${label} (${pathOnApp}): no serious/critical violations`);
    } else {
      const detail = bad
        .slice(0, 3)
        .map((v) => `[${v.impact}] ${v.id}`)
        .join('; ');
      await fail(stepId, `${label} (${pathOnApp}): ${bad.length} violation(s) — ${detail}`, page);
    }
  } catch (e) {
    await fail(stepId, `exception during axe on ${pathOnApp}: ${String(e)}`, page);
  } finally {
    await page.close();
  }
}

async function runAxeSteps(browser: Browser): Promise<void> {
  const anonCtx = await browser.newContext();
  const pupilCtx = await browser.newContext();
  const teacherCtx = await browser.newContext();
  try {
    // Pre-warm pupil + teacher contexts with logged-in sessions.
    const pPage = await pupilCtx.newPage();
    if ((await loginAs(pPage, PUPIL_USER, PUPIL_PW)) !== 302) {
      await fail('14', 'pupil login for axe context failed', pPage);
    }
    await pPage.close();
    const tPage = await teacherCtx.newPage();
    if ((await loginAs(tPage, TEACHER_USER, TEACHER_PW)) !== 302) {
      await fail('16', 'teacher login for axe context failed', tPage);
    }
    await tPage.close();

    await runAxeStep(anonCtx, '13', '/login', 'anonymous /login');
    await runAxeStep(pupilCtx, '14', '/topics', 'pupil /topics');
    if (result.attemptId) {
      await runAxeStep(
        pupilCtx,
        '15',
        `/attempts/${result.attemptId}`,
        'pupil submitted-attempt review',
      );
    } else {
      skip('15', 'no attemptId — cannot axe the pupil review page');
    }
    await runAxeStep(teacherCtx, '16', '/admin/classes', 'teacher /admin/classes');
    await runAxeStep(teacherCtx, '17', '/admin/questions', 'teacher /admin/questions');
    if (result.attemptId) {
      await runAxeStep(
        teacherCtx,
        '18',
        `/admin/attempts/${result.attemptId}`,
        'teacher attempt review',
      );
    } else {
      skip('18', 'no attemptId — cannot axe the teacher attempt page');
    }
    await runAxeStep(teacherCtx, '19', '/', 'teacher home dashboard');
  } finally {
    await anonCtx.close();
    await pupilCtx.close();
    await teacherCtx.close();
  }
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    const teacherCtx = await runTeacherSetup(browser);
    if (teacherCtx) await teacherCtx.close();
    if (result.classId) await runTimerSet(browser);
    await runPupilFlow(browser);
    await runPrintSteps(browser);
    await runAxeSteps(browser);
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
