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

- [x] All 19 steps above produced the expected result.
- [x] `npm run check` green on the same commit you tested.
- [x] Restore drill recorded in [RUNBOOK.md](RUNBOOK.md) §10.
- [x] DPIA, privacy notice, acceptable-use statement signed off (out of
      scope for this guide; tracked in [RESOURCES_REQUIRED.md](RESOURCES_REQUIRED.md) §10).
- [x] TLS approach decided and recorded in [RUNBOOK.md](RUNBOOK.md) §3.

---

## Phase 1 — Curated content model and a real revision loop

**Maps to:** [PLAN.md](PLAN.md) Phase 1 user test ("one real lesson with
the teacher's class. The teacher assigns a topic. Pupils complete it.
The teacher reviews submissions in the admin UI.").

Sections fill in chunk by chunk as Phase 1 ships
(see [PHASE1_PLAN.md](PHASE1_PLAN.md)). Chunk 1 (classes and
enrolments) is below; the rest land as the chunks ship.

> **Prefer the automated walker.** `npm run test:human:phase1` runs the
> Phase 1 sign-off end-to-end:
>
> - HTTP-only checks (steps 1-3) → curl + assert, no prompt
> - browser flows (steps 4-19) → headless Chromium via Playwright,
>   driving teacher login → class create → enrol pupil → assign topic →
>   author + approve a new question; then pupil login → start a topic
>   set → partial save → logout/re-login → submit → see review page;
>   then teacher override and the pupil re-render that reflects it
> - DB cross-check (step 20) → audit_events counts since the run
>   started, plus an `awarded_marks` row check for the overridden part
> - RUNBOOK.md entry (step 21) → reminder + human PASS/FAIL only
>
> A timestamped markdown report is written to
> `tmp/human-tests/phase1-<utc-ts>.md` containing every captured
> stdout/stderr, the per-step verdicts, and links to any Playwright
> failure screenshots in `tmp/human-tests/phase1-<utc-ts>-screenshots/`.
> That report is what you attach to RUNBOOK.md §10 for sign-off. The
> walker is idempotent: re-running on the same day reuses the existing
> `Phase1 Walker <date>` class and pupil enrolment rather than failing
> on the unique constraint.
>
> First run only: `npx playwright install chromium` (≈170 MB into
> `~/.cache/ms-playwright/`).

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

### 1.B Question authoring — read side (Chunk 2)

**Prereqs:** dev DB up + migrated (the Phase 0 seed question is present),
app running, `npm run check` green. Reuses the fixture users from §1.A
(`cls_teach_a`, `cls_pupil_1`); no extra accounts needed.

| #   | Action                                                                                                                    | Expected                                                                                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | While signed out, visit `/admin/questions`.                                                                               | Redirects to `/login`.                                                                                                                                                                                                                                                                                                          |
| 2   | Sign in as `cls_pupil_1`. Visit `/admin/questions`.                                                                       | HTTP 403. The admin nav is not shown to pupils.                                                                                                                                                                                                                                                                                 |
| 3   | Sign in as `cls_teach_a`. Visit `/admin/questions`.                                                                       | Table lists the seed question: id `1`, topic `1.1 Systems architecture`, subtopic `1.1.1`, command word `describe`, `2` marks, approval `approved`, active `yes`, created by `Phase 0 Seed (system)`. The stem column starts with "Inside the CPU is the Arithmetic Logic Unit". An **Open** link targets `/admin/questions/1`. |
| 4   | Confirm the filter bar at the top of the list.                                                                            | Three `GET` inputs: a **Topic** `<select>` grouped by component (J277/01 first, then J277/02) with "All topics" as the default option; an **Approval status** `<select>` with the five statuses; an **Active** `<select>` ("All / Yes / No"). An **Apply** submit button is visible.                                            |
| 5   | Set **Topic** to `1.2 Memory and storage` and apply.                                                                      | URL becomes `/admin/questions?topic=1.2`. Table shows the empty-state row (no seed question under 1.2). The topic select stays on the chosen value.                                                                                                                                                                             |
| 6   | Clear the topic filter. Set **Approval status** to `draft` and apply.                                                     | URL becomes `/admin/questions?approval_status=draft`. Seed question (which is `approved`) is not listed. Empty state shown.                                                                                                                                                                                                     |
| 7   | Reset all filters (visit `/admin/questions` directly).                                                                    | Seed question is visible again.                                                                                                                                                                                                                                                                                                 |
| 8   | Click **Open** on the seed question.                                                                                      | Lands on `/admin/questions/1`. Header reads "Question #1" with the topic + subtopic strip. Meta grid shows command word `describe`, archetype, expected response `short_text`, marks `2`, difficulty, source `curriculum_curated` (or similar), approval `approved · approved by Phase 0 Seed (system)`, active `yes`.          |
| 9   | Scroll to **Stem** and **Model answer**.                                                                                  | Stem matches what the pupil sees on `/q/1`. Model answer is a non-empty blockquote.                                                                                                                                                                                                                                             |
| 10  | Scroll to **Parts**.                                                                                                      | One part card, label `(a)`, badge `2 marks · short_text`, prompt "Describe the purpose of the ALU." A **Mark points** ordered list has exactly two entries in display order; each has a "1 mark" meta line. No part-level misconceptions are rendered (none seeded).                                                            |
| 11  | Scroll to the bottom.                                                                                                     | If the 1.1 topic has any curriculum-seeded **Topic-level misconceptions**, they render as a labelled list. Otherwise the section is absent (not an empty heading).                                                                                                                                                              |
| 12  | Visit `/admin/questions/999999`.                                                                                          | HTTP 404.                                                                                                                                                                                                                                                                                                                       |
| 13  | Visit `/admin/questions/not-a-number`.                                                                                    | HTTP 404 (route rejects non-numeric ids before hitting the DB).                                                                                                                                                                                                                                                                 |
| 14  | In `psql`, run `SELECT count(*) FROM audit_events WHERE event_type LIKE 'question.%';` before and after the walk-through. | Count is unchanged — reads are deliberately not audited in Chunk 2.                                                                                                                                                                                                                                                             |

### Sign-off checklist (Chunk 2)

- [ ] All 14 steps above produced the expected result.
- [ ] `npm run check` green on the same commit.
- [ ] No console errors in the dev server log during the walk-through.
- [ ] The **Questions** nav item is highlighted when on `/admin/questions*`.

### 1.C Question authoring — write side (Chunk 3)

**Prereqs:** dev DB up + migrated, app running, `npm run check` green.
Reuses the fixture users from §1.A (`cls_teach_a`, `cls_teach_b`,
`cls_pupil_1`). If an admin user exists, steps 13–14 below will exercise
the admin-override path; otherwise skip them.

Keep a `psql` window open alongside the browser to verify audit events
as you go:

```sql
SELECT event_type, count(*) FROM audit_events
WHERE event_type LIKE 'question.%' GROUP BY 1 ORDER BY 1;
```

Note the baseline counts before step 1; each action below should bump
exactly one counter.

| #   | Action                                                                                                                                                                                                                                                                                                                                                                                                                                    | Expected                                                                                                                                                                                                                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Sign in as `cls_pupil_1`. Visit `/admin/questions/new`.                                                                                                                                                                                                                                                                                                                                                                                   | HTTP 403. Pupils have no author access.                                                                                                                                                                                                                                                                                   |
| 2   | Sign in as `cls_teach_a`. From `/admin/questions`, click **New question**.                                                                                                                                                                                                                                                                                                                                                                | Lands on `/admin/questions/new`. The form title reads "New question". Classification selects (component, topic, subtopic, command word, archetype) are populated. One blank part card labelled `(a)` is present with one blank mark point.                                                                                |
| 3   | Submit the form with every field empty.                                                                                                                                                                                                                                                                                                                                                                                                   | Re-renders with HTTP 400 and the flash "Please fix the highlighted fields." An issue summary at the top lists paths such as `component_code`, `stem`, `parts.0.prompt`, `parts.0.mark_points.0.text`. Typed values (the blank ones) are preserved.                                                                        |
| 4   | Fill in a real question: component `J277/01`, topic `1.1 Systems architecture`, subtopic `1.1.1`, command word `describe`, archetype `explain`, stem "Describe what a CPU does.", expected response `short_text`, model answer "A CPU fetches, decodes and executes instructions.", difficulty band `3`, step `1`. In part `(a)`, prompt "Name one CPU register.", marks `1`, add one mark point text "Program Counter" (1 mark). Submit. | Redirects to `/admin/questions/<new_id>?flash=Draft+created.`. Detail page shows status `draft`, active `no`, created by "Teacher Alpha". `audit_events` gained one `question.created` row. In `psql`: `SELECT approval_status, active, created_by FROM questions WHERE id = <new_id>;` shows `draft / f / <teacher_id>`. |
| 5   | On the detail page, click **Edit**.                                                                                                                                                                                                                                                                                                                                                                                                       | Lands on `/admin/questions/<id>/edit` with every field pre-populated. The title reads "Edit question · <id>". The parts list shows exactly the part you saved, not an extra blank one.                                                                                                                                    |
| 6   | Click **Add part**. A second card appears with label `(b)`. Set prompt "State the purpose of the ALU.", marks `2`. Add two mark points: "Performs arithmetic operations" (1 mark), "Performs logical operations" (1 mark, tick **required**). Submit.                                                                                                                                                                                     | Redirects with "Draft updated." The detail page now shows two parts, `(a)` and `(b)`, with total marks `3`. Mark point "Performs logical operations" renders with the "· required" suffix. One new `question.updated` audit row.                                                                                          |
| 7   | Edit again. Remove part `(b)` with its **Remove part** button. Submit.                                                                                                                                                                                                                                                                                                                                                                    | Detail page shows one part, total marks `1`. A second `question.updated` audit row is written. In `psql`: `SELECT count(*) FROM question_parts WHERE question_id = <id>;` returns `1` (the orphaned mark points cascaded away).                                                                                           |
| 8   | Back on the detail page, click **Approve**.                                                                                                                                                                                                                                                                                                                                                                                               | Redirects with "Question approved." Meta grid now shows approval `approved · approved by Teacher Alpha` and active `yes`. The Approve/Reject buttons are gone. One new `question.approved` audit row.                                                                                                                     |
| 9   | Click **Edit** on the approved question and change the stem to "Describe the function of the CPU." Submit.                                                                                                                                                                                                                                                                                                                                | The change is accepted (an admin/owner may still correct an approved question's text). The detail page shows the new stem and approval remains `approved`. One new `question.updated` audit row. The question is still active.                                                                                            |
| 10  | Create a second draft via the New question form (any valid minimal content; e.g. stem "Explain what RAM is for."). On its detail page, the approval block now offers **Approve** only (no Reject — there is no pending_review state from draft).                                                                                                                                                                                          | Draft visible at `/admin/questions?approval_status=draft`. Approve and Reject buttons behave per the state machine: **Approve** is present; **Reject** only appears once the status is `pending_review`.                                                                                                                  |
| 11  | Sign in as `cls_teach_b` in a second private window. Visit `/admin/questions/<teacher_a_question_id>/edit` directly.                                                                                                                                                                                                                                                                                                                      | HTTP 403. Teachers cannot edit another teacher's drafts. Also visit `/admin/questions/<id>` — reads are allowed (admin list is shared), but the Edit/Approve/Reject controls do not write.                                                                                                                                |
| 12  | As Teacher Beta, POST directly to `/admin/questions/<teacher_a_id>/approve` (e.g. via a fresh form submission).                                                                                                                                                                                                                                                                                                                           | HTTP 403. `audit_events` gains nothing.                                                                                                                                                                                                                                                                                   |
| 13  | (Optional — admin only.) Sign in as an admin user. Visit Teacher Alpha's draft `/admin/questions/<teacher_a_id>/edit`.                                                                                                                                                                                                                                                                                                                    | Form opens. Submit any minor edit; redirect succeeds. Audit row `question.updated` has the admin's `actor_id`.                                                                                                                                                                                                            |
| 14  | (Optional — admin only.) From the admin's detail page of a teacher-owned draft, click **Approve**.                                                                                                                                                                                                                                                                                                                                        | Redirects with "Question approved." `question.approved` audit row records the admin as actor; the question's `approved_by` column is the admin's id.                                                                                                                                                                      |
| 15  | As Teacher Alpha again, open the approved question from step 8 and attempt to move it back to `pending_review` by submitting a reject form (e.g. craft a POST to `/admin/questions/<id>/reject` with a reason).                                                                                                                                                                                                                           | Redirects with a flash starting "Cannot move a approved question to …". No audit row written; DB state unchanged. The state machine blocks illegal transitions.                                                                                                                                                           |
| 16  | Submit the reject form on a `pending_review` question with a **blank** reason.                                                                                                                                                                                                                                                                                                                                                            | Redirects with "A reject reason is required." The question stays in `pending_review`; no audit row.                                                                                                                                                                                                                       |
| 17  | Submit the reject form with a real reason (e.g. "Mark scheme incomplete.").                                                                                                                                                                                                                                                                                                                                                               | Redirects with "Question rejected." Meta grid shows approval `rejected`, active `no`, and the reason appears under **Review notes**. One `question.rejected` audit row.                                                                                                                                                   |
| 18  | Re-run the audit query from the prereq block.                                                                                                                                                                                                                                                                                                                                                                                             | Counts bumped exactly: `question.created` +2 (steps 4 and 10), `question.updated` +3 or +4 (steps 6, 7, 9, plus optional admin step 13), `question.approved` +1 or +2 (step 8 plus optional 14), `question.rejected` +1 (step 17). Every write you did maps to exactly one row.                                           |
| 19  | Attempt a write without a CSRF token (e.g. `curl -X POST http://localhost:3030/admin/questions -d 'stem=x'`).                                                                                                                                                                                                                                                                                                                             | HTTP 403 from the CSRF prevalidation hook. Nothing reaches the service.                                                                                                                                                                                                                                                   |

### Sign-off checklist (Chunk 3)

- [ ] All 19 steps above produced the expected result (13–14 skipped if
      no admin user exists).
- [ ] `npm run check` green on the same commit.
- [ ] No console errors in the dev server log during the walk-through.
- [ ] Every write triggered exactly one audit row; no reads wrote audit
      rows.
- [ ] State-machine violations (step 15) and authorisation failures
      (steps 1, 11, 12) left the DB unchanged.

### 1.D Pupil topic-set flow (Chunk 5)

**Prereqs:** dev DB up + migrated (0008 applied), app running,
`npm run check` green. Reuses the fixture users from §1.A
(`cls_teach_a`, `cls_pupil_1`). Also reuses the approved question from
§1.C (a short-text ALU question on topic `1.1`) — if §1.C has not been
walked through, approve at least one active question on topic `1.1`
first, otherwise the pupil will get "no approved questions".

Keep a `psql` window open:

```sql
SELECT event_type, count(*) FROM audit_events
WHERE event_type IN ('attempt.started', 'attempt.part.saved',
                     'attempt.submitted', 'marking.completed',
                     'class.topic.assigned', 'class.topic.unassigned')
GROUP BY 1 ORDER BY 1;
```

Note the baseline counts before step 1.

| #   | Action                                                                                                                                                                            | Expected                                                                                                                                                                                                                                                                                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Sign in as `cls_teach_a`. Open the class detail page for "10A Computing". Under **Assigned topics** you should see "No topics assigned yet" and an **Assign topic** select below. | Empty state renders; the select lists every seeded topic grouped by component.                                                                                                                                                                                                                                                                 |
| 2   | Pick `1.1 Systems architecture` from the select and click **Assign**.                                                                                                             | Redirects with the flash "Topic 1.1 assigned." The assigned-topics table now lists the row with Teacher Alpha as the assigner. `audit_events` gained one `class.topic.assigned` row.                                                                                                                                                           |
| 3   | Click **Assign** again after re-selecting `1.1`.                                                                                                                                  | Flash reads "Topic 1.1 was already assigned." No new audit row, no duplicate DB row.                                                                                                                                                                                                                                                           |
| 4   | Make sure `cls_pupil_1` is enrolled in "10A Computing" (re-run §1.A step 6 if you removed them in step 12).                                                                       | `enrolments` has the class/pupil pair.                                                                                                                                                                                                                                                                                                         |
| 5   | Sign out and sign in as `cls_pupil_1`. You should land on `/topics`.                                                                                                              | The topics page lists the assigned `1.1 · Systems architecture` row with a **Start attempt** button. No other topics appear.                                                                                                                                                                                                                   |
| 6   | Click **Start attempt**.                                                                                                                                                          | Redirects to `/attempts/<id>` showing one or more question cards (up to `topic_set_size`, default 8). Each part has an empty textarea. `audit_events` gained one `attempt.started` row; `attempts` table has a row with `submitted_at = NULL`.                                                                                                 |
| 7   | Type an answer into the first part (e.g. "Arithmetic Logic Unit"). Click **Save progress**.                                                                                       | Redirects back to the same attempt URL with "Saved 1 answer." The textarea still shows your text on reload. `audit_events` gained one `attempt.part.saved` row.                                                                                                                                                                                |
| 8   | Close the browser tab. Reopen `/attempts/<id>` (or navigate from `/topics` by starting again — no, just revisit the URL from history).                                            | The same answer is present. The attempt is still editable (no review banner).                                                                                                                                                                                                                                                                  |
| 9   | Click **Submit attempt**.                                                                                                                                                         | Redirects to the same `/attempts/<id>` URL, which now renders the review view: a "Score: X / Y" line, each part labelled with its awarded/total marks (or "pending" for open-response parts), and mark-point hit/miss bullets for objective parts that matched. `audit_events` gained one `attempt.submitted` and one `marking.completed` row. |
| 10  | Refresh `/attempts/<id>`.                                                                                                                                                         | Same review view (not the editor). Attempt is terminal.                                                                                                                                                                                                                                                                                        |
| 11  | POST to `/attempts/<id>/save` (e.g. via browser devtools or `curl` with cookies) attempting to change a part's answer.                                                            | HTTP 302 redirect with flash "Attempt already submitted." `attempt_parts.raw_answer` is unchanged in the DB.                                                                                                                                                                                                                                   |
| 12  | Grab the attempt URL from step 6. In a second private window sign in as a different pupil (create one if needed) and paste the attempt URL.                                       | HTTP 403. Cross-pupil access is forbidden.                                                                                                                                                                                                                                                                                                     |
| 13  | As `cls_teach_a`, visit the same attempt URL.                                                                                                                                     | HTTP 403. Teachers are not owners (admin override would work — optional step 15).                                                                                                                                                                                                                                                              |
| 14  | As `cls_teach_a`, go to `/admin/classes/<class_id>` and click **Remove** next to the assigned `1.1` topic.                                                                        | Redirects with "Topic 1.1 removed." The assigned-topics table reverts to empty. `audit_events` gained one `class.topic.unassigned` row. The pupil's existing attempt is untouched (assignment removal is forward-looking).                                                                                                                     |
| 15  | (Optional — admin only.) Sign in as an admin and open the pupil's attempt URL from step 6.                                                                                        | The review page renders; `class_assigned_topics` removal does not break historic attempts.                                                                                                                                                                                                                                                     |
| 16  | As `cls_pupil_1`, visit `/topics` again.                                                                                                                                          | The list is empty now ("No topics have been assigned to your class yet.") because `1.1` was unassigned in step 14.                                                                                                                                                                                                                             |
| 17  | Attempt a write without a CSRF token (e.g. `curl -X POST http://localhost:3030/topics/1.1/start` with no `_csrf`).                                                                | HTTP 403 from the CSRF prevalidation hook. No attempt row created.                                                                                                                                                                                                                                                                             |
| 18  | Re-run the audit query from the prereq block.                                                                                                                                     | Counts bumped exactly: `class.topic.assigned` +1 (step 2), `class.topic.unassigned` +1 (step 14), `attempt.started` +1 (step 6), `attempt.part.saved` +1 (step 7), `attempt.submitted` +1 (step 9), `marking.completed` +1 (step 9).                                                                                                           |

### Sign-off checklist (Chunk 5)

- [ ] All 18 steps above produced the expected result (15 skipped if no
      admin user exists).
- [ ] `npm run check` green on the same commit.
- [ ] No console errors in the dev server log during the walk-through.
- [ ] Every write triggered exactly one audit row; no reads wrote audit
      rows.
- [ ] Objective parts received a deterministic mark; open-response
      parts (medium/extended/code/algorithm/trace table) appeared as
      "pending" and did **not** produce `awarded_marks` rows.
- [ ] Cross-pupil and teacher-without-admin access returned 403
      (steps 12 and 13).

### 1.E Pupil review screen (Chunk 6)

**Prereqs:** dev DB up + migrated, app running, `npm run check` green.
Assumes §1.D has already been walked through to the point where
`cls_pupil_1` has a submitted attempt with both an objective part and
an open-response part on topic `1.1`. If not, author and approve a
two-part question on `1.1` first: part `(a)` is `multiple_choice` with
one `CPU`-style mark point, part `(b)` is `extended_response` with a
rubric mark point whose text contains the marker string
`RUBRIC-LEAK-CHECK` so step 6 is easy to grep for.

| #   | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Expected                                                                                                                                                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Sign in as `cls_pupil_1`. Open the submitted attempt from §1.D step 9 (or a fresh submission per the prereqs).                                                                                                                                                                                                                                                                                                                                                                    | Page renders the review view (not the editor). Header reads `Attempt <id> · review`. A **Back to topics** link is visible.                                                                                                                       |
| 2   | Read the overall score line.                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `Score: X / Y` matches the sum of awarded / total across every part. If any open-response part is unmarked, the line also says `· N part(s) awaiting teacher marking`.                                                                           |
| 3   | For each question card, read the per-question score badge.                                                                                                                                                                                                                                                                                                                                                                                                                        | Shows `Question score: <awarded> / <possible>`. Pending parts on that question appear as `· N pending` in the same badge.                                                                                                                        |
| 4   | Find the objective part `(a)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                    | The part shows `<awarded> / <marks>`, your typed answer in a `<pre>` block, and a **Model answer:** section listing every mark point. Each bullet has a ✓ or ✗ depending on whether your answer matched it.                                      |
| 5   | Find the open-response part `(b)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                | See **Chunk 6 refinement** note after this table. There is NO **Model answer:** section on this part.                                                                                                                                            |
| 6   | View page source (Ctrl-U). Search for `RUBRIC-LEAK-CHECK`.                                                                                                                                                                                                                                                                                                                                                                                                                        | Marker appears inside the **Marking criteria** bullet — intentional; see note below.                                                                                                                                                             |
| 7   | Sign out. Sign in as a different pupil (`cls_pupil_2` or create one) and paste the URL from step 1.                                                                                                                                                                                                                                                                                                                                                                               | HTTP 403. The review page is not visible to other pupils.                                                                                                                                                                                        |
| 8   | Sign out. Sign in as `cls_teach_a` and paste the URL from step 1.                                                                                                                                                                                                                                                                                                                                                                                                                 | HTTP 403. A teacher is not the owner of the attempt (Chunk 7 will add the teacher's own review entry point).                                                                                                                                     |
| 9   | (Optional — admin only.) Sign in as an admin and open the URL from step 1.                                                                                                                                                                                                                                                                                                                                                                                                        | The review renders in full, including the objective model answer bullets.                                                                                                                                                                        |
| 10  | Open the dev tools **Network** tab and refresh the review page.                                                                                                                                                                                                                                                                                                                                                                                                                   | Single `GET /attempts/<id>` returning 200. No XHR to any `/admin/*` endpoint. No console errors.                                                                                                                                                 |
| 11  | Confirm nothing teacher-only leaked anywhere on the page.                                                                                                                                                                                                                                                                                                                                                                                                                         | No `approval_status`, `created_by`, `source_type`, `similarity_hash`, or `difficulty_band` strings appear. No raw SQL, no stack traces, no "Internal server error". Only the topic/subtopic/command-word badges are shown as question metadata.  |
| 12  | If §1.D left the open-response part pending, simulate a teacher override by running this psql snippet (replace `<attempt_part_id>` with the `(b)` part id): `INSERT INTO awarded_marks (attempt_part_id, marks_awarded, marks_total, mark_points_hit, mark_points_missed, marker, moderation_status) SELECT id, 4, marks, ARRAY[]::bigint[], ARRAY[]::bigint[], 'teacher_override', 'not_required' FROM attempt_parts WHERE id = <attempt_part_id>;` then reload the review page. | Part `(b)` now shows `4 / <marks>` but still does NOT render the **Model answer:** block — model answers are only shown for objective parts marked deterministically. The overall and per-question score rollups update to include the override. |

**Chunk 6 refinement (2026-04-17).** For an open-response part that the
pupil has submitted but the teacher has not yet marked, the pupil now
sees: `pending / <marks>`, the phrase **"Teacher to mark."**, a
**Marking criteria:** bullet list (the mark-point text, without
teacher-only decoration like `required` badges beyond the existing
muted tag), and a **Your self-estimate (0–<marks>)** number input with
a **Save estimate** button. This is intentional — once the part is
locked in, the pupil benefits from seeing the criteria and recording
what they think they earned. The teacher view shows the pupil's
self-estimate alongside the teacher mark form. The original "Your
teacher will mark this — come back later." copy is retained only for
the pre-submission state (in-progress questions in per-question mode).
`RUBRIC-LEAK-CHECK` therefore _will_ appear in the pupil DOM for a
submitted-but-unmarked part; to verify the old leak-proofing, inspect
a not-yet-submitted attempt instead.

### Sign-off checklist (Chunk 6)

- [ ] All 12 steps above produced the expected result (9 and 12 skipped
      if no admin user / no psql access).
- [ ] Overall score, per-question score, and per-part awarded/pending
      labels were all consistent (the three totals added up).
- [ ] Pending parts showed exactly **"Teacher to mark."** followed by
      the **Marking criteria:** list and the self-estimate form, with
      no other teacher-only details (approval status, similarity hash,
      etc.).
- [ ] Model-answer bullets appeared only on objective parts that were
      deterministically marked (step 4 showed them; steps 5 and 12 did
      not).
- [ ] Cross-pupil and teacher-without-admin access were both 403.
- [ ] Source-view grep for `RUBRIC-LEAK-CHECK` returned zero matches.
- [ ] `npm run check` green on the same commit.

### 1.F Teacher review UI and mark override (Chunk 7)

**Prereqs:** dev DB up + migrated (0009 applied), app running,
`npm run check` green. Reuses the fixture users from §1.A / §1.D.
Assumes `cls_teach_a` owns a class (`10A Computing`) with
`cls_pupil_1` enrolled and topic `1.1` assigned; if §1.D ended with
`1.1` unassigned, re-assign it before step 1. The pupil must submit a
fresh attempt for this walk-through that contains **at least one
open-response part** (e.g. `extended_response`) and one objective part
(e.g. `multiple_choice`). If the only approved `1.1` question is a
single short-text part, author and approve a new two-part question
first (part `(a)` `multiple_choice` with a `CPU`-style mark point,
part `(b)` `extended_response` with a rubric mark point whose text
contains the marker string `RUBRIC-LEAK-CHECK`).

Keep a `psql` window open:

```sql
SELECT event_type, count(*) FROM audit_events
WHERE event_type = 'marking.override' GROUP BY 1;
```

Note the baseline count before step 1.

| #   | Action                                                                                                                                                                                            | Expected                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | As `cls_pupil_1`, start and submit a fresh attempt on topic `1.1` covering the two-part question described in the prereqs. Answer the MC part correctly (`CPU`) and the open part with any prose. | Review page shows `Score: 1 / 7 · 1 part awaiting teacher marking`. The open-response part reads `pending / 6` with "Your teacher will mark this — come back later." Note the attempt id (`/attempts/<id>`).                                                                                            |
| 2   | Sign out. Sign in as `cls_teach_a`. Visit `/admin/classes/<class_id>`.                                                                                                                            | Class detail renders. In the header actions, a **Submissions** link is visible next to **Back to classes**.                                                                                                                                                                                             |
| 3   | Click **Submissions**.                                                                                                                                                                            | Lands on `/admin/classes/<class_id>/attempts`. Table shows one row: pupil display name ("Pupil One" + pseudonym), topic `1.1`, submitted timestamp, `Parts marked` column showing `1/2` with a `1 pending` badge, **Mark** link.                                                                        |
| 4   | Click **Mark**.                                                                                                                                                                                   | Lands on `/admin/attempts/<id>`. Header reads `Attempt <id> · mark`. Summary line reads `Current score: 1 / 7 · 1 part awaiting your mark`. Both question parts render with pupil answer in a `<pre>` block. Each part has an inline **Mark scheme** `<details>` disclosure and a **Save mark** form.   |
| 5   | On the objective `(a)` part, open the **Mark scheme** disclosure.                                                                                                                                 | The matched mark point (`CPU`) shows with a `✓` and the `mp--hit` style. Any unmatched mark points show with `·` and `mp--miss`.                                                                                                                                                                        |
| 6   | On the open-response `(b)` part, open the **Mark scheme** disclosure.                                                                                                                             | All rubric mark points render with `·` (miss — nothing has been awarded yet). The `RUBRIC-LEAK-CHECK` string is present (teacher-only view).                                                                                                                                                            |
| 7   | Submit the `(b)` mark form with `marks_awarded=4` and reason "Strong on fetch–decode–execute; missed pipelining.".                                                                                | Redirects to the same URL with flash "Mark updated." The `(b)` part now shows `4 / 6 · teacher_override`. Summary updates to `Current score: 5 / 7` with no "awaiting your mark" text. `audit_events` gained one `marking.override` row whose `subject_user_id` is the pupil's id.                      |
| 8   | Submit the `(b)` mark form again with `marks_awarded=5` and reason "Revised after re-read — pipelining implied.".                                                                                 | Flash "Mark updated." `(b)` shows `5 / 6`. In `psql`: `SELECT count(*) FROM awarded_marks WHERE attempt_part_id = <b_part_id>;` returns `2`, and `SELECT count(*) FROM teacher_overrides tov JOIN awarded_marks am ON am.id = tov.awarded_mark_id WHERE am.attempt_part_id = <b_part_id>;` returns `2`. |
| 9   | On the `(a)` part, submit `marks_awarded=0` and reason "Pupil admitted guessing.".                                                                                                                | Flash "Mark updated." `(a)` now shows `0 / 1 · teacher_override`. `awarded_marks` for that part has two rows (the original `deterministic` + the new `teacher_override`), but the loaded bundle picks the latest.                                                                                       |
| 10  | Submit the `(b)` mark form with `marks_awarded=99`.                                                                                                                                               | Flash starts "That mark is outside the allowed range." No new audit row. No new `awarded_marks` row.                                                                                                                                                                                                    |
| 11  | Submit the `(b)` mark form with a blank (whitespace-only) reason.                                                                                                                                 | Flash mentions "reason". No new audit row.                                                                                                                                                                                                                                                              |
| 12  | In a second private window, sign in as `cls_teach_b`. Visit `/admin/classes/<alpha_class_id>/attempts`.                                                                                           | HTTP 403. Teachers cannot see other teachers' submissions.                                                                                                                                                                                                                                              |
| 13  | Still as Teacher Beta, paste the attempt URL `/admin/attempts/<id>` directly.                                                                                                                     | HTTP 403. Cross-teacher access on the attempt detail page is blocked.                                                                                                                                                                                                                                   |
| 14  | Sign in as `cls_pupil_1`. Visit `/admin/attempts/<id>`.                                                                                                                                           | HTTP 403. Pupils never reach the teacher marking UI.                                                                                                                                                                                                                                                    |
| 15  | As `cls_pupil_1`, visit `/attempts/<id>`.                                                                                                                                                         | Review page now shows `Score: 5 / 7` with no "awaiting teacher marking" phrase. Part `(b)` shows `5 / 6 · teacher_override` and **no** Model answer bullets. Part `(a)` shows `0 / 1 · teacher_override`. View source: `RUBRIC-LEAK-CHECK` is absent.                                                   |
| 16  | Attempt a write without a CSRF token (e.g. `curl -X POST http://localhost:3030/admin/attempts/<id>/parts/<part_id>/mark -d 'marks_awarded=3&reason=x'`).                                          | HTTP 403 from the CSRF prevalidation hook. No audit row written.                                                                                                                                                                                                                                        |
| 17  | Re-run the audit query from the prereq block.                                                                                                                                                     | Count bumped by exactly 3 (steps 7, 8, 9). Steps 10, 11, and the 403s in 12–14, 16 wrote nothing.                                                                                                                                                                                                       |
| 18  | (Optional — admin only.) Sign in as an admin user. Visit `/admin/classes/<alpha_class_id>/attempts`, then open the attempt, then post a mark on any part with a valid reason.                     | Admin bypass works: the submissions list and attempt detail both render, and the mark is saved. A `marking.override` audit row is written with the admin's `actor_user_id`.                                                                                                                             |

### Sign-off checklist (Chunk 7)

- [ ] All 17 steps above produced the expected result (18 skipped if no
      admin user exists).
- [ ] `npm run check` green on the same commit.
- [ ] No console errors in the dev server log during the walk-through.
- [ ] Every successful `Save mark` wrote exactly one `marking.override`
      audit row; every rejected submission (invalid marks, blank reason, 403) wrote zero.
- [ ] `awarded_marks` retains every override (history is never mutated
      in place); only the latest row per part drives the bundle view.
- [ ] Cross-teacher (step 12, 13) and pupil (step 14) access returned
      403; the CSRF-less write (step 16) returned 403.
- [ ] Teacher-only rubric text (`RUBRIC-LEAK-CHECK`) never appeared on
      the pupil review page (step 15).

### 1.G Curated content seeding (Chunk 8)

**Goal:** verify the seeder loads every curated JSON file under
`content/curated/`, upserts on re-run, and leaves a realistic bank of
questions for pupils to practise against.

**Prerequisites:**

1. `npm run check` is green on the current commit.
2. Dockerised dev DB is up (`npm run db:up`).
3. Migrations applied (`npm run db:migrate`).

**Steps:**

| #   | Action                                                                                                                   | Expected                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `npm run content:seed -- --dry-run`                                                                                      | Prints `Seed summary: scanned=N created=N updated=0 failed=0` where N = number of files in `content/curated/`.                                      |
| 2   | `ls content/curated/*.json \| wc -l` and compare                                                                         | Matches N from step 1.                                                                                                                              |
| 3   | `npm run content:seed` (first real run)                                                                                  | `created=N updated=0 failed=0`.                                                                                                                     |
| 4   | `npm run content:seed` again (second run, same files)                                                                    | `created=0 updated=N failed=0` — idempotent.                                                                                                        |
| 5   | In psql: `SELECT count(*) FROM questions WHERE similarity_hash LIKE 'curated:%';`                                        | Returns N.                                                                                                                                          |
| 6   | In psql: `SELECT approval_status, active, count(*) FROM questions WHERE similarity_hash LIKE 'curated:%' GROUP BY 1, 2;` | Single row: `approved, true, N`.                                                                                                                    |
| 7   | Log in as teacher. Visit `/admin/questions`.                                                                             | Curated questions listed, all approved + active; covering topics 1.1-1.6 and 2.1-2.5.                                                               |
| 8   | Open one curated question (e.g. "Compare lossy and lossless compression"). Click **Edit**.                               | All parts and mark points populated; `accepted_alternatives` visible where supplied; no missing fields.                                             |
| 9   | Edit one curated JSON file locally (change the stem slightly). Re-run `npm run content:seed`.                            | Only that question reports as updated; summary shows `updated=1` plus (N-1) untouched (still counted as updated, but stem in DB reflects new text). |
| 10  | As a pupil, start a revision attempt with topic filter `1.2`.                                                            | Pupil sees a sample drawn from curated 1.2 questions (memory & storage).                                                                            |
| 11  | Submit answers; reach the review screen.                                                                                 | Mark points from the curated JSON appear in the "model answer" / feedback section.                                                                  |
| 12  | Seeder user check: `SELECT pseudonym, role FROM users WHERE username = 'curated_seed';`                                  | One row, role=`teacher`, pseudonym `CUR-SEED-00`.                                                                                                   |
| 13  | `SELECT count(*) FROM questions WHERE author_id = (SELECT id FROM users WHERE username='curated_seed');`                 | Equals N (all curated questions attributed to the seed user).                                                                                       |

### Sign-off checklist (Chunk 8)

- [ ] Dry-run and wet run report the same scanned count; no failures.
- [ ] Second run is idempotent (`created=0`).
- [ ] All curated rows in DB are `approval_status='approved' AND active=true`.
- [ ] Pupil revision flow surfaces curated questions without errors.
- [ ] Seeder-owned user exists and owns every curated row.
- [ ] `npm run check` still green on the same commit.

### Phase 1 sign-off checklist

- [ ] (Filled in once all chunks ship.)

---

## Phase 2 — OCR-style presentation and objective marking polish

**Maps to:** [PLAN.md](PLAN.md) Phase 2 user test ("full revision lesson.
... does it feel like an exam? Are the answer boxes the right size? Is
the feedback panel useful?").

### 2.A Chunk 1 — paper-style chrome on the pupil edit view

> **Shipped:** paper layout for the pre-submit pupil attempt view
> (`_attempt_edit_body.eta` + new `paper.css`). Teacher metadata badges
> (topic / subtopic / command word) were removed from the pupil surface;
> they remain on the admin / review surfaces.

1. As a pupil with at least one assigned topic, start a topic-set
   attempt and land on `/attempts/:id`.
2. Confirm the page reads like an OCR paper:
   - A single bordered "paper" panel with a top header strip.
   - Header shows the component code + title (e.g. `J277/01 · Computer
systems`), the topic code + title (e.g. `1.2: Memory and storage`),
     the candidate pseudonym, total marks, question count, and the
     attempt mode (`one question at a time` or `whole attempt`).
   - Each question starts with `Q<n>.` in the accent colour and lists
     `[<marks> marks]` at the far right of the question header row.
   - Each part has its `(a)` / `(b)` label on the left and a
     `[<marks> marks]` chip in the right-hand gutter, aligned as if
     printed in the margin.
   - The answer textarea sits full-width under the part prompt, with a
     thin paper-rule border (no heavy form chrome).
3. Confirm the pupil view does **not** show teacher-facing metadata
   badges (topic / subtopic / command-word chips). These still appear
   on the admin question list and on the teacher review screens.
4. Switch attempt mode (per-question vs whole-attempt) and confirm the
   header mode line updates and the per-question branch shows
   `<n> / <total> submitted` in the question count row.
5. Resize the window down to a phone width; the marks gutter should
   stay legible (no overflow, no crushed textareas).

### 2.B Chunk 2 — per-type input widgets

> **Shipped:** pupil edit view now dispatches on
> `question_parts.expected_response_type` to a widget-specific input.
> `multiple_choice` → radio group, `tick_box` → checkboxes,
> `short_text` → single-line input, `medium_text` / `extended_response`
> → textareas (extended is lined like paper and sized from the mark
> tariff), `code` / `algorithm` / `trace_table` → monospace
> textarea with `spellcheck=false`. Server `readAnswerFields` now
> accepts `string[]` so tick-box selections survive round-trip.

1. Seed a question with one part of every type (or load an approved
   set that covers them). The `tests/http/pupil-widgets.test.ts`
   fixture is a good template.
2. As a pupil, open the attempt and walk each part:
   - **multiple_choice:** radio buttons labelled with the mark-point
     text; only one is selectable; the chosen one survives a save +
     reload.
   - **tick_box:** checkboxes labelled with the mark-point text;
     multiple selections survive a save + reload, and show the same
     boxes ticked on return.
   - **short_text:** single line `<input>`, bounded to ~32rem width.
   - **medium_text:** 4-row textarea; spellcheck on.
   - **extended_response:** lined textarea; row count grows with the
     mark tariff (1-mark → 4 lines, 6-mark → 18 lines capped).
   - **code / algorithm:** monospace, spellcheck off, no
     auto-capitalisation. (Tab-to-indent is Chunk 7.)
   - **trace_table:** monospace textarea with a one-line hint about
     using `|` between columns.
3. Submit and confirm:
   - Objective parts (mc / tick / short) are auto-marked.
   - Open parts (medium / extended / code / algorithm / trace_table)
     show "Teacher to mark" on the review panel.
4. Keyboard-only sanity pass: Tab moves through every input; no
   widget is reachable only by mouse.

### 2.C Chunk 3 — background autosave

> **Shipped:** attempt edit pages now load `/static/autosave.js`, which
> watches every widget that carries `data-autosave-part-id` and POSTs
> its current `raw_answer` to `/attempts/:id/parts/:pid/autosave`.
> Triggers: 5s after the last keystroke, on blur, and when the tab
> becomes hidden. CSRF is passed via the `x-csrf-token` header.
> Audit events (`attempt.part.saved`) are debounced to one per
> attempt-part per 60 seconds so the log stays readable.

1. As a pupil, open an in-progress attempt on a desktop browser with
   DevTools → Network open.
2. Type a sentence into a `medium_text` part. Within ~5 seconds you
   should see a single `POST /attempts/:id/parts/:pid/autosave` with
   status 200 and response `{ok: true, saved_at: "..."}`. The status
   chip next to the Save button should flash "Saving…" then show
   "Saved HH:MM".
3. Keep typing without pausing — autosave should _not_ fire a new
   request for every keystroke. Stop typing and wait ~5s; a single new
   POST should land.
4. Click away (blur) immediately after typing — you should see the
   autosave request fire straight away rather than wait for the 5s
   timer.
5. Switch to another browser tab. In the Network panel, confirm one
   final autosave POST is dispatched as the tab goes hidden.
6. Reload the page. The textarea should still contain the last draft
   (proving the answer hit the DB), and the status chip starts blank
   until you type again.
7. Tick-box and multiple-choice parts: click a radio / check a box and
   confirm an autosave POST goes out; the body JSON `raw_answer`
   should contain the newline-joined list of selected values for
   tick-box.
8. Open a submitted attempt (or manually submit one in another tab
   first) and try to POST to the autosave endpoint with curl — expect
   409 `already_submitted`.
9. Audit log sanity: run 5+ rapid saves on one part, then query
   `SELECT COUNT(*) FROM audit_events WHERE event_type =
'attempt.part.saved' AND (details->>'attempt_part_id') = '<pid>'`
   — the count should not exceed `ceil(elapsed_seconds / 60)`.

### 2.D Chunk 4 — optional countdown timer

> **Shipped:** a teacher can set a `timer_minutes` (1–180) on each
> class. Pupils who start a new attempt in that class get the class's
> current timer value snapshotted onto the attempt row, and the edit
> view renders a live MM:SS countdown pill (`/static/timer.js`). The
> timer is informational only — there is no auto-submit — but the
> elapsed time at the moment of submit is written to
> `attempts.elapsed_seconds` (clamped to `[0, timer_minutes * 60 +
30]`). Changing the class timer after an attempt has started does
> NOT mutate the in-flight attempt.

1. As a teacher, open a class detail page and use the new "Countdown
   timer" form to set a timer of e.g. 3 minutes. A flash should
   confirm "Countdown timer set to 3 minutes." and the page should
   state that pupils starting a new attempt will see a 3-minute
   countdown.
2. Check `SELECT event_type, details FROM audit_events WHERE
event_type = 'class.timer_set'` — there should be one row for this
   action with `timer_minutes: 3`.
3. Try to submit 0, 181, or a non-integer — each should flash
   "Timer must be between 1 and 180 minutes." and leave the stored
   value unchanged.
4. Clear the timer by submitting a blank value — flash reads
   "Countdown timer removed." and `classes.timer_minutes` becomes
   NULL.
5. Set the timer back to 3 minutes. As an enrolled pupil in that
   class, start a new attempt on one of the class's topics. The paper
   header should show a "Timer" pill counting down from 03:00. Open
   DevTools and confirm `/static/timer.js` loaded, and the pill has
   `id="paper-timer"` with `data-timer-minutes="3"` and
   `data-timer-started-at="<ISO date>"`.
6. Leave the tab idle past the 10-minute warn threshold (not relevant
   at 3 min, but re-run at 15 min to see it): at ≤10 min remaining
   the pill turns yellow (`.paper-timer--warn`); at ≤1 min it turns
   red (`.paper-timer--critical`); at 0 remaining it goes solid red
   (`.paper-timer--over`). The countdown keeps running into negatives
   visually by staying at `00:00` — no auto-submit.
7. Switch to another tab for 30 seconds, then switch back. The pill
   should re-render immediately with the current elapsed (i.e., it
   does NOT pause while hidden — it is wall-clock anchored to
   `attempts.started_at`).
8. Sleep the laptop for a minute and wake it. On resume the pill
   should again reflect real elapsed wall-clock time, not the time
   the device was awake for.
9. Submit the attempt (per-question or whole-attempt). Check
   `SELECT elapsed_seconds, timer_minutes FROM attempts WHERE id =
<aid>` — `elapsed_seconds` should be roughly the real elapsed time
   in seconds, clamped to `timer_minutes * 60 + 30` at most.
10. As the teacher, open the class submissions list and confirm the
    new **Elapsed** column shows e.g. `02:14 / 03:00` for the
    submission you just made.
11. Start a fresh attempt, then — mid-attempt — have the teacher
    change the class timer to 60 minutes. Reload the pupil's attempt
    page: the pill should still read the original timer (snapshot on
    the attempt row), not the new class value.
12. Remove the class timer entirely (blank the form). Start yet
    another attempt as the pupil: no pill should render, and
    `/static/timer.js` should NOT be referenced in the page source
    (chrome only loads it when `timerEnabled` is truthy).

### Stub — remaining Phase 2 chunks

**To be filled in when the remaining chunks ship.**

Will need to cover:

- Visual fidelity to OCR paper layout (header, marks-in-margin,
  line-ruled answer space sized to mark tariff).
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
