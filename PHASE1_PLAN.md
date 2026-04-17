# Phase 1 implementation plan

**Phase in [PLAN.md](PLAN.md):** Phase 1 — Curated content model and a
real revision loop. Duration estimate: 3–4 weeks of evening work.

> **Status (2026-04-17):** Chunks 1–4 merged on `main`. Chunk 5 (pupil
> topic-set flow) landed along with a follow-up refinement: per-question
> reveal mode and pupil self-estimate forms, supported by migration
> `0010_per_question_mode.sql`. Chunks 6–10 still outstanding. Update
> this document as scope changes, and record the rationale in a dated
> note at the bottom.

## 1. Phase goal in one paragraph

At the end of Phase 1, the teacher can author curated questions
through a basic UI, assemble a topic-set, and assign it to a class.
Pupils in that class can log in, pick the assigned topic, work through
5–10 questions (save and resume across sessions), submit, and see their
own raw score. Multiple-choice and tick-box parts are marked
automatically; open-response parts are stored with the label "your
teacher will mark this". The teacher can review every pupil submission
in an admin UI. No LLM, no adaptive logic, no analytics — those are
later phases.

Success is measured by the Phase 1 user test: one real lesson with the
teacher's class where pupils complete an assigned topic-set with zero
data loss and can use the app without more than a 2-minute demo. See
[PLAN.md](PLAN.md) §Phase 1 "User test" and "Success criteria".

## 2. What already exists (end of Phase 0)

The following are live on main as of 2026-04-16 and are _not_ re-done
in Phase 1:

- **Database schema** for curriculum, people, audit, questions, parts,
  mark points, misconceptions, attempts, attempt-questions,
  attempt-parts, awarded-marks (see migrations 0001–0007). Phase 1
  uses these tables; it adds no new tables unless a chunk says so.
- **Auth** (login / logout, signed session cookie, CSRF, Argon2id).
- **One end-to-end happy path**: pupil or teacher logs in at `/login`,
  lands on `/q/1`, types an answer into a single textarea, submits,
  sees `?saved=N`. Attribution is correctly by `user_id`.
- **Audit trail** (`audit_events`) for logins and attempt submissions.
- **Backup + restore drill** and **human-test walker**
  (`npm run test:human:phase0`).
- **DPIA draft** ([DPIA.md](DPIA.md)) awaiting DPO + safeguarding
  lead signature. Phase 1 may proceed on **synthetic / test data
  only** until both signatures land, per
  [SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md) §DPIA.

## 3. What Phase 1 will build

Grouped roughly by user-visible surface. The detailed per-chunk
breakdown is §5.

- **Classes and enrolments.** Teacher creates a class, adds pupils,
  assigns a topic-set.
- **Question authoring UI** (teacher-only). Create and edit a
  question, its parts, its mark points, and its common misconceptions.
  Transition `approval_status` from `draft` → `pending_review` →
  `approved`; `active = true` only on approval.
- **Deterministic marking service.** Pure TypeScript module that marks
  a submitted `attempt_part` against the question part's mark points,
  for multiple-choice, tick-box, and exact-match short-text. Open
  responses return `{ marker: 'teacher_pending' }` — teacher will
  mark manually in the admin UI.
- **Pupil topic-set flow.** `/topics` → `/topics/:code/start` →
  `/attempts/:id` (save-and-resume) → `/attempts/:id/submit` →
  `/attempts/:id/review` (own score only).
- **Teacher review UI.** `/admin/classes/:id/attempts` (list) and
  `/admin/attempts/:id` (per-attempt review, including open responses).
  Manual "teacher override" for any awarded mark (records a
  `teacher_override` row and an `audit_event`).
- **Curated content.** 60–100 teacher-authored questions, weighted to
  the topic(s) being taught this term. Loaded via a new
  `npm run content:seed` script that is idempotent and reads a
  `content/curated/*.json` folder.
- **Phase 1 human-test walker** that mirrors the Phase 0 automation
  where practical.

## 4. What Phase 1 will _not_ build

From [PLAN.md](PLAN.md) §Phase 1 "Do not build", expanded so that a
future tempted developer has no room to interpret:

- **No LLM marking.** Open responses are queued to the teacher; they
  are not sent anywhere.
- **No adaptive selection.** Questions within a topic-set appear in
  the teacher-defined `display_order`. No mastery scores.
- **No cross-class analytics.** A teacher sees only their own classes;
  no department view.
- **No parent / SLT view.** No exports beyond the teacher's own review
  screens.
- **No bulk import.** Pupils are added by the teacher one at a time
  (or via the existing `npm run user:create`) for Phase 1.
- **No question-bank import from PDF/OCR.** Content is hand-authored
  into the JSON seed.
- **No richer question types than the DB schema already supports.**
  Algorithm / trace-table / extended-response rendering is a Phase 2
  problem; the schema accepts them but the renderer in Phase 1 is a
  textarea with a "teacher will mark" label.

## 5. Chunk-by-chunk plan

Each chunk is shippable on its own: at the end of a chunk, `npm run
check` is green, the feature works by hand, and the new behaviour is
reflected in [HUMAN_TEST_GUIDE.md](HUMAN_TEST_GUIDE.md) §Phase 1. A
chunk is small enough to finish in 1–2 evenings of focused work.

Standing rules that apply to _every_ chunk (stop treating these as
chunk-specific tasks):

- Every new route has authn + authz checked in a `preHandler`; failing
  authz returns 403 or redirects to `/login` depending on whether the
  request is authenticated.
- Every form POST uses the existing CSRF middleware.
- Every state-changing action writes one row to `audit_events` with
  the dotted `event_type` defined in [DATA_MODEL.md](DATA_MODEL.md).
- Template changes reuse `_chrome.eta`; no inline `<style>` blocks.
- No new runtime dependencies unless justified in the chunk doc.

### Chunk 1 — Classes and enrolments

**Goal.** The teacher can create a class, list classes, add and remove
pupil enrolments. Everything else that follows is scoped by class, so
this is the foundation.

**Schema.** No new tables; `classes` and `enrolments` exist from
migration 0002. Add:

- Index `enrolments (user_id)` if not already present (check; add as
  migration `0008_enrolment_index.sql` only if missing).

**App code.**

- `src/repos/classes.ts`: `createClass`, `listClassesForTeacher`,
  `getClassById`, `addEnrolment`, `removeEnrolment`,
  `listPupilsInClass`.
- `src/services/classes.ts`: authorisation wrapper — a teacher can
  only touch classes where `teacher_id = them`.
- `src/routes/admin-classes.ts`: `GET /admin/classes`,
  `GET /admin/classes/new`, `POST /admin/classes`,
  `GET /admin/classes/:id`, `POST /admin/classes/:id/enrol`,
  `POST /admin/classes/:id/enrolments/:userId/remove`.
- Templates: `_admin_chrome.eta`, `admin_classes_list.eta`,
  `admin_class_new.eta`, `admin_class_detail.eta`.

**Audit events added.** `class.created`, `enrolment.added`,
`enrolment.removed`.

**Tests.**

| Level       | File                                     | What it proves                                                                                                                                       |
| ----------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | `tests/unit/class-authz.test.ts`         | The service's "teacher owns this class" check returns correctly for owner, non-owner, and admin.                                                     |
| Integration | `tests/integration/classes-repo.test.ts` | Repo create/read/addEnrolment/removeEnrolment round-trip against a real DB; uniqueness and FK behaviours.                                            |
| HTTP        | `tests/http/admin-classes.test.ts`       | Pupil GET `/admin/classes` → 403; anon → redirect to `/login`; teacher happy path for create + enrol + view; teacher B cannot see teacher A's class. |
| HTTP        | `tests/http/admin-classes-csrf.test.ts`  | POST without CSRF token → 403; with token → success.                                                                                                 |
| Human       | HUMAN_TEST_GUIDE §1.A                    | Teacher creates a class, enrols two pupils, sees them listed, removes one. DB inspected to confirm `enrolments` and `audit_events` rows.             |

**Exit criteria.** `npm run check` green; two real test pupils live in
a real test class owned by `htg_teacher`.

### Chunk 2 — Question authoring, read side

**Goal.** The teacher can browse existing questions (parts, mark
points, misconceptions) in an admin list/detail UI, filterable by
topic and approval status. No writes yet. This mirrors what the seed
script (Chunk 8) and the write UI (Chunk 3) will produce.

**Schema.** None.

**App code.**

- Extend `src/repos/questions.ts` with `listQuestions({ topic?,
approvalStatus?, active? })`, `getQuestionWithPartsAndMarkPoints(id)`.
- `src/routes/admin-questions.ts`: `GET /admin/questions`,
  `GET /admin/questions/:id`.
- Templates: `admin_questions_list.eta`, `admin_question_detail.eta`.

**Audit events added.** None (reads are not audited at this phase; if
needed later, revisit).

**Tests.**

| Level       | File                                       | What it proves                                                                                                     |
| ----------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Integration | `tests/integration/questions-repo.test.ts` | Extended repo reads: filters by topic/approval/active work; missing id returns undefined.                          |
| HTTP        | `tests/http/admin-questions.test.ts`       | Pupil → 403; teacher list page renders expected columns; detail page renders parts + mark points in display order. |
| Human       | HUMAN_TEST_GUIDE §1.B                      | Teacher opens `/admin/questions`, filters to one topic, opens one question, sees all its parts.                    |

**Exit criteria.** `npm run check` green; seed question from Phase 0
appears in `/admin/questions`.

### Chunk 3 — Question authoring, write side

**Goal.** The teacher can create a new question with parts, mark
points, and misconceptions, edit a draft, and transition it through
`draft → pending_review → approved`.

**Schema.** No new tables. Consider adding a `questions (created_by,
approval_status)` composite index only if Chunk 2's query plan
shows a need.

**App code.**

- `src/services/questions.ts`: `createDraftQuestion`,
  `updateDraftQuestion`, `setApprovalStatus`. Each runs inside a
  single DB transaction covering the question + its parts + mark
  points + misconceptions. Enforces invariants (every part has ≥1
  mark point; `marks_total = SUM(parts.marks)`; `active = true` only
  on `approved`).
- Routes: `GET /admin/questions/new`, `POST /admin/questions`,
  `GET /admin/questions/:id/edit`, `POST /admin/questions/:id`,
  `POST /admin/questions/:id/approve`,
  `POST /admin/questions/:id/reject`.
- Form: textarea-heavy, one screen per question (no wizard). See the
  "UX note" at the end of this chunk.
- Templates: `admin_question_form.eta`.

**Audit events added.** `question.created`, `question.updated`,
`question.approved`, `question.rejected`.

**Tests.**

| Level       | File                                          | What it proves                                                                                                                                                            |
| ----------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | `tests/unit/question-invariants.test.ts`      | Pure validation function rejects: no parts, part with 0 mark points on an objective type, marks mismatch, unknown command_word, duplicate `part_label`.                   |
| Integration | `tests/integration/questions-service.test.ts` | Create → edit → approve round-trip; approval sets `active=true` + writes `question.approved`; approving a broken question fails atomically (no partial rows left behind). |
| HTTP        | `tests/http/admin-questions-write.test.ts`    | Pupil POST → 403; teacher create happy path; re-POSTing an edit doesn't duplicate parts; approve transitions status and toggles `active`.                                 |
| Human       | HUMAN_TEST_GUIDE §1.C                         | Teacher authors a multi-part question under 5 minutes, edits a typo, approves it, sees it appear in pupil flow later.                                                     |

**UX note.** Phase 1 form is plain HTML: one `<fieldset>` per part,
one `<textarea>` per mark point, add/remove rows via small plain-JS
buttons. No rich-text editor; no drag-and-drop. The Phase 1 success
criterion is "author a new question in under 5 minutes" — the user is
the only teacher using it for this phase.

**Exit criteria.** A teacher-authored, approved question created via
the UI is queryable at `/admin/questions/:id` and is pickable by the
pupil flow (Chunk 5).

### Chunk 4 — Deterministic marking service

**Goal.** A pure TypeScript module that, given a `question_part` and
an `attempt_part.raw_answer`, returns an `AwardedMark` for
objective types (`multiple_choice`, `tick_box`, `short_text` with an
exact or `accepted_alternatives` match) or a `teacher_pending` marker
for open types (`medium_text`, `extended_response`, `code`,
`algorithm`, `trace_table`).

**Why this chunk is separate.** It is the code most worth unit-testing
heavily in isolation, before any HTTP wiring. A wrong mark is the
single most damaging Phase 1 bug.

**Schema.** None.

**App code.**

- `src/services/marking/deterministic.ts` with:
  - `markAttemptPart(part: QuestionPart, rawAnswer: string,
markPoints: MarkPoint[]): MarkingResult`
  - Normalisation helpers: trim + collapse whitespace; lower-case;
    canonicalise straight/curly quotes and dashes; strip trailing
    punctuation. _Deterministic, not LLM._
  - Mark-points-hit logic: a mark point is hit iff the normalised
    answer contains the normalised `text` or any normalised
    `accepted_alternatives`. Respect `is_required`.
  - For multiple-choice: exact match against the single allowed
    option.
  - For tick-box: parse the submitted list; count correct ticks minus
    incorrect (never below 0).

**Tests.**

| Level | File                                       | What it proves                                                                                                                                                                                                                                          |
| ----- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit  | `tests/unit/marking/normalise.test.ts`     | Normalisation is stable and idempotent; known tricky inputs (smart quotes, trailing full stop, trailing newline) behave.                                                                                                                                |
| Unit  | `tests/unit/marking/deterministic.test.ts` | ≥ 20 golden cases covering: MC correct/incorrect/blank; tick-box correct/partial/over-ticked; short-text exact/alt/close-miss; open type always returns `teacher_pending`; required mark point missed clamps marks to 0; `marks_awarded ≤ marks_total`. |

**Exit criteria.** 100% branch coverage of
`src/services/marking/deterministic.ts`. No DB access in these tests.

### Chunk 5 — Pupil topic-set flow

**Goal.** The pupil picks a topic, the system builds an attempt with
5–10 questions drawn only from that topic (all parts included), the
pupil answers and can close their tab and come back, and submission
triggers the deterministic marker for objective parts.

**Schema.** No new tables, but:

- Migration `0008_phase1_indexes.sql` adds any indexes we now know
  we need from query plans (candidate: `questions (topic_code)
WHERE active = true`).

**App code.**

- `src/repos/attempts.ts`: extend with `createTopicSetAttempt(userId,
classId, topicCode)` — selects N active approved questions for the
  topic, creates `attempts` + `attempt_questions` + `attempt_parts`
  skeleton rows, all in one transaction. N defaults to 8; configurable
  later.
- `src/services/attempts.ts`: `saveAnswer(attemptPartId, rawAnswer,
userId)` (authz: pupil must own the attempt) and
  `submitAttempt(attemptId, userId)` which, after `submitted_at =
now()`, iterates parts and calls the Chunk 4 marker for objective
  types.
- Routes:
  - `GET /topics` — list topics the pupil's class has been assigned
    (Chunk 1 added class enrolments; Phase 1 assigns _one_ topic per
    class at a time for simplicity).
  - `GET /topics/:code/start` — creates an attempt and 302s to
    `/attempts/:id`.
  - `GET /attempts/:id` — renders all questions in the attempt with
    parts pre-filled with the last saved `raw_answer`.
  - `POST /attempts/:id/save` — saves one or many parts (form submit;
    HTMX not in scope yet — form posts whole page in Phase 1).
  - `POST /attempts/:id/submit` — marks everything, redirects to
    `/attempts/:id/review`.
- `/q/1` (Phase 0 route) is left in place as a smoke endpoint but is
  no longer the primary flow.
- Templates: `topics_list.eta`, `attempt_edit.eta`,
  `attempt_review.eta`.

**Audit events added.** `attempt.started`, `attempt.part.saved`,
`attempt.submitted`, `marking.completed`.

**Tests.**

| Level       | File                                           | What it proves                                                                                                                                                                                   |
| ----------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Integration | `tests/integration/attempts-topic-set.test.ts` | `createTopicSetAttempt` picks only active+approved+topic-matching questions; creates the full part skeleton; fails atomically if no questions available.                                         |
| Integration | `tests/integration/attempts-submit.test.ts`    | `submitAttempt` calls the deterministic marker for objective parts, writes `awarded_marks` rows, leaves open parts with `marker='teacher_pending'`; idempotent (re-submit does not double-mark). |
| HTTP        | `tests/http/pupil-topic-flow.test.ts`          | Pupil happy path: `/topics` → `/topics/:code/start` → save twice → close page → reopen → previous answers still there → submit → review.                                                         |
| HTTP        | `tests/http/pupil-authz.test.ts`               | Pupil A cannot GET or POST to pupil B's attempt (403); pupil cannot submit a teacher's attempt.                                                                                                  |
| Human       | HUMAN_TEST_GUIDE §1.D                          | Pupil uses only a 2-minute demo and completes a 5-question topic-set; they can close the tab mid-way and resume.                                                                                 |

**Exit criteria.** A pupil can complete a whole topic-set end-to-end
without teacher intervention. Auto-marks for MC/tick-box are correct.

### Chunk 6 — Pupil review view

**Goal.** After submitting, the pupil sees their own raw score per
question with the model answer _only_ for objective items where they
already have a mark. Open responses show "your teacher will mark this
— come back later."

**Schema.** None.

**App code.**

- Extend the existing `/attempts/:id/review` route (from Chunk 5) to
  fetch awarded marks, join against question parts' model answers,
  and render.
- Template: `attempt_review.eta` extended.

**Tests.**

| Level | File                              | What it proves                                                                                                       |
| ----- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| HTTP  | `tests/http/pupil-review.test.ts` | Pupil A sees only their own review; pupil B cannot GET `/attempts/<A-id>/review`; open parts show the pending label. |
| Human | HUMAN_TEST_GUIDE §1.E             | Pupil's review screen is readable, model answer appears for objective items, no teacher-only metadata leaks.         |

**Exit criteria.** Review page matches the spec in [PLAN.md](PLAN.md)
§Phase 1 — "see their own raw score".

### Chunk 7 — Teacher review UI

**Goal.** The teacher can list submitted attempts for one of their
classes, open an attempt, see every pupil answer, and manually mark
open-response parts (or override any deterministic mark).

**Schema.** No new tables. `teacher_overrides` already exists.

**App code.**

- `src/repos/attempts.ts`: `listSubmittedAttemptsForClass(classId)`,
  `getAttemptForTeacher(attemptId, teacherId)` (authz: attempt's
  pupil must be enrolled in a class owned by teacherId).
- `src/services/marking/teacher.ts`: `setTeacherMark(attemptPartId,
teacherId, marksAwarded, reason)` — creates or replaces the
  `awarded_marks` row for that part with `marker='teacher_override'`
  and inserts a `teacher_overrides` row. Transactional.
- Routes: `GET /admin/classes/:id/attempts`,
  `GET /admin/attempts/:id`,
  `POST /admin/attempts/:id/parts/:partId/mark`.
- Templates: `admin_attempts_list.eta`, `admin_attempt_detail.eta`.

**Audit events added.** `marking.override`.

**Tests.**

| Level       | File                                        | What it proves                                                                                                                             |
| ----------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Integration | `tests/integration/teacher-marking.test.ts` | Service creates one override + one audit event; second override on the same part replaces the first but keeps the override history intact. |
| HTTP        | `tests/http/admin-attempts.test.ts`         | Teacher A cannot see teacher B's class attempts; teacher can mark an open part; a teacher cannot mark their _own_ attempt as a teacher.    |
| Human       | HUMAN_TEST_GUIDE §1.F                       | Teacher opens a real pupil submission, marks the open response, the pupil's review screen updates on next visit.                           |

**Exit criteria.** The full loop from pupil submit → teacher mark →
pupil sees updated review works end-to-end.

### Chunk 8 — Curated content seeding

**Goal.** Ship 60–100 real OCR-style questions so the lesson test in
Chunk 10 is meaningful, without requiring the author UI for every one.

**Schema.** None.

**App code.**

- `content/curated/` folder (git-tracked) holding JSON files, one per
  question, validated by Zod against a schema that mirrors the DB.
  Pseudonymised authorship (`created_by = htg_teacher`).
- `scripts/seed-curated-content.ts`: reads the folder, validates,
  upserts questions + parts + mark points + misconceptions
  idempotently (keyed on a stable `external_key` added to the JSON;
  if absent, hash the stem+command_word — this goes into the
  already-nullable `similarity_hash` column).
- `package.json` adds `"content:seed": "tsx scripts/seed-curated-content.ts"`.

**Tests.**

| Level       | File                                     | What it proves                                                                                                                                 |
| ----------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | `tests/unit/content-schema.test.ts`      | Zod schema rejects malformed JSON (missing marks, bad command_word) with readable errors.                                                      |
| Integration | `tests/integration/seed-curated.test.ts` | Running the seed against an empty DB produces N questions; running it twice is a no-op; editing one JSON and re-running updates only that one. |
| Human       | HUMAN_TEST_GUIDE §1.G                    | Teacher runs `npm run content:seed`; spot-checks 3 questions in `/admin/questions`; sees the right counts in the seeder summary line.          |

**Exit criteria.** At least 60 approved questions exist, covering at
least two topics the teacher plans to use in the Phase 1 lesson test.

### Chunk 9 — Phase 1 human-test walker

**Goal.** Mirror the Phase 0 walker: automate as much as reasonable
(HTTP + browser) and surface the remaining human decisions cleanly.

**App code.**

- `scripts/human-test-phase1.sh` — bash walker, same pattern as
  `scripts/human-test-phase0.sh`.
- `scripts/phase1-browser.ts` — Playwright driver covering teacher
  authoring UI happy path, pupil topic-set happy path, pupil
  save-and-resume, teacher override.
- `package.json` adds `"test:human:phase1": "bash scripts/human-test-phase1.sh"`.

**Tests.**

The walker itself _is_ a test. There is nothing new to unit-test here;
the `npm run check` gate remains the regression net.

| Level | File                      | What it proves                                                                                                    |
| ----- | ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Human | HUMAN_TEST_GUIDE §Phase 1 | Walker runs end-to-end; report lands in `tmp/human-tests/phase1-<ts>.md`; any failure step captures a screenshot. |

**Exit criteria.** `npm run test:human:phase1` exits 0 with a report
attached to RUNBOOK.md §10 for Phase 1 sign-off.

### Chunk 10 — Real lesson with the class

**Goal.** The Phase 1 user test from [PLAN.md](PLAN.md): one real
lesson with the teacher's class. Not code; it is the sign-off event.

**Pre-flight (morning of).**

- `npm run check` green on the exact commit being used.
- `npm run test:human:phase1` green within the previous 24 h.
- Backup taken within the previous 24 h.
- DPIA signed, _or_ lesson is run on synthetic accounts only (see
  [DPIA.md](DPIA.md)).

**During the lesson.**

- Teacher assigns one topic-set to the class.
- Pupils log in, complete the set, submit.
- Teacher reviews in the admin UI live during the lesson.

**After the lesson.**

- Capture one-line entries in RUNBOOK.md §10: "Phase 1 lesson test —
  PASS/FAIL — notes".
- Log any bugs in a Phase 1 issues file (create
  `tmp/phase1-issues.md` if we end up with more than one).

**Exit criteria (go to Phase 2).** Lesson completed with:

- zero data loss (before/after attempt counts match),
- pupils self-serving after a 2-minute demo,
- teacher authoring a question under 5 minutes.

See [PLAN.md](PLAN.md) §Phase 1 "Success criteria".

## 6. Test strategy across the phase

The existing `npm run check` (Prettier + ESLint + Vitest with
coverage) remains the minute-by-minute gate. Phase 1 adds:

| Layer                   | When run                                | What it catches                                                     |
| ----------------------- | --------------------------------------- | ------------------------------------------------------------------- |
| Unit                    | `npm run check` on every save           | Pure logic — marking correctness, normalisation, Zod content schema |
| Integration (DB-backed) | `npm run check`                         | Repo + service behaviour against a real Postgres                    |
| HTTP (Fastify `inject`) | `npm run check`                         | Authz, CSRF, form flows, status codes                               |
| Browser (Playwright)    | `npm run test:human:phase1` (on demand) | Real form submission, real redirects, real cookies                  |
| Human walkthrough       | Before chunk merge; before phase merge  | UX, wording, anything a test cannot see                             |

**Coverage target.** Maintain ≥85% line coverage on
`src/services/**` and `src/repos/**`. The marking service
(`src/services/marking/deterministic.ts`) is held to 100% branch
coverage because a wrong mark is the worst Phase 1 bug.

**No mocks of the database.** Integration tests run against the
dockerised Postgres, matching the Phase 0 precedent.

**Flaky-test policy.** A test that fails intermittently is quarantined
(`.skip` with a `TODO: flaky — <ticket>` comment and a same-day issue
opened) rather than retried in CI.

## 7. Ordering and dependencies

```
Chunk 1 (classes/enrolments)
   ├─► Chunk 2 (admin read)
   │     └─► Chunk 3 (admin write)
   │           └─► Chunk 8 (seeding)  ◄── parallelisable with 4
   └─► Chunk 4 (marking service, pure)
         └─► Chunk 5 (pupil flow) ◄── needs 1 for class + 3/8 for questions
               └─► Chunk 6 (pupil review)
                     └─► Chunk 7 (teacher review + overrides)
                           └─► Chunk 9 (walker)
                                 └─► Chunk 10 (real lesson)
```

Chunk 4 (pure marking) can start in parallel with Chunks 1–3 because
it has no DB or HTTP dependency.

## 8. Risks specific to Phase 1 (and their mitigations)

- **Schema churn mid-phase.** The DB is largely correct from Phase 0
  but small things shift (e.g. adding `external_key` to questions for
  idempotent seeding). Mitigation: every schema change is a new
  migration; no edits to past migrations; track the schema decision
  in the chunk's merge commit message.
- **Authoring UI takes longer than marking.** Tempting to polish the
  teacher form at the expense of the deterministic marker. Mitigation:
  keep Phase 1 author UI textarea-heavy per [PLAN.md](PLAN.md) Phase
  1 note.
- **Content seeding blocks pupil-flow testing.** Mitigation: Chunks 1
  and 4 can start immediately; Chunk 5 can use ~10 hand-authored
  questions as soon as Chunk 3 lands and wait for the full 60 later.
- **Pupils see something they shouldn't.** Covered by the per-chunk
  authz tests and the "no DB mocks" policy; the
  `tests/http/*-authz.test.ts` files in Chunks 1, 5, 6, 7 are the
  primary shield.
- **DPIA sign-off lags.** Phase 1 may run on synthetic accounts only
  until DPIA signatures land. Mitigation is procedural, not
  technical — the plan proceeds, the real lesson in Chunk 10 is
  gated.

See [RISKS.md](RISKS.md) §1 and §2.1 for the enduring risk register
this phase sits under.

## 9. Decisions taken before starting (previously open questions)

Resolved on 2026-04-16. These are now binding for Phase 1 unless a
later chunk commit explicitly revisits one.

1. **N questions per topic-set.** Default 8. Configurable per class
   (stored on `classes` — schema addition scheduled for Chunk 5 when
   the flow starts using it, not Chunk 1).
2. **Class → topic-set assignment model.** A class has a _list_ of
   assigned topics. When a pupil starts a set, they pick a topic from
   that list. Chunk 5 introduces a small join table
   (`class_assigned_topics` or similar — schema detail confirmed
   when Chunk 5 starts).
3. **Admin role visibility.** The `admin` role also gets teacher-level
   access to the authoring UI and to the class views. Practically:
   every authz check that says "teacher" accepts `teacher` _or_
   `admin`. Admins additionally see classes owned by _any_ teacher.
4. **Content folder layout.** One JSON file per question, filename =
   slugified stem + short hash, in `content/curated/`. Small clean
   diffs per question.
5. **Teacher override semantics.** Additive. The original
   `awarded_marks` row is preserved for history; a new row (or a
   paired `teacher_overrides` record) captures the override with the
   teacher's id and reason. The pupil-facing and teacher-facing views
   show the _latest_ awarded mark.

Where these decisions affect the schema (items 1 and 2), the
migration lands in the chunk that first needs it and is recorded in
[DATA_MODEL.md](DATA_MODEL.md) at merge time.

## 10. Deliverables checklist (sign off before starting Phase 2)

- [ ] Chunks 1–9 merged with tests green.
- [ ] Phase 1 human-test walker report attached to
      [RUNBOOK.md](RUNBOOK.md) §10 with PASS.
- [ ] Real lesson test completed with the teacher's class (Chunk 10).
- [ ] At least 60 approved questions in the DB.
- [ ] [HUMAN_TEST_GUIDE.md](HUMAN_TEST_GUIDE.md) §Phase 1 filled in
      (stub removed).
- [ ] [DATA_MODEL.md](DATA_MODEL.md) reflects any schema changes that
      actually landed (migration numbers cited).
- [ ] [PLAN.md](PLAN.md) §Phase 1 "Success criteria" all ticked, or
      a documented reason for any exception.
- [ ] Go/no-go decision for Phase 2 recorded in RUNBOOK.md §10 (one
      line: date, initials, PASS/FAIL, link to lesson report).

## Appendix — Revision history

| Date       | Author | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-04-16 | TD     | First draft at end of Phase 0, before Chunk 1 work starts. Awaiting user review.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2026-04-17 | TD     | Status note updated: Chunks 1–4 merged (classes/enrolments, question authoring read/write, deterministic marking). Chunk 5 (pupil topic-set flow) merged along with a post-plan refinement — per-question reveal mode and pupil self-estimate forms — backed by migration `0010_per_question_mode.sql` (adds `users.reveal_mode`, `attempts.reveal_mode`, `attempt_questions.submitted_at`, `attempt_parts.pupil_self_marks`). The `AttemptService` surface grew `listAttemptsForPupil`, `submitQuestion`, `recordPupilSelfMark`, and `setRevealModeForUser`. |
