# Phase 2 implementation plan

**Phase in [PLAN.md](PLAN.md):** Phase 2 — OCR-style presentation and
objective marking polish. Duration estimate: 2–3 weeks of evening
work.

> **Status (2026-04-17):** Not started. Phase 1 signed off in
> [RUNBOOK.md](RUNBOOK.md) §10 on this date (walker report
> `tmp/human-tests/phase1-20260417T182602Z.md`, 20/20 auto steps PASS,
> seeder FK-restrict idempotency fixed in
> `src/repos/questions.ts::upsertPartsAndMarkPoints`). This document
> is the initial sequencing; expect edits as chunks land and update
> the Appendix revision log.

## 1. Phase goal in one paragraph

At the end of Phase 2, a pupil opening an assigned topic-set sees
something that reads like a real OCR J277 exam: paper-style header,
marks printed in the margin, answer spaces sized to the mark tariff,
monospace input for code/algorithm parts, and a calm "submit and
review" page that shows a model answer beside the pupil's response for
objective items. Answers autosave silently while the pupil works so a
dropped connection never eats more than a few words. The pupil can
optionally start a set with a visible countdown timer, and the
teacher can print any set as a PDF the department could hand-mark.
The whole thing passes a keyboard-only / screen-reader / dyslexia-font
accessibility pass with no blocker flagged.

No LLM, no adaptive routing, no pupil-visible analytics — those
remain Phase 3, 4, and 6 respectively.

Success is measured by the Phase 2 user test in [PLAN.md](PLAN.md)
§Phase 2: one revision lesson where pupils describe the experience
unprompted as "looks like the real paper" and no accessibility
blocker is discovered.

## 2. What already exists (end of Phase 1)

Live on `main` as of 2026-04-17 and _not_ re-done in Phase 2:

- **Curated content pipeline.** `content/curated/*.json` → `npm run
content:seed` → idempotent upsert into `questions`, `question_parts`,
  `mark_points`, `common_misconceptions`. Seeder preserves
  `question_part.id` values across re-seeds so live `attempt_parts`
  FK references are never broken.
- **Per-question reveal mode.** `users.reveal_mode` and
  `attempts.reveal_mode` (`whole_attempt` | `per_question`),
  `attempt_questions.submitted_at`, `attempt_parts.pupil_self_marks`;
  routes `/attempts/:id/questions/:qid/submit` and
  `/attempts/:id/parts/:pid/self-mark`;
  `/me/preferences/reveal-mode` toggle.
- **Deterministic marking** for `multiple_choice`, `tick_box`, and
  `short_text` (100% branch-covered). Open-response types
  (`medium_text`, `extended_response`, `code`, `algorithm`,
  `trace_table`) are stored with `marker='teacher_pending'` and
  surfaced on the teacher review page.
- **Teacher flows.** Class create/enrol, topic assignment, question
  authoring (draft → pending → approved), submissions list, per-mark
  override with reason (audit event `marking.override`).
- **Pupil flows.** Topic list, start, save, resume across sessions,
  submit (whole-attempt or per-question), own-score review with
  model answer for objective parts and a "teacher will mark" label
  for open parts.
- **Phase 1 walker.** `scripts/human-test-phase1.sh` +
  `scripts/phase1-browser.ts` (Playwright) covering steps 1–21, with
  DB cross-checks on `audit_events` and `awarded_marks`.
- **Infrastructure.** Auth, CSRF, signed session cookies, Argon2id,
  audit trail, nightly backups, restore drill, DPIA draft,
  `_chrome.eta` + `_admin_chrome.eta` shared layouts pointing at a
  single stylesheet at `src/static/site.css` (~200 lines, no inline
  `<style>` blocks anywhere).

None of the eight `expected_response_type` values are rendered with
type-specific UI in Phase 1 — every part is a plain multiline
`<textarea>`. Phase 2 is largely about fixing that.

## 3. What Phase 2 will build

Grouped by user-visible surface. Detailed per-chunk breakdown is §5.

- **OCR paper-style renderer.** New pupil-facing stylesheet and
  template fragments that turn `_attempt_edit_body.eta` into
  something visually closer to a real J277 paper: paper header
  (component, topic, marks total), per-question marks-in-margin,
  paper-ruled answer space whose height is driven by the part's
  mark tariff.
- **Per-type input widgets.** The renderer branches on
  `question_parts.expected_response_type`:
  - `multiple_choice` / `tick_box` → radio / checkbox group with the
    mark-point texts as the options (no free-text fallback).
  - `short_text` → single-line `<input>` with `maxlength` sized to
    the expected answer.
  - `medium_text` → textarea with a generous row count but no
    paper-rules.
  - `extended_response` → paper-ruled lined textarea sized to the
    mark tariff.
  - `code` / `algorithm` → monospace textarea, tab-to-indent,
    `spellcheck=false`.
  - `trace_table` → fixed-width table widget backed by a
    `<textarea>` (pipe-separated serialisation) so the schema still
    sees a single `raw_answer` string.
- **Autosave.** Small vanilla-JS module that posts every N seconds
  (default 20) and on `blur`/`visibilitychange`. Server side is a new
  idempotent partial-save endpoint that accepts a single part and
  returns a short JSON ack. No HTMX, no framework — one file,
  `src/static/autosave.js`.
- **Countdown timer (optional per class).** A nullable
  `classes.timer_minutes` column drives a visible countdown for
  pupils starting a set from a timed class. Timer is advisory only
  in Phase 2 — the backend does not auto-submit, it only records the
  elapsed time on submit for the teacher review page.
- **Enhanced review page.** The pupil review gets a quiet side-by-side:
  pupil answer, model answer, per-mark-point hit/miss ticks for
  objective parts. Open parts still defer to the teacher.
- **Print-to-PDF mode.** `GET /attempts/:id/print` renders a
  print-stylesheet version of the paper with no navigation chrome,
  answer spaces blank (or filled with the pupil's answers if query
  param `?answers=1` and the viewer is the pupil or owning teacher).
  Tested with headless-Chromium print-to-PDF in the walker.
- **Accessibility pass.** Explicit keyboard order, visible focus
  states, WCAG AA contrast audit, a dyslexia-friendly font option
  stored in `users.font_preference`, `<label for>` on every input, an
  `aria-describedby` on every input pointing at its marks tag.

## 4. What Phase 2 will _not_ build

From [PLAN.md](PLAN.md) §Phase 2 "Do not build", expanded:

- **No LLM-anything.** Open responses still route to the teacher. No
  outbound call to `api.openai.com` lands in this phase.
- **No adaptive routing.** Question order within a set stays as the
  teacher-defined `display_order`. No mastery scores, no spaced
  repetition, no "next recommended topic" banners.
- **No pupil-visible analytics.** The review page is still per-attempt.
  No running totals, no dashboards, no streaks.
- **No question-type beyond the existing eight.** The `trace_table`
  widget is still the table we already type-declared; we do not add
  a new `expected_response_type` value in this phase.
- **No cross-class analytics for teachers.** Phase 6.
- **No parent / SLT views.** Phase 7.
- **No bulk PDF import.** Content still flows through
  `content/curated/` + `npm run content:seed`; Phase 5 adds the
  AI-assisted authoring path.
- **No rich-text editor for the authoring UI.** The teacher still
  edits a JSON-like textarea form. Phase 2 invests in _pupil_
  presentation, not teacher presentation.
- **No server-side auto-submit on timer expiry.** The timer is
  advisory for this phase; adding enforceable auto-submit is a
  separate decision scheduled for Phase 4.

## 5. Chunk-by-chunk plan

Standing rules from [PHASE1_PLAN.md](PHASE1_PLAN.md) §5 carry over
verbatim — authz in `preHandler`, CSRF on every POST, one audit-event
per state change, no inline `<style>`, no new runtime dependencies
without justification.

Two extra Phase 2 rules:

- **No ES-module frameworks.** Every script added to `src/static/`
  is plain ES2020 that parses in Chromium without a bundler. The
  user's school lab machines are modest; we don't ship a megabyte of
  tooling for a countdown timer.
- **Every template change ships with a screenshot in the chunk PR.**
  Phase 2 is visual; diffs are easy to miss.

### Chunk 1 — OCR paper skeleton

**Goal.** Reshape the pupil-facing layout of `_attempt_edit_body.eta`
so it reads as a paper: header block (component code, topic,
subtopic, total marks, optional candidate pseudonym), marks-in-margin
per part, a clear per-question separator. Pure CSS + minor markup
changes; no behaviour change yet.

**Schema.** None.

**App code.**

- Extract the pupil layout into `_paper_chrome.eta` + a new
  stylesheet module `src/static/paper.css` linked from `_chrome.eta`.
- Rework `.question-card`, `.question-part`, `.question-part__marks`
  classes; introduce `.paper-header`, `.paper-question`,
  `.paper-marks-gutter`.
- Move the Phase 1 "inline metadata badges" for topic / subtopic /
  command-word out of the pupil card (still rendered on teacher and
  review views where they belong).

**Audit events added.** None.

**Tests.**

| Level | File                                    | What it proves                                                                                                             |
| ----- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| HTTP  | `tests/http/pupil-paper-chrome.test.ts` | Pupil GET `/attempts/:id` renders `.paper-header`, `.paper-marks-gutter`, no `.badge--muted` leakage of teacher metadata.  |
| Human | HUMAN_TEST_GUIDE §2.A                   | Teacher and pupil both confirm the paper-style layout reads like a J277 paper; marks sit in a margin, not inside the card. |

**Exit criteria.** `npm run check` green; one real teacher + one real
pupil both tick "looks like a paper" on a side-by-side screenshot
review.

### Chunk 2 — Per-type input widgets

**Goal.** Branch the pupil renderer on
`question_parts.expected_response_type` and use the right input for
each type. Keep the single `raw_answer` string on the wire — the
widget is responsible for its own serialisation.

**Schema.** None. `expected_response_type` already takes the eight
values we render.

**App code.**

- `src/templates/_paper_part_widget.eta` — a single Eta partial that
  dispatches on `part.expected_response_type` and includes the
  matching widget partial:
  `_widget_mc.eta`, `_widget_tick.eta`, `_widget_short.eta`,
  `_widget_medium.eta`, `_widget_extended.eta`, `_widget_code.eta`,
  `_widget_algorithm.eta`, `_widget_trace_table.eta`.
- Each widget partial reads the already-loaded `mark_points` for
  options where it needs them (MC, tick-box) and the previous
  `raw_answer` for re-hydration.
- Server-side parser for `trace_table` (in
  `src/services/attempts.ts` on save) that accepts a pipe-separated
  grid and stores it verbatim; no structured column yet.
- Delete the blanket `<textarea rows="5">` fallback from
  `_attempt_edit_body.eta` — every part now renders through the
  dispatcher.

**Audit events added.** None.

**Tests.**

| Level       | File                                         | What it proves                                                                                                                                                      |
| ----------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP        | `tests/http/pupil-widgets.test.ts`           | GET an attempt containing one of each type — each widget renders the expected input element(s); re-posting a previously saved value re-populates correctly.         |
| Integration | `tests/integration/trace-table-save.test.ts` | Pipe-separated trace-table input round-trips through save/submit without the deterministic marker crashing; open-type contract preserved (still `teacher_pending`). |
| Human       | HUMAN_TEST_GUIDE §2.B                        | Pupil answers one question of each type using the expected widget, no "wrong input for this question" moments.                                                      |

**Exit criteria.** All eight `expected_response_type` values render a
type-appropriate widget; the existing deterministic marker is
unchanged and still 100% covered.

### Chunk 3 — Autosave

**Goal.** While a pupil is filling in a set, their answers persist
every ~20 seconds and on blur/visibility change. Network blips do not
eat work.

**Schema.** None. `attempt_parts.raw_answer` already takes a partial
string.

**App code.**

- `src/routes/attempts.ts`: add `POST /attempts/:id/parts/:pid/save`
  accepting one `raw_answer`, returning JSON
  `{ ok: true, saved_at: <iso> }`. CSRF via header token
  (the autosave script reads the existing hidden `_csrf` field and
  sends it as `x-csrf-token`).
- `src/services/attempts.ts`: `savePartOne(attemptPartId, rawAnswer,
userId)` — idempotent, writes `attempt.part.saved` audit events
  at most once per 60 s per part (debounce, not per-call).
- `src/static/autosave.js` (~150 lines, no dependencies): finds every
  widget with `data-autosave-part-id`, listens on `input` (debounced
  5 s), `blur`, `visibilitychange`, posts the delta, updates a small
  "Saved 18:42" status line near the Save button.
- Widget partials from Chunk 2 add the `data-autosave-part-id`
  attribute.
- `_chrome.eta` includes `<script src="/static/autosave.js"
defer></script>` behind an `it.autosaveEnabled` flag so login /
  admin pages don't ship it.

**Audit events added.** Existing `attempt.part.saved` is reused; the
debounce keeps the table size sane.

**Tests.**

| Level       | File                                          | What it proves                                                                                                                                                             |
| ----------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Integration | `tests/integration/autosave-debounce.test.ts` | Three rapid `savePartOne` calls for the same part produce one new `awarded_marks` row (still `teacher_pending` for open) and at most one `attempt.part.saved` audit event. |
| HTTP        | `tests/http/autosave-endpoint.test.ts`        | POST with valid CSRF returns `{ ok: true }`; POST without CSRF returns 403; POST to another pupil's attempt returns 403.                                                   |
| Browser     | `scripts/phase2-browser.ts` autosave step     | Type → wait 25 s → force-close context → re-open → the typed text is there without the pupil having clicked Save.                                                          |
| Human       | HUMAN_TEST_GUIDE §2.C                         | Pupil types for 90 s without clicking Save; pulls the laptop lid closed; reopens; sees everything.                                                                         |

**Exit criteria.** Pupil can complete a 20-minute set without ever
clicking Save and lose at most the last 5 s of typing on a network
fail.

### Chunk 4 — Optional countdown timer

**Goal.** A teacher can mark a class as "timed" with a minutes value;
pupils in that class see a countdown on the set; elapsed time is
recorded on submit.

**Schema.** Migration `0011_class_timer.sql`:

- `ALTER TABLE classes ADD COLUMN timer_minutes INT NULL CHECK
(timer_minutes BETWEEN 1 AND 180);`
- `ALTER TABLE attempts ADD COLUMN elapsed_seconds INT NULL;`
  (nullable — only populated on timed attempts).

**App code.**

- `src/repos/classes.ts`: extend `createClass` and add
  `updateClassTimer(classId, teacherId, minutes | null)`.
- `src/routes/admin-classes.ts`: `POST /admin/classes/:id/timer`.
- Pupil attempt bundle carries `attempt.timer_minutes` (from the
  class at start time — captured onto the attempt, not re-read on
  every request, so a mid-set change does not mutate an in-flight
  attempt).
- `src/static/timer.js` (~80 lines): reads `data-timer-minutes` and
  `data-timer-started-at` from the paper header, counts down,
  colour-shifts at 10 minutes and 1 minute remaining. No auto-submit.
- On submit, the client posts `elapsed_seconds` as a hidden field;
  the server clamps to `[0, timer_minutes * 60 + 30]` and stores it.

**Audit events added.** `class.timer_set` (teacher-facing only — the
pupil doesn't need an audit event per countdown tick).

**Tests.**

| Level       | File                                    | What it proves                                                                                                                                         |
| ----------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Integration | `tests/integration/class-timer.test.ts` | `updateClassTimer` writes the value; `createTopicSetAttempt` for a timed class copies the minutes onto the attempt; submitting stores clamped elapsed. |
| HTTP        | `tests/http/admin-class-timer.test.ts`  | Teacher B cannot set teacher A's class timer (403); teacher A setting a timer is reflected on the pupil's attempt.                                     |
| Browser     | `scripts/phase2-browser.ts` timer step  | Pupil starts a timed attempt → countdown is visible → pupil submits → elapsed_seconds is within 2 s of the wall clock.                                 |
| Human       | HUMAN_TEST_GUIDE §2.D                   | Teacher sets timer, pupil takes the set, both confirm the countdown is calm, not anxiety-inducing (no red flashing, no pop-ups).                       |

**Exit criteria.** A class can be timed; elapsed time appears on the
teacher submissions list next to the raw score.

### Chunk 5 — Review page with model answer side-by-side

**Goal.** The pupil review gets a calm two-column view per part:
pupil answer on the left, model answer on the right, per-mark-point
hit/miss ticks underneath for objective parts. Open parts keep the
"teacher will mark" label until marked.

**Schema.** None. Phase 1 already stores `mark_points_hit` on the
`awarded_marks` row.

**App code.**

- `src/templates/_attempt_review_body.eta` rework: split the
  existing "question-part--review" block into `.pupil-col` and
  `.model-col`, put the hit/miss list in a `.mark-points-grid`
  underneath.
- New CSS in `src/static/paper.css`: two-column on ≥720px, stacked
  below.
- No route change; the existing `/attempts/:id` review flow feeds
  the new template.

**Audit events added.** None.

**Tests.**

| Level | File                                 | What it proves                                                                                                                   |
| ----- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| HTTP  | `tests/http/pupil-review-v2.test.ts` | Objective part renders both columns + hit/miss grid; open part renders pupil column + "teacher will mark" placeholder.           |
| Human | HUMAN_TEST_GUIDE §2.E                | Pupil understands why they lost marks on an objective part without the teacher having to explain it; screen is not overwhelming. |

**Exit criteria.** Pupils self-serve on objective-part review without
teacher follow-up in the next lesson.

### Chunk 6 — Print-to-PDF mode

**Goal.** Teacher clicks "Print" on a topic-set or an attempt and
gets a paper-like PDF suitable for photocopying or hand-marking.

**Schema.** None.

**App code.**

- `GET /attempts/:id/print` — renders `attempt_print.eta` with
  `_print_chrome.eta` (no nav, no footer, no buttons). Query param
  `?answers=0|1`. Pupil may print their own attempt (answers always
  included); teacher owning the class may print any attempt in that
  class with either value.
- `GET /topics/:code/print` — renders a blank paper of the same 8
  questions the pupil flow would pick (uses
  `createTopicSetAttempt` in "preview" mode; does _not_ create a real
  attempt row).
- `src/static/print.css` with `@media print` rules — hides anything
  not inside `.paper-root`, forces page breaks between questions,
  enlarges answer spaces.
- Teacher UI adds Print buttons on `/admin/classes/:id/attempts` and
  on `/admin/topics` (preview).

**Audit events added.** None (reads).

**Tests.**

| Level   | File                                   | What it proves                                                                                                           |
| ------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| HTTP    | `tests/http/print-routes.test.ts`      | Pupil cannot print teacher's attempt; `?answers=1` from a non-owner returns 403; `?answers=0` preview works for teacher. |
| Browser | `scripts/phase2-browser.ts` print step | Headless Chromium renders `/attempts/:id/print` to PDF; file is `> 10 KB`; text layer contains the question stem.        |
| Human   | HUMAN_TEST_GUIDE §2.F                  | Teacher prints a preview on the school printer, marks it by hand, confirms layout is recognisable as an exam paper.      |

**Exit criteria.** A teacher can hand a printed set to a class as a
revision paper without editing it in another tool.

### Chunk 7 — Accessibility pass

**Goal.** Keyboard-only use is smooth; screen reader reads the
paper correctly; contrast meets WCAG AA; a dyslexia-friendly font
option is selectable from `/me/preferences`.

**Schema.** Migration `0012_user_font_preference.sql`:

- `ALTER TABLE users ADD COLUMN font_preference TEXT NOT NULL
DEFAULT 'system' CHECK (font_preference IN ('system', 'dyslexic'));`

**App code.**

- `src/routes/me.ts`: `POST /me/preferences/font` (alongside the
  existing reveal-mode preference).
- `_chrome.eta`: sets `<html data-font="…">` from the user's
  preference; CSS branches on `[data-font="dyslexic"]` to load
  [OpenDyslexic](https://opendyslexic.org/) self-hosted at
  `src/static/fonts/`. Font files tracked in git (≤ 200 KB per
  weight; licence is SIL OFL, compatible with repo distribution —
  verify at commit time).
- `aria-describedby` on every widget input pointing at its marks tag.
- `<label for>` audit across every form in the app; fix any
  implicit-label leftovers.
- Focus ring audit: every interactive element has a visible,
  non-blue-default focus outline that meets 3:1 contrast against its
  background.
- Run axe-core as part of `npm run check` (Playwright-based axe run
  over the seven core pages; fails the build on any "serious" or
  higher violation).

**Audit events added.** None.

**Tests.**

| Level   | File                                 | What it proves                                                                                                                                          |
| ------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit    | `tests/unit/font-preference.test.ts` | Preference repo round-trip; default is `system`; invalid value rejected at the service layer (not just the DB check).                                   |
| HTTP    | `tests/http/me-font.test.ts`         | POST with CSRF toggles `data-font` on next render; unauthenticated POST → redirect to `/login`.                                                         |
| Browser | `scripts/phase2-browser.ts` axe step | axe-core against `/login`, `/topics`, `/attempts/:id`, `/attempts/:id/review`, `/admin/classes`, `/admin/questions`, `/admin/attempts/:id` — 0 serious. |
| Human   | HUMAN_TEST_GUIDE §2.G                | Teacher navigates a full attempt with keyboard only; screen-reader reads question stem + marks + widget label in sensible order.                        |

**Exit criteria.** Zero axe-core "serious"/"critical" violations on
the seven core pages; keyboard-only walkthrough completes end-to-end;
dyslexic font toggles globally.

### Chunk 8 — Phase 2 human-test walker

**Goal.** Mirror the Phase 1 walker. Automate the paper-layout,
autosave, timer, print, and axe checks; leave the final "looks like
a paper" verdict to the human at step 21.

**App code.**

- `scripts/human-test-phase2.sh` — bash walker, same pattern as
  `scripts/human-test-phase1.sh`. **Fix the step-21 stdin-EOF
  infinite loop** that we hit in Phase 1 (when the piped input
  closed before `ask_pf`, `read` returned EOF and the `case` looped
  forever). Mitigation: `ask_pf` treats `read` non-zero exit as a
  deliberate SKIP and exits the loop.
- `scripts/phase2-browser.ts` — Playwright driver covering: open a
  topic-set in per-question mode, type and wait for autosave, force
  close context and reopen, confirm answer survived; print-to-PDF;
  axe-core run.
- `package.json` adds `"test:human:phase2":"bash
scripts/human-test-phase2.sh"`.

**Audit events added.** None.

**Tests.** The walker is the test. `npm run check` remains the
regression net.

**Exit criteria.** `npm run test:human:phase2` exits 0 with a report
attached to [RUNBOOK.md](RUNBOOK.md) §10 for Phase 2 sign-off.

### Chunk 9 — Real lesson with the class

**Goal.** The Phase 2 user test from [PLAN.md](PLAN.md): one real
revision lesson where the teacher runs a timed paper-style set. Not
code; it is the sign-off event.

**Pre-flight (morning of).**

- `npm run check` green on the exact commit being used.
- `npm run test:human:phase2` green within the previous 24 h.
- Backup taken within the previous 24 h.

**During the lesson.**

- Teacher assigns a timed topic-set (timer 20 min) to the class.
- Pupils log in, sit the "paper", submit.
- Teacher prints one attempt to PDF live for the record.
- Teacher reviews in the admin UI during the lesson.

**After the lesson.**

- Capture one-line entries in RUNBOOK.md §10.
- Collect three specific pieces of feedback per pupil: (a) "does it
  feel like an exam?", (b) "was the answer space the right size?",
  (c) "is the review page useful?". Record verbatim in
  `tmp/phase2-feedback.md`.

**Exit criteria (go to Phase 3).**

- Pupils describe the experience unprompted as "looks like the real
  paper".
- No accessibility blocker discovered during the lesson.
- Print-to-PDF output accepted by the teacher as "I'd mark that on
  paper."

See [PLAN.md](PLAN.md) §Phase 2 "Success criteria".

## 6. Test strategy across the phase

Same layers as Phase 1. Additions:

| Layer                 | When run                    | What it catches                                                           |
| --------------------- | --------------------------- | ------------------------------------------------------------------------- |
| axe-core (Playwright) | `npm run test:human:phase2` | WCAG AA violations on seven core pages (serious/critical fail the walker) |
| Print-to-PDF snapshot | `npm run test:human:phase2` | Paper layout still renders to a non-empty PDF with searchable text        |

**Coverage target.** Maintain ≥85% line coverage on `src/services/**`
and `src/repos/**`. The deterministic marker stays at 100% branch.
New `src/static/*.js` is tested via browser only — we are not bringing
in jsdom for a ~200-line autosave.

**No mocks.** Same policy. Integration tests hit the dockerised
Postgres.

## 7. Ordering and dependencies

```
Chunk 1 (paper skeleton)
  └─► Chunk 2 (per-type widgets)
        ├─► Chunk 3 (autosave)          ◄── parallelisable with 4
        └─► Chunk 4 (timer)
              └─► Chunk 5 (review v2)
                    └─► Chunk 6 (print)
                          └─► Chunk 7 (a11y)
                                └─► Chunk 8 (walker)
                                      └─► Chunk 9 (real lesson)
```

Chunks 1 and 2 must land in order — downstream chunks depend on the
new widget partials and the paper CSS classes. Chunks 3 (autosave)
and 4 (timer) can run in parallel after Chunk 2. Accessibility
(Chunk 7) is _deliberately last_ because axe-core runs against the
final rendered pages; running it earlier would just re-fail as new
markup arrives.

## 8. Risks specific to Phase 2 (and their mitigations)

- **CSS regressions on the admin side.** Pupil-paper work
  accidentally breaks teacher screens (they share `_chrome.eta`).
  Mitigation: every Phase 2 chunk's HTTP test includes one admin
  page snapshot; every PR includes screenshots from both a pupil and
  a teacher page.
- **Autosave races with explicit Save.** Two concurrent POSTs to the
  same part could clobber order. Mitigation: the autosave endpoint
  is `save-one-part`; explicit Save remains the whole-form endpoint;
  both hit the same idempotent repo method which only writes if
  `raw_answer` differs. Document this in
  [DATA_MODEL.md](DATA_MODEL.md).
- **Timer anxiety.** A visible countdown on a revision tool is not
  the same affordance as a real exam. Mitigation: the timer is
  opt-in per class (teacher decides), the UI stays calm (no red
  flash), and the backend does not auto-submit. Re-evaluate in the
  lesson test; revert if pupils report it was distracting.
- **Print-to-PDF inconsistency.** Different browsers print
  differently. Mitigation: the walker specifically runs headless
  Chromium print; any school printer differences are a teacher
  concern, not a CI concern. Document the "tested against
  Chromium 131" note in HUMAN_TEST_GUIDE §2.F.
- **axe-core noisiness.** Third-party axe rules sometimes flag
  known-false-positives. Mitigation: the walker whitelists specific
  rule IDs in a committed `axe-ignore.json`; every whitelisted rule
  has a one-sentence justification next to it. Do not silently
  disable.
- **OpenDyslexic licence / footprint.** Font files in git add
  weight. Mitigation: confirm SIL OFL at commit; use only Regular +
  Bold (≤ 400 KB total); load via
  `font-display: swap`.
- **Scope creep into Phase 3 (LLM).** Pupils or the teacher will ask
  "why don't you just use AI to mark this?". Mitigation: keep Phase
  2 silent on LLM — no "coming soon" banners, no feature flags. The
  answer is "the next phase" and it goes in PHASE3_PLAN.md, not
  here.

See [RISKS.md](RISKS.md) §1 and §2.1 for the enduring register.

## 9. Decisions taken before starting

Resolved on 2026-04-17. Binding for Phase 2 unless a later chunk
commit explicitly revisits one.

1. **Paper metadata in the header.** Component code, topic name,
   total marks, and the candidate pseudonym are all shown on the
   paper header. Mirrors a real OCR paper; the pseudonym is already
   pupil-visible in the nav so nothing new leaks. Implemented in
   Chunk 1.
2. **Untimed attempts.** When a class has no `timer_minutes`, the
   pupil's attempt renders with no countdown widget and no "untimed"
   label. Silent absence — calmer than an explicit badge.
3. **Autosave debounce values.** Global, not per-class: 20 s poll +
   5 s post-typing debounce. A per-class override is a future
   decision only if the lesson test surfaces a reason.
4. **Tab-to-indent in the code widget.** Approved. `Tab` indents
   when the code widget has focus _and_ the user has already typed;
   `Esc` then `Tab` always moves focus out. Both behaviours are
   covered by the keyboard-navigation test in Chunk 7.
5. **Timer on the printed paper.** The printed paper header
   includes "Time allowed: NN minutes" when the set is timed,
   mirroring OCR papers. Omitted entirely for untimed sets.

Where these decisions affect the schema (item 2 → no schema change;
item 1 → no schema change; the timer column itself comes in from
Chunk 4's migration `0011_class_timer.sql`), the migration lands in
the chunk that first needs it and is recorded in
[DATA_MODEL.md](DATA_MODEL.md) at merge time.

## 10. Deliverables checklist (sign off before starting Phase 3)

- [ ] Chunks 1–8 merged with tests green.
- [ ] Phase 2 human-test walker report attached to RUNBOOK.md §10
      with PASS.
- [ ] Real lesson test completed with the teacher's class (Chunk 9).
- [ ] axe-core clean on the seven core pages.
- [ ] Print-to-PDF output accepted by the teacher.
- [ ] HUMAN_TEST_GUIDE §Phase 2 filled in (stub removed).
- [ ] DATA_MODEL.md reflects migrations `0011_class_timer.sql` and
      `0012_user_font_preference.sql`.
- [ ] PLAN.md §Phase 2 "Success criteria" all ticked, or a
      documented reason for any exception.
- [ ] Go/no-go decision for Phase 3 recorded in RUNBOOK.md §10 (one
      line: date, initials, PASS/FAIL, link to lesson report).

## Appendix — Revision history

| Date       | Author | Change                                                                                                                                                       |
| ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-04-17 | TD     | First draft at the close of Phase 1. Sequencing + risks + open questions captured; chunks not yet scheduled.                                                 |
| 2026-04-17 | TD     | §9 resolved: paper header includes pseudonym; untimed attempts are silent; autosave is global; tab-to-indent with Esc escape; timer printed on timed papers. |
