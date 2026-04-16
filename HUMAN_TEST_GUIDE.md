# Human test guide

> **Audience:** the project owner sitting in front of a browser, before signing
> off a phase. Automated tests catch regressions; this document catches
> things only a human can notice (does the page _feel_ right, does the
> success message read clearly, did the data actually survive a reboot).
>
> Every phase listed in [PLAN.md](PLAN.md) has a section here. Phase 0 is
> fully written out because it is what gates Phase 1. Phases 1–7 are stubs
> (the user-test from PLAN.md, plus a place to land detailed steps when
> the work for that phase is built).
>
> **Run the automated suite first.** If `npm run check` is failing, do not
> bother with the manual checks — fix the regression first.

## How to use this guide

1. Pick the phase you are signing off.
2. Walk the **prerequisites** to set the system up cleanly.
3. Walk the **steps** in order, comparing the screen and the database to
   the **expected** column.
4. Tick the **sign-off checklist** at the bottom of the section.
5. Record the run in [RUNBOOK.md](RUNBOOK.md) §10 (one line: date,
   initials, "Phase N human test", PASS/FAIL).
6. If anything fails, write the failure into [RUNBOOK.md](RUNBOOK.md) §10
   AND open an issue / TODO before moving on. Do not "carry forward" a
   failed step.

## Conventions

- `$` lines in code blocks are run in your dev shell (Gentoo box) unless
  the section says otherwise.
- `psql>` lines are run inside `npm run db:psql` (Dockerised dev DB) or
  the equivalent on the prod VM.
- "Open in browser" assumes <http://localhost:3030> in dev or
  `https://revision.<school>.internal` in production.

---

## Phase 0 — Foundations: end-to-end happy path survives a reboot

**Maps to:** [PLAN.md](PLAN.md) Phase 0 user test ("teacher logs in,
opens `/q/1`, types an answer, submits ... data survives reboot").

> **Prefer the automated walker.** `npm run test:human:phase0` runs
> every step below end-to-end:
>
> - HTTP-only checks (steps 1, 2, 3, 10, 11) → curl + assert, no prompt
> - browser flows (steps 4–9, 16) → headless Chromium via Playwright,
>   driving login, view, submit, pupil-isolation, and post-reboot
>   session check; per-step PASS/FAIL with screenshots on failure
> - reboot survival (steps 12–15) → scripted, with one prompt to
>   confirm "Ctrl-C the dev server" and one for "dev server back up"
> - backup + restore drill (steps 17, 18) → fully scripted; verifies a
>   new `.dump` + `.sha256` and that `[restore-drill] PASS:` is in the
>   output
> - RUNBOOK.md entry (step 19) → reminder + human PASS/FAIL only
>
> A timestamped markdown report is written to
> `tmp/human-tests/phase0-<utc-ts>.md` containing every captured
> stdout/stderr, the per-step verdicts, and links to any Playwright
> failure screenshots in `tmp/human-tests/phase0-<utc-ts>-screenshots/`.
> That report is what you attach to RUNBOOK.md §10 for sign-off. Use
> the hand-walked steps below when you need to debug a specific step
> or rerun one (`--step N` on the walker also works).
>
> First run only: `npx playwright install chromium` (≈170 MB into
> `~/.cache/ms-playwright/`).

### 0.A Prerequisites

1. Dev DB up: `npm run db:up && npm run db:migrate`.
2. Automated suite green: `npm run check`. **If this fails, stop.**
3. App running: `npm run dev`. Wait until you see `Server listening on
0.0.0.0:3030`.
4. Create one teacher and one pupil for the test:

   ```bash
   npm run user:create -- --role teacher --username htg_teacher \
     --display-name "HTG Teacher" --pseudonym TEA-HTG-01 \
     --password 'htg-teacher-pw-1'
   npm run user:create -- --role pupil --username htg_pupil \
     --display-name "HTG Pupil"   --pseudonym PUP-HTG-01 \
     --password 'htg-pupil-pw-1'
   ```

   (`user:create` is idempotent; safe to re-run. Passwords must be ≥12
   characters.)

### 0.B Steps

| #   | Action                                                                                                                     | Expected screen                                                                                                                                                                                                                                                                               | Expected DB                                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Open <http://localhost:3030/> in a fresh private window.                                                                   | Redirects to `/login`. Form shows "Sign in" with username + password fields.                                                                                                                                                                                                                  | —                                                                                                                                                                                                                                     |
| 2   | View source on `/login`.                                                                                                   | An `<input type="hidden" name="_csrf" value="...">` is present. The `Set-Cookie` response header set a `_csrf=...` cookie.                                                                                                                                                                    | —                                                                                                                                                                                                                                     |
| 3   | Submit the form **with no data**.                                                                                          | Browser blocks submission (HTML `required` attributes). A bare curl POST without a CSRF token + cookie is rejected by the CSRF middleware with HTTP 403. With a valid token+cookie but empty fields, the server re-renders `/login` with HTTP 400 and the flash "Please fill in both fields." | —                                                                                                                                                                                                                                     |
| 4   | Sign in as `htg_teacher` with the wrong password.                                                                          | Returns to `/login` with the red flash "Username or password is incorrect."                                                                                                                                                                                                                   | `audit_events` has a new row, `event_type='auth.login.failed'`, `details->>'reason'='bad_password'`.                                                                                                                                  |
| 5   | Sign in as `htg_teacher` with the correct password.                                                                        | Redirects to `/q/1`. Page title is "Question 1".                                                                                                                                                                                                                                              | `sessions` has a new row for the teacher's `user_id`. `audit_events` has `auth.login.ok`.                                                                                                                                             |
| 6   | Read the question card on `/q/1`.                                                                                          | Badges show `Question 1`, `1.1 · 1.1.1`, `describe`, `2 marks`. Stem reads "Inside the CPU is the Arithmetic Logic Unit (ALU)." Part (a) reads "Describe the purpose of the ALU. [2 marks]" with a textarea.                                                                                  | —                                                                                                                                                                                                                                     |
| 7   | Type a real answer in the textarea ("It performs arithmetic and logical operations on data.") and click **Submit answer**. | Redirects to `/q/1?saved=N` (where `N` is the new `attempts.id`). The green flash reads "Submitted. Saved as attempt #N." The textarea is empty again.                                                                                                                                        | `attempts` has 1 new row for the teacher (`submitted_at` not null, `mode='topic_set'`). `attempt_questions` has 1 new row referencing it. `attempt_parts` has 1 new row with the answer text. `audit_events` has `attempt.submitted`. |
| 8   | Open a second private window. Sign in as `htg_pupil`.                                                                      | Redirects to `/q/1`. **Pupil sees the question form, NOT the teacher's submitted answer.**                                                                                                                                                                                                    | —                                                                                                                                                                                                                                     |
| 9   | Submit a different answer as the pupil.                                                                                    | New `?saved=N` redirect with a different attempt id.                                                                                                                                                                                                                                          | New rows in `attempts`, `attempt_questions`, `attempt_parts` attributed to the pupil's `user_id`, **not** the teacher's.                                                                                                              |
| 10  | In a third window (still signed out), navigate directly to `/q/1`.                                                         | Redirects to `/login`.                                                                                                                                                                                                                                                                        | —                                                                                                                                                                                                                                     |
| 11  | Visit `/healthz`.                                                                                                          | JSON `{ "ok": true }`.                                                                                                                                                                                                                                                                        | —                                                                                                                                                                                                                                     |

### 0.C Reboot survival

| #   | Action                                                                        | Expected                                                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 12  | In `psql`, count attempts: `SELECT count(*) FROM attempts;`. Note the number. | At least 2 (teacher + pupil).                                                                                                                                                                                     |
| 13  | Stop everything: `Ctrl-C` the dev server, then `npm run db:down`.             | DB container stops.                                                                                                                                                                                               |
| 14  | Restart: `npm run db:up && npm run db:migrate && npm run dev`.                | App starts; `db:migrate` reports `0` pending migrations.                                                                                                                                                          |
| 15  | In `psql`, re-run the count from step 12.                                     | **Same number.** Data survived.                                                                                                                                                                                   |
| 16  | In the original teacher window, hit refresh.                                  | Either still on `/q/1` (session valid) or back to `/login` (session valid for 12 h, but cookie may be cleared by a private-window restart). Either is acceptable; just verify behaviour matches the cookie state. |

### 0.D Backup and restore drill

The drill itself is automated by `npm run db:restore-drill`, but a human
must run it once for sign-off and confirm the output.

| #   | Action                                          | Expected                                                                                                                                           |
| --- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 17  | `npm run db:backup`.                            | New file in `./tmp/backups/` named `exam_dev-<ts>.dump` with a sibling `.sha256`.                                                                  |
| 18  | `npm run db:restore-drill`.                     | Last line reads `PASS: N users, N questions, N parts, N audit events, N migrations (curriculum 2/11/26/29)`. The scratch DB is dropped at the end. |
| 19  | Record the run in [RUNBOOK.md](RUNBOOK.md) §10. | One line: date, initials, "First restore drill", `PASS — ...`.                                                                                     |

### 0.E Sign-off checklist

- [ ] All 19 steps above produced the expected result.
- [ ] `npm run check` green on the same commit you tested.
- [ ] Restore drill recorded in [RUNBOOK.md](RUNBOOK.md) §10.
- [ ] DPIA, privacy notice, acceptable-use statement signed off (out of
      scope for this guide; tracked in [RESOURCES_REQUIRED.md](RESOURCES_REQUIRED.md) §10).
- [ ] TLS approach decided and recorded in [RUNBOOK.md](RUNBOOK.md) §3.

---

## Phase 1 — Curated content model and a real revision loop

**Maps to:** [PLAN.md](PLAN.md) Phase 1 user test ("one real lesson with
the teacher's class. The teacher assigns a topic. Pupils complete it.
The teacher reviews submissions in the admin UI.").

Sections fill in chunk by chunk as Phase 1 ships
(see [PHASE1_PLAN.md](PHASE1_PLAN.md)). Chunk 1 (classes and
enrolments) is below; the rest land as the chunks ship.

### 1.A Classes and enrolments (Chunk 1)

**Prereqs:** dev DB up + migrated, app running, `npm run check` green.
Two extra fixture users for this walk-through:

```bash
npm run user:create -- --role teacher --username cls_teach_a \
  --display-name "Teacher Alpha" --pseudonym TEA-CLS-A \
  --password 'cls-teach-a-pw-1'
npm run user:create -- --role teacher --username cls_teach_b \
  --display-name "Teacher Beta"  --pseudonym TEA-CLS-B \
  --password 'cls-teach-b-pw-1'
npm run user:create -- --role pupil   --username cls_pupil_1 \
  --display-name "Pupil One"     --pseudonym PUP-CLS-01 \
  --password 'cls-pupil-1-pw-1'
```

| #   | Action                                                                                                                                 | Expected                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | While signed out, visit `/admin/classes`.                                                                                              | Redirects to `/login`.                                                                                                                                                             |
| 2   | Sign in as `cls_pupil_1`. Visit `/admin/classes`.                                                                                      | HTTP 403 ("Forbidden"). Pupils have no classes nav.                                                                                                                                |
| 3   | Sign in as `cls_teach_a`. Visit `/admin/classes`.                                                                                      | Empty state: "No classes yet." A "New class" button is visible.                                                                                                                    |
| 4   | Click **New class**. Submit `name="10A Computing"`, `academic_year="2025/26"`.                                                         | Redirects to `/admin/classes/<id>` showing the class header, an enrol form, and "No pupils enrolled yet". `audit_events` has `class.created` for `cls_teach_a`.                    |
| 5   | Try to create another class with the **same** name + year.                                                                             | HTTP 409 with the flash "You already have a class with that name for that year." The form preserves your typed values.                                                             |
| 6   | Back on the detail page, enrol `cls_pupil_1` by username.                                                                              | Redirects to the same page with the green flash "Enrolled Pupil One." The pupils table shows their display name, username, pseudonym, and enrolment date. `enrolments` row exists. |
| 7   | Try to enrol the same username again.                                                                                                  | Flash reads "Pupil One is already enrolled." `enrolments` still has exactly one row for that pair (no duplicate).                                                                  |
| 8   | Try to enrol a non-existent username (`nope_pupil`).                                                                                   | Flash reads "No active pupil with that username."                                                                                                                                  |
| 9   | Try to enrol a teacher username (`cls_teach_b`).                                                                                       | Same flash as step 8 — only active pupils are eligible.                                                                                                                            |
| 10  | In a second private window, sign in as `cls_teach_b`. Visit `/admin/classes`.                                                          | Empty state — Teacher Beta does **not** see Teacher Alpha's class.                                                                                                                 |
| 11  | As Teacher Beta, paste the URL from step 4 (`/admin/classes/<alpha_class_id>`) directly.                                               | HTTP 403. Teachers are isolated.                                                                                                                                                   |
| 12  | Back as Teacher Alpha, click **Remove** next to Pupil One.                                                                             | Redirects with the flash "Pupil removed from class." The pupils table reverts to the empty state. `enrolments` row gone. `audit_events` has `enrolment.removed`.                   |
| 13  | (Optional) If an admin user exists, sign in as admin and visit `/admin/classes`.                                                       | The list shows all teachers' classes with a Teacher column ("Teacher Alpha (cls_teach_a)" etc.). Admin can open Alpha's class detail page without 403.                             |
| 14  | In `psql`, `SELECT event_type, count(*) FROM audit_events WHERE event_type LIKE 'class%' OR event_type LIKE 'enrolment%' GROUP BY 1;`. | Counts match what you did: at least one `class.created`, one `enrolment.added`, one `enrolment.removed`.                                                                           |

### Sign-off checklist (Chunk 1)

- [ ] All 14 steps above produced the expected result.
- [ ] `npm run check` green on the same commit.
- [ ] No console errors in the dev server log during the walk-through.

### Phase 1 sign-off checklist

- [ ] (Filled in once all chunks ship.)

---

## Phase 2 — OCR-style presentation and objective marking polish

**Maps to:** [PLAN.md](PLAN.md) Phase 2 user test ("full revision lesson.
... does it feel like an exam? Are the answer boxes the right size? Is
the feedback panel useful?").

### Stub — to be filled in when Phase 2 ships

Will need to cover:

- Visual fidelity to OCR paper layout (header, marks-in-margin,
  line-ruled answer space sized to mark tariff).
- Each question type renders correctly (tick-box, short text, medium
  text, extended response, code/algorithm input).
- Optional countdown timer behaves on tab switch / device sleep.
- Autosave on blur and at the configured interval.
- "Submit and review" page, including model answer for objective items.
- Print-to-PDF round-trip.
- Accessibility pass: keyboard-only, screen reader, contrast, dyslexia
  font, colour-blindness sim.

### Sign-off checklist

- [ ] (Filled in during Phase 2.)

---

## Phase 3 — LLM-assisted marking with full audit trail

**Maps to:** [PLAN.md](PLAN.md) Phase 3 user test ("pilot with one topic
and one class. The teacher marks the same answers in parallel for the
first week. ... investigate every disagreement.").

### Stub — to be filled in when Phase 3 ships

Will need to cover:

- Marking pipeline end-to-end on a known answer; verify deterministic
  pre-checks fire (empty / too short / contradictory).
- Structured Output JSON validates against the versioned schema; raw
  response stored in audit table.
- Low-confidence answer correctly routes to moderation queue.
- Teacher overrides recorded in audit table with reason.
- Pupil-facing feedback follows the "What went well / How to gain more
  marks / Next time…" shape and the Year-10-reading-level cap.
- Cost dashboard reflects a real call within ±10% of the OpenAI
  invoice for the same window.
- **Kill switch test:** flip `LLM_ENABLED=false`, restart, confirm no
  outbound HTTPS to `api.openai.com` (check egress logs / firewall) and
  the UI shows "your teacher will mark this".
- Hard rule: every AI-marked response visible to a pupil bears the
  "marked with AI assistance — your teacher will check" label.

### Sign-off checklist

- [ ] (Filled in during Phase 3.)

---

## Phase 4 — Adaptive sequencing

**Maps to:** [PLAN.md](PLAN.md) Phase 4 user test ("A/B test on the
teacher's class: half adaptive, half fixed, swapped halfway.").

### Stub — to be filled in when Phase 4 ships

Will need to cover:

- Mastery scores update as a pupil answers; check the recency and
  confidence weighting on a known sequence.
- Selector mix (70/20/10) holds across a 30-question session.
- Frustration-protection: walk three consecutive failures and confirm
  the next question drops a band.
- Teacher view of one pupil's mastery profile is readable in <30 s.

### Sign-off checklist

- [ ] (Filled in during Phase 4.)

---

## Phase 5 — AI question generation with teacher approval

**Maps to:** [PLAN.md](PLAN.md) Phase 5 user test ("generate a batch of
30 questions. Time approval/edit/reject. Sample 10 against the spec.").

### Stub — to be filled in when Phase 5 ships

Will need to cover:

- Generation produces a full question package (stem, parts, marks, model
  answer, mark points, misconceptions, command word, topic mapping).
- Validator pass rejects obvious errors (wrong command word, wrong
  topic, hallucinated mark scheme).
- Embedding-similarity check rejects near-duplicates of source paper
  text. Walk one positive example and one negative.
- Teacher approval queue UX: read, edit, approve, reject in <60s per
  question on a small batch.
- "Generated from" provenance is preserved on the resulting question
  record.

### Sign-off checklist

- [ ] (Filled in during Phase 5.)

---

## Phase 6 — Teacher analytics and misconception intelligence

**Maps to:** [PLAN.md](PLAN.md) Phase 6 user test ("Teacher uses only
the dashboard to plan the next lesson.").

### Stub — to be filled in when Phase 6 ships

Will need to cover:

- Class heatmap renders for a real class with at least one full
  topic-set of attempts.
- Command-word weakness view surfaces a real gap (cross-check by hand
  against the underlying responses).
- "Most missed mark points this week" cites real example responses.
- Misconception clusters have teacher-editable labels that persist.
- Printable PDF and CSV export round-trip cleanly.

### Sign-off checklist

- [ ] (Filled in during Phase 6.)

---

## Phase 7 — Hardening, paper mode, and department rollout

**Maps to:** [PLAN.md](PLAN.md) Phase 7 user test ("Whole-cohort mock
under classroom conditions across multiple devices and browsers.").

### Stub — to be filled in when Phase 7 ships

Will need to cover:

- Paper builder produces a paper that matches the teacher-specified
  component / topic mix / total marks / duration.
- Mock exam mode: no feedback shown until the end; timer cannot be
  paused; submission is hard-final.
- Multi-teacher: a second teacher's class data is invisible to the
  first; shared question bank is visible to both.
- Bulk pupil import from a CSV (with deliberately malformed rows in the
  test fixture).
- Account reset flow round-trip.
- Retention policy: a marked-inactive pupil's data is purged after the
  configured window.
- Per-class API budget and alerts fire under simulated overspend.
- Slowest school device under simultaneous use by one full class
  remains usable.

### Sign-off checklist

- [ ] (Filled in during Phase 7.)
