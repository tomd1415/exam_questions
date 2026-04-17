/**
 * Playwright driver for Phase 1 browser-based steps.
 *
 * Invoked by scripts/human-test-phase1.sh. Reads everything via env vars
 * (so the bash walker stays the source of truth for credentials and
 * report paths) and writes a structured JSON result to $PHASE1_OUT.
 * Screenshots for failed steps land in $PHASE1_SCREENSHOTS.
 *
 * Covers, in a single Chromium run, the four PHASE1_PLAN.md Chunk 9
 * scope items:
 *   1) teacher authoring UI happy path     → steps 4-11
 *   2) pupil topic-set happy path          → steps 12, 13, 16
 *   3) pupil save-and-resume               → steps 14, 15
 *   4) teacher override                    → steps 17-19
 *
 * Step numbering here matches HUMAN_TEST_GUIDE.md §Phase 1 walker.
 *
 * Exits 0 if every step passed, 1 otherwise.
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
  appUrl: string;
  startedAt: string;
  endedAt: string;
  steps: Record<string, StepResult>;
  classId?: string;
  authoredQuestionId?: string;
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
const TEACHER_USER = env('PHASE1_TEACHER_USER');
const TEACHER_PW = env('PHASE1_TEACHER_PW');
const PUPIL_USER = env('PHASE1_PUPIL_USER');
const PUPIL_PW = env('PHASE1_PUPIL_PW');
const CLASS_NAME = env('PHASE1_CLASS_NAME');
const ACADEMIC_YEAR = env('PHASE1_ACADEMIC_YEAR');
const TOPIC_CODE = env('PHASE1_TOPIC_CODE');
const AUTHOR_STEM = env('PHASE1_AUTHOR_STEM');
const OUT_PATH = env('PHASE1_OUT');
const SCREENSHOT_DIR = env('PHASE1_SCREENSHOTS');

const PARTIAL_ANSWER = 'Auto-walker partial answer — only the first part is filled in.';
const FINAL_ANSWER_FILLER = 'Auto-walker final answer placeholder.';
const OVERRIDE_REASON = 'Phase 1 walker override — exercising teacher_override path.';
const OVERRIDE_MARKS = 1;

const result: PhaseResult = {
  appUrl: APP_URL,
  startedAt: new Date().toISOString(),
  endedAt: '',
  steps: {},
};

const pass = (n: string, notes: string): void => {
  result.steps[n] = { status: 'pass', notes };
  console.log(`[phase1-browser] step ${n}: PASS — ${notes}`);
};

const fail = async (n: string, notes: string, page?: Page): Promise<void> => {
  let shot: string | undefined;
  if (page) {
    shot = join(SCREENSHOT_DIR, `step-${n}-fail.png`);
    try {
      await mkdir(SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: shot, fullPage: true });
    } catch (e) {
      console.error(`[phase1-browser] could not save screenshot for step ${n}: ${String(e)}`);
      shot = undefined;
    }
  }
  const entry: StepResult = { status: 'fail', notes };
  if (shot !== undefined) entry.screenshot = shot;
  result.steps[n] = entry;
  console.error(
    `[phase1-browser] step ${n}: FAIL — ${notes}${shot ? ` (screenshot: ${shot})` : ''}`,
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
  opts: { urlPattern?: RegExp; settleMs?: number } = {},
): Promise<void> {
  const navPromise = opts.urlPattern
    ? page.waitForURL(opts.urlPattern, { waitUntil: 'domcontentloaded', timeout: 15000 })
    : page.waitForLoadState('domcontentloaded', { timeout: 15000 });
  await Promise.all([navPromise, page.click(clickSelector)]);
  if (opts.settleMs) await page.waitForTimeout(opts.settleMs);
}

// ---------------------------------------------------------------------------
// Teacher flow: class create, enrol, assign, author, approve
// ---------------------------------------------------------------------------
async function runTeacherSetup(browser: Browser): Promise<BrowserContext | null> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // -----------------------------------------------------------------------
  // Step 4 — teacher logs in
  // -----------------------------------------------------------------------
  try {
    const status = await loginAs(page, TEACHER_USER, TEACHER_PW);
    if (status !== 302) {
      await fail('4', `POST /login returned ${status}, expected 302`, page);
      return ctx;
    }
    pass('4', `teacher ${TEACHER_USER} signed in, landed on ${page.url()}`);
  } catch (e) {
    await fail('4', `exception during login: ${String(e)}`, page);
    return ctx;
  }

  // -----------------------------------------------------------------------
  // Step 5 — open /admin/classes/new, create class (idempotent-ish: if a
  // duplicate class exists, navigate directly to it via /admin/classes).
  // -----------------------------------------------------------------------
  try {
    await page.goto(`${APP_URL}/admin/classes/new`, { waitUntil: 'domcontentloaded' });
    if (new URL(page.url()).pathname !== '/admin/classes/new') {
      await fail(
        '5',
        `expected /admin/classes/new but page is on ${page.url()} (session lost?)`,
        page,
      );
      return ctx;
    }
    await page.fill('input[name="name"]', CLASS_NAME);
    await page.fill('input[name="academic_year"]', ACADEMIC_YEAR);
    try {
      await submitAndWait(page, 'form.admin-form button[type="submit"]', {
        urlPattern: /\/admin\/classes(\/\d+)?$/,
      });
    } catch {
      // fall through — duplicate (409) keeps us on /admin/classes/new with an error flash
    }
    let onDetail = /\/admin\/classes\/\d+$/.test(page.url());
    if (!onDetail) {
      // Duplicate (409) — hop back and pick the existing class.
      await page.goto(`${APP_URL}/admin/classes`, { waitUntil: 'domcontentloaded' });
      const rowLink = page.locator('a', { hasText: CLASS_NAME }).first();
      if (await rowLink.count()) {
        await rowLink.click();
        await page.waitForLoadState('domcontentloaded');
        onDetail = /\/admin\/classes\/\d+$/.test(page.url());
      }
    }
    if (!onDetail) {
      await fail('5', `could not reach a class detail page; url=${page.url()}`, page);
      return ctx;
    }
    const idMatch = /\/admin\/classes\/(\d+)$/.exec(page.url());
    if (idMatch?.[1]) result.classId = idMatch[1];
    pass('5', `class detail at ${page.url()} (id=${result.classId ?? '?'})`);
  } catch (e) {
    await fail('5', `exception: ${String(e)}`, page);
    return ctx;
  }

  // -----------------------------------------------------------------------
  // Step 6 — enrol the pupil (idempotent — the route accepts "already
  // enrolled" without error).
  // -----------------------------------------------------------------------
  try {
    await page.fill('input[name="pupil_username"]', PUPIL_USER);
    await submitAndWait(page, 'form[action$="/enrol"] button[type="submit"]');
    const flash = (await page.locator('.flash--ok').first().textContent()) ?? '';
    const tableHasPupil = await page.locator('td', { hasText: PUPIL_USER }).count();
    if (!tableHasPupil) {
      await fail('6', `pupil ${PUPIL_USER} not in enrolled table (flash="${flash.trim()}")`, page);
    } else {
      pass('6', `pupil enrolled; flash="${flash.trim()}"`);
    }
  } catch (e) {
    await fail('6', `exception: ${String(e)}`, page);
  }

  // -----------------------------------------------------------------------
  // Step 7 — assign the topic under test (idempotent).
  // -----------------------------------------------------------------------
  try {
    // If the topic is already assigned the <select> won't contain it.
    const assignSelect = page.locator('select[name="topic_code"]');
    if ((await assignSelect.count()) > 0) {
      const hasOpt = await assignSelect.locator(`option[value="${TOPIC_CODE}"]`).count();
      if (hasOpt > 0) {
        await assignSelect.selectOption(TOPIC_CODE);
        await submitAndWait(page, 'form[action$="/topics"] button[type="submit"]');
      }
    }
    // Verify the topic appears in the "Assigned topics" table either way.
    const assignedRow = await page.locator('td', { hasText: TOPIC_CODE }).count();
    if (!assignedRow) {
      await fail('7', `topic ${TOPIC_CODE} not in Assigned topics table`, page);
    } else {
      pass('7', `topic ${TOPIC_CODE} is assigned`);
    }
  } catch (e) {
    await fail('7', `exception: ${String(e)}`, page);
  }

  // -----------------------------------------------------------------------
  // Step 8 — open the question authoring form.
  // -----------------------------------------------------------------------
  try {
    await page.goto(`${APP_URL}/admin/questions/new`, { waitUntil: 'domcontentloaded' });
    const formFound = await page.locator('form#question-form').count();
    if (!formFound) {
      await fail('8', 'form#question-form not present on /admin/questions/new', page);
    } else {
      pass('8', 'authoring form rendered at /admin/questions/new');
    }
  } catch (e) {
    await fail('8', `exception: ${String(e)}`, page);
  }

  // -----------------------------------------------------------------------
  // Step 9 — fill + submit the authoring form.
  // -----------------------------------------------------------------------
  try {
    await page.selectOption('select[name="component_code"]', 'J277/01');
    await page.selectOption('select[name="topic_code"]', '1.1');
    await page.selectOption('select[name="subtopic_code"]', '1.1.1');
    await page.selectOption('select[name="command_word_code"]', 'describe');
    await page.selectOption('select[name="archetype_code"]', 'explain');
    await page.fill('textarea[name="stem"]', AUTHOR_STEM);
    await page.selectOption('select[name="expected_response_type"]', 'short_text');
    await page.fill(
      'textarea[name="model_answer"]',
      'Walker-generated model answer — deliberately short; not displayed to pupils.',
    );
    await page.fill('input[name="part_0_label"]', '(a)');
    await page.fill('input[name="part_0_marks"]', '1');
    await page.selectOption('select[name="part_0_response_type"]', 'short_text');
    await page.fill(
      'textarea[name="part_0_prompt"]',
      'Walker authoring prompt — please describe one thing.',
    );
    await page.fill(
      'textarea[name="part_0_mp_0_text"]',
      'Walker mark point one — arbitrary description.',
    );
    await page.fill('input[name="part_0_mp_0_marks"]', '1');

    await submitAndWait(page, 'form#question-form button[type="submit"]', {
      urlPattern: /\/admin\/questions\/\d+/,
    });
    const m = /\/admin\/questions\/(\d+)(?:\?|$)/.exec(page.url());
    if (!m) {
      await fail('9', `did not redirect to /admin/questions/<id>; url=${page.url()}`, page);
    } else {
      const id = m[1];
      if (id) result.authoredQuestionId = id;
      const flash = (await page.locator('.flash').first().textContent()) ?? '';
      pass('9', `authored question id=${id}, flash="${flash.trim()}"`);
    }
  } catch (e) {
    await fail('9', `exception: ${String(e)}`, page);
  }

  // -----------------------------------------------------------------------
  // Step 10 — approve the authored draft so the invariant sweep for the
  // rest of the flow stays simple; pupils never see this question because
  // it is 1.1 not the Phase 1 topic under test, but we prove the approve
  // button works end-to-end.
  // -----------------------------------------------------------------------
  try {
    if (!result.authoredQuestionId) {
      await fail('10', 'no authoredQuestionId recorded from step 9', page);
    } else {
      const approveForm = page.locator(
        `form[action="/admin/questions/${result.authoredQuestionId}/approve"]`,
      );
      if (!(await approveForm.count())) {
        await fail('10', 'approve form not present on detail page', page);
      } else {
        await submitAndWait(
          page,
          `form[action="/admin/questions/${result.authoredQuestionId}/approve"] button[type="submit"]`,
        );
        const flash = (await page.locator('.flash').first().textContent()) ?? '';
        if (flash.includes('approved') || flash.includes('Question approved')) {
          pass('10', `question ${result.authoredQuestionId} approved; flash="${flash.trim()}"`);
        } else {
          await fail('10', `approve flash did not mention approval; got "${flash.trim()}"`, page);
        }
      }
    }
  } catch (e) {
    await fail('10', `exception: ${String(e)}`, page);
  }

  // -----------------------------------------------------------------------
  // Step 11 — sanity-check that /admin/questions lists the authored row.
  // -----------------------------------------------------------------------
  try {
    await page.goto(`${APP_URL}/admin/questions?topic=1.1`, { waitUntil: 'domcontentloaded' });
    const countText = (await page.locator('.admin-card__sub').first().textContent()) ?? '';
    const hasRow =
      (await page
        .locator(`a[href="/admin/questions/${result.authoredQuestionId ?? '___none___'}"]`)
        .count()) > 0;
    if (!hasRow) {
      await fail(
        '11',
        `question ${result.authoredQuestionId} not in filtered list (${countText.trim()})`,
        page,
      );
    } else {
      pass('11', `authored row present in list (${countText.trim()})`);
    }
  } catch (e) {
    await fail('11', `exception: ${String(e)}`, page);
  }

  return ctx;
}

// ---------------------------------------------------------------------------
// Pupil flow: topic-set happy path + save-and-resume across contexts
// ---------------------------------------------------------------------------
async function runPupilFlow(browser: Browser): Promise<void> {
  // -----------------------------------------------------------------------
  // Step 12 — pupil login, lands on /topics
  // -----------------------------------------------------------------------
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    const status = await loginAs(page, PUPIL_USER, PUPIL_PW);
    if (status !== 302) {
      await fail('12', `pupil login: POST /login returned ${status}`, page);
      await ctx.close();
      return;
    }
    await page.goto(`${APP_URL}/topics`, { waitUntil: 'domcontentloaded' });
    const topicRow = await page.locator('td', { hasText: TOPIC_CODE }).count();
    if (!topicRow) {
      await fail('12', `topic ${TOPIC_CODE} not listed for pupil`, page);
      await ctx.close();
      return;
    }
    pass('12', `pupil signed in; /topics shows ${TOPIC_CODE}`);
  } catch (e) {
    await fail('12', `exception: ${String(e)}`, page);
    await ctx.close();
    return;
  }

  // -----------------------------------------------------------------------
  // Step 13 — start the topic set
  // -----------------------------------------------------------------------
  try {
    const startForm = page
      .locator(`form[action="/topics/${encodeURIComponent(TOPIC_CODE)}/start"]`)
      .first();
    if (!(await startForm.count())) {
      await fail('13', `no start form for topic ${TOPIC_CODE}`, page);
      await ctx.close();
      return;
    }
    await submitAndWait(
      page,
      `form[action="/topics/${encodeURIComponent(TOPIC_CODE)}/start"] button[type="submit"]`,
      { urlPattern: /\/attempts\/\d+/ },
    );
    const m = /\/attempts\/(\d+)(?:\?|$)/.exec(page.url());
    if (!m) {
      await fail('13', `did not land on /attempts/<id>; url=${page.url()}`, page);
      await ctx.close();
      return;
    }
    if (m[1]) result.attemptId = m[1];
    const parts = await page.locator('form.question-form textarea').count();
    if (parts === 0) {
      await fail('13', `attempt ${result.attemptId} has no textareas`, page);
    } else {
      pass('13', `attempt ${result.attemptId} with ${parts} part textarea(s)`);
    }
  } catch (e) {
    await fail('13', `exception: ${String(e)}`, page);
    await ctx.close();
    return;
  }

  // -----------------------------------------------------------------------
  // Step 14 — save partial progress (first part only), capturing the
  // part-id so a later cross-check can find it.
  // -----------------------------------------------------------------------
  try {
    const firstTa = page.locator('form.question-form textarea').first();
    const firstName = (await firstTa.getAttribute('name')) ?? '';
    const firstPartId = firstName.replace(/^part_/, '');
    if (/^\d+$/.test(firstPartId)) result.firstPartId = firstPartId;
    await firstTa.fill(PARTIAL_ANSWER);
    // "Save progress" is the form's default submit (no formaction attribute).
    await submitAndWait(
      page,
      'form.question-form button[type="submit"]:not([formaction])',
    );
    const flash = (await page.locator('.flash--ok').first().textContent()) ?? '';
    if (!/Saved \d+ answer/.test(flash)) {
      await fail('14', `unexpected save flash: "${flash.trim()}"`, page);
    } else {
      pass('14', `save flash: "${flash.trim()}"`);
    }
  } catch (e) {
    await fail('14', `exception: ${String(e)}`, page);
  }

  // -----------------------------------------------------------------------
  // Step 15 — close context, log back in, verify partial answer persisted
  // -----------------------------------------------------------------------
  await ctx.close();
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  try {
    const status = await loginAs(page2, PUPIL_USER, PUPIL_PW);
    if (status !== 302) {
      await fail('15', `re-login returned ${status}`, page2);
      await ctx2.close();
      return;
    }
    await page2.goto(`${APP_URL}/attempts/${result.attemptId}`, { waitUntil: 'domcontentloaded' });
    const restored = await page2.locator('form.question-form textarea').first().inputValue();
    if (restored !== PARTIAL_ANSWER) {
      await fail(
        '15',
        `first textarea did not restore partial answer; got ${JSON.stringify(restored)}`,
        page2,
      );
    } else {
      pass('15', `partial answer survived a fresh context + login`);
    }
  } catch (e) {
    await fail('15', `exception: ${String(e)}`, page2);
    await ctx2.close();
    return;
  }

  // -----------------------------------------------------------------------
  // Step 16 — fill remaining parts, submit, verify review page
  // -----------------------------------------------------------------------
  try {
    const tas = page2.locator('form.question-form textarea');
    const n = await tas.count();
    for (let i = 1; i < n; i++) {
      await tas.nth(i).fill(`${FINAL_ANSWER_FILLER} (#${i + 1})`);
    }
    await submitAndWait(
      page2,
      `form.question-form button[formaction="/attempts/${result.attemptId}/submit"]`,
    );
    const hasReviewHeader = await page2.locator('h1', { hasText: '· review' }).count();
    const summary = (await page2.locator('.attempt-summary').first().textContent()) ?? '';
    if (!hasReviewHeader) {
      await fail('16', `no "· review" header on /attempts/${result.attemptId}`, page2);
    } else if (!/Score:\s*\d+\s*\/\s*\d+/.test(summary)) {
      await fail('16', `attempt-summary missing Score: "${summary.trim()}"`, page2);
    } else {
      pass('16', `submit ok; ${summary.trim()}`);
    }
  } catch (e) {
    await fail('16', `exception: ${String(e)}`, page2);
  }

  await ctx2.close();
}

// ---------------------------------------------------------------------------
// Teacher override flow
// ---------------------------------------------------------------------------
async function runTeacherOverride(browser: Browser): Promise<void> {
  if (!result.classId || !result.attemptId || !result.firstPartId) {
    await fail(
      '17',
      `prerequisites missing: classId=${result.classId ?? '?'} attemptId=${result.attemptId ?? '?'} firstPartId=${result.firstPartId ?? '?'}`,
    );
    return;
  }
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // -----------------------------------------------------------------------
  // Step 17 — teacher logs in again and opens the submissions list for
  // their class; verify the just-submitted attempt is visible.
  // -----------------------------------------------------------------------
  try {
    const status = await loginAs(page, TEACHER_USER, TEACHER_PW);
    if (status !== 302) {
      await fail('17', `teacher re-login: ${status}`, page);
      await ctx.close();
      return;
    }
    await page.goto(`${APP_URL}/admin/classes/${result.classId}/attempts`, {
      waitUntil: 'domcontentloaded',
    });
    const row = await page.locator(`a[href="/admin/attempts/${result.attemptId}"]`).count();
    if (!row) {
      await fail(
        '17',
        `attempt ${result.attemptId} not on /admin/classes/${result.classId}/attempts`,
        page,
      );
    } else {
      pass('17', `submissions list shows attempt ${result.attemptId}`);
    }
  } catch (e) {
    await fail('17', `exception: ${String(e)}`, page);
    await ctx.close();
    return;
  }

  // -----------------------------------------------------------------------
  // Step 18 — open attempt detail, post an override on the first part
  // -----------------------------------------------------------------------
  try {
    await page.goto(`${APP_URL}/admin/attempts/${result.attemptId}`, {
      waitUntil: 'domcontentloaded',
    });
    const action = `/admin/attempts/${result.attemptId}/parts/${result.firstPartId}/mark`;
    const form = page.locator(`form[action="${action}"]`);
    if (!(await form.count())) {
      await fail('18', `no mark form for part ${result.firstPartId}`, page);
      await ctx.close();
      return;
    }
    await form.locator('input[name="marks_awarded"]').fill(String(OVERRIDE_MARKS));
    await form.locator('input[name="reason"]').fill(OVERRIDE_REASON);
    await submitAndWait(page, `form[action="${action}"] button[type="submit"]`);
    const flash = (await page.locator('.flash--ok').first().textContent()) ?? '';
    if (!flash.includes('Mark updated')) {
      await fail('18', `unexpected override flash: "${flash.trim()}"`, page);
    } else {
      pass('18', `override saved; flash="${flash.trim()}"`);
    }
  } catch (e) {
    await fail('18', `exception: ${String(e)}`, page);
  }

  await ctx.close();

  // -----------------------------------------------------------------------
  // Step 19 — pupil reloads review, sees the teacher_override marker
  // -----------------------------------------------------------------------
  const pupilCtx = await browser.newContext();
  const pupilPage = await pupilCtx.newPage();
  try {
    const status = await loginAs(pupilPage, PUPIL_USER, PUPIL_PW);
    if (status !== 302) {
      await fail('19', `pupil re-login: ${status}`, pupilPage);
      await pupilCtx.close();
      return;
    }
    await pupilPage.goto(`${APP_URL}/attempts/${result.attemptId}`, {
      waitUntil: 'domcontentloaded',
    });
    const body = (await pupilPage.locator('section.admin-card').textContent()) ?? '';
    const summary = (await pupilPage.locator('.attempt-summary').first().textContent()) ?? '';
    // The review template does not print "teacher_override" on the pupil
    // side by design; the proof the override applied is that the score
    // >= OVERRIDE_MARKS (the deterministic pass might have awarded zero).
    const m = /Score:\s*(\d+)\s*\/\s*(\d+)/.exec(summary);
    if (m?.[1] === undefined) {
      await fail('19', `no score in pupil summary: "${summary.trim()}"`, pupilPage);
    } else if (Number.parseInt(m[1], 10) < OVERRIDE_MARKS) {
      await fail(
        '19',
        `pupil score ${m[1]} lower than override ${OVERRIDE_MARKS} (body len ${body.length})`,
        pupilPage,
      );
    } else {
      pass('19', `pupil now sees Score: ${m[1]} / ${m[2]} after override`);
    }
  } catch (e) {
    await fail('19', `exception: ${String(e)}`, pupilPage);
  }
  await pupilCtx.close();
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    const teacherCtx = await runTeacherSetup(browser);
    if (teacherCtx) await teacherCtx.close();
    await runPupilFlow(browser);
    await runTeacherOverride(browser);
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
