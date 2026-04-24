# Test users and fixtures

> Local dev DB only. **Never use these passwords in production.** The
> production admin bootstrap happens via `ADMIN_USERNAME` /
> `ADMIN_INITIAL_PASSWORD` env vars on the Debian VM.

Last rebuild: **2026-04-23** (post Phase 3 chunk 3h). Current DB has
everything needed to exercise every feature added up to and including
chunk 3h.

## TL;DR

```
URL       http://localhost:3030
Admin     admin          / admin-change-me-please
Teacher   tom            / teacher-change-me-please
Pupils    pupil1..pupil20 / password-001..password-020
Widgets   test_pupil     / test-pupil-0000            (34-widget harness)
Widgets   test_teacher   / test-teacher-0000          (owns the harness class)
```

Admin, tom, and test_teacher all have `must_change_password = false`, so
they land straight on their role-appropriate landing page with no
password-reset interstitial. Pupils also skip the interstitial.

## How to rebuild this set from scratch

Whenever you run `npm run db:reset` (which drops the Docker volume),
follow these steps to get back to the same state documented here:

```bash
# 1. Start a clean Postgres and apply migrations.
npm run db:up
npm run db:migrate

# 2. Seed curated questions (30 across the curriculum).
npm run content:seed

# 3. Boot the app once so seedPromptDraftsFromDisk writes prompt drafts.
#    Ctrl-C once you see "Server listening at http://127.0.0.1:3030".
npm run dev

# 4. Promote the marking prompt drafts to `active` so the LLM marker
#    and the eval harness have something to call.
npm run db:psql
#   UPDATE prompt_versions SET status = 'active'
#     WHERE name IN ('mark_open_response', 'mark_code_response')
#       AND version = 'v0.1.0';
#   \q

# 5. Admin.
npm run user:create -- \
  --role admin --username admin \
  --display-name 'Site Admin' --pseudonym ADM-0001 \
  --password 'admin-change-me-please' --no-force-change

# 6. Teacher + 20 synthetic pupils + class "Phase 1 Lesson Test"
#    + topic 2.1 assigned. Idempotent.
LESSON_TEACHER_PASSWORD='teacher-change-me-please' \
LESSON_TEACHER_USERNAME=tom \
LESSON_TEACHER_DISPLAY_NAME='Mr Duguid' \
LESSON_PUPIL_COUNT=20 \
  npm run setup:lesson

# 7. Widget test harness: test_pupil + test_teacher + class
#    "Widget Test Harness" + 34 widget-variant fixtures pre-loaded
#    into an in-progress attempt owned by test_pupil.
npm run test-questions:seed

# 8. Give test_teacher a known password (the seed script
#    generates a random one; overwrite it so you can log in).
npm run user:create -- \
  --role teacher --username test_teacher \
  --display-name 'Widget Test Teacher' --pseudonym TST-TCH-00 \
  --password 'test-teacher-0000' --no-force-change
```

After step 8 the DB state mirrors [§Full credential table](#full-credential-table)
below exactly.

## Full credential table

| Username           | Role    | Password                      | Pseudonym                   | Purpose                                                                                                                                                                                |
| ------------------ | ------- | ----------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin`            | admin   | `admin-change-me-please`      | `ADM-0001`                  | Access every `/admin/*` route: prompt versions, moderation, LLM costs, content guards, eval dashboard, attempts, classes, questions, wizard.                                           |
| `tom`              | teacher | `teacher-change-me-please`    | `TEA-0001`                  | Owns class `Phase 1 Lesson Test` (id 2). Log in to run a lesson: assign topics, start attempts (as pupil), moderate AI marks, override marks, view class analytics.                    |
| `pupil1`–`pupil20` | pupil   | `password-001`–`password-020` | `SYN-PUP-001`–`SYN-PUP-020` | Enrolled in `Phase 1 Lesson Test`. Sign in, click "Start topic set" next to topic 2.1, attempt questions, see AI feedback (once moderation clears), print review.                      |
| `test_pupil`       | pupil   | `test-pupil-0000`             | `TST-PUP-00`                | Owns pre-loaded attempt 1 with 34 widget-variant fixtures + every live curated question. Use this account to hand-test every widget end-to-end without polluting the random-draw pool. |
| `test_teacher`     | teacher | `test-teacher-0000`           | `TST-TCH-00`                | Owns class `Widget Test Harness` (id 3). Log in to view moderation / attempts for the test harness attempt.                                                                            |
| `phase0_seed`      | teacher | _n/a — inactive_              | `SYS-PHASE0`                | System row; author of the Phase 0 seed question. `active = false`; cannot log in. Do not delete — historical attempt rows still reference it.                                          |
| `curated_seed`     | teacher | _n/a — no password set_       | `CUR-SEED-00`               | System row; author of every curated question seeded by `content:seed`. Never used for login; the row exists so curated questions have a non-null `created_by`.                         |

## What each account proves

### Admin

- **Prompt version audit** — `/admin/prompts/versions` lists both
  active markers.
- **Moderation queue** — `/admin/moderation` is empty at boot; fills
  when a pupil submits an open response with `LLM_ENABLED=true` and
  the safety gate flags the call.
- **LLM cost dashboard** — `/admin/llm/costs` renders the R/A/G spend
  bands (empty spend until real calls happen).
- **Prompt eval dashboard** — `/admin/evals/latest` renders the
  "No eval runs yet" empty state until `npm run eval` writes a report.
- **Content guards** — `/admin/content-guards` for adding
  safeguarding / prompt-injection patterns.

### Teacher (`tom`)

- **Class management** — `/admin/classes/2` lists pupils, assigned
  topics, timer, topic-set size.
- **Real class activity** — `pupil1` signs in, starts topic 2.1, submits;
  the attempt appears on `tom`'s class dashboard.
- **Marking teacher-pending parts** — deterministic / no-LLM parts land
  at `/admin/attempts/:id`; teacher marks and reason round-trip.
- **Override LLM marks** — with `LLM_ENABLED=true`, flagged rows appear
  on the moderation queue; teacher's override produces a new
  `awarded_marks` row with `marker = 'teacher_override'`.

### Pupils (`pupil1`..`pupil20`)

- **Topic-set attempts** — two reveal modes (per-question vs whole-attempt)
  via `users.reveal_mode`.
- **Autosave + countdown timer** — server clamps `elapsed_seconds` on submit.
- **Widget coverage** — curated questions exercise about two thirds of
  the widget registry; combine with `test_pupil` below for the rest.
- **Review with AI feedback** — once moderation clears an open-response
  AI mark, the three-header feedback block renders under the pupil's
  review page. The `feedback_for_pupil` column (migration 0032) holds the JSON.

### Widget harness (`test_pupil`, `test_teacher`)

- **Every widget variant in one attempt** — attempt id 1 has 2 questions
  per `expected_response_type` (34 widget fixtures) plus all 29 live
  curated questions attached. Matches [RUNBOOK.md §5.2](RUNBOOK.md).
- **Printable mode** — same attempt powers `/attempts/:id?answers=1`
  variants used in the Phase 2.5 human-test walker.

## Pilot-shadow queue (chunk 3i)

Turning on the pilot flag exercises the teacher-parallel review flow end-to-end against the seeded users:

```bash
# 1. Set LLM_MARKING_PILOT=true in .env (LLM_ENABLED=true + OPENAI_API_KEY required).
# 2. Restart: `npm run dev` (or sudo systemctl restart exam-questions in prod).
# 3. Sign in as pupil1 (password-001), start topic 2.1, submit at least one open-response part.
#    The LLM path runs; pupil sees the AI-marked feedback immediately.
# 4. Sign in as admin. Visit /admin/moderation?mode=pilot — the same row appears there too.
# 5. Click "Shadow-review", enter your own mark + a short reason, submit.
#    A teacher_override row lands against the same attempt_part_id; pilot_shadow_status → 'reviewed'.
# 6. npm run pilot:report → CSV + markdown with PASS/FAIL vs the 85 % within-±1 gate.
```

The "Record shadow review" form is deliberately different from the accept/override pair on the safety-gate queue: every submission writes a `teacher_override` row, including full agreement. Agreement is the load-bearing signal for the pilot-week accuracy calculation — a no-op would invisibly count as a disagreement. See [RUNBOOK.md §5.4](RUNBOOK.md) for the full pilot-week operational procedure.

## Prompt-eval harness sanity check

With this fixture set the chunk 3h harness runs end-to-end:

```bash
# Dry-run: stub marker, writes report to scripts/eval/out/.
EVAL_DRY_RUN=1 npm run eval

# Real run (requires LLM_ENABLED=true + OPENAI_API_KEY with a cap).
npm run eval
```

The admin page at `/admin/evals/latest` renders the most recent JSON
report on disk. See [RUNBOOK.md §5.3](RUNBOOK.md) for the operational
details.

## Pupil AI-feedback demos (chunk 3e)

Two scripts make the three-header feedback block on the pupil review
page easy to inspect without running a full lesson. Both target
`pupil1`. Running either overwrites just its own demo attempt; the
two can live side-by-side on `pupil1`'s dashboard.

### `npm run seed:ai-feedback-demo` — synthetic, zero cost

```bash
npm run seed:ai-feedback-demo
```

Creates one `mixed`-mode attempt for `pupil1` with two open-response
parts pre-marked by a synthetic `llm`-marker row each. No OpenAI call,
no cost. Identified in the DB by a `[AI FEEDBACK DEMO]` prefix on
every `attempt_parts.raw_answer`.

- **Part A** — `moderation_status='not_required'`. Pupil sees the
  block immediately after sign-in: three headings, one substituted
  via the Flesch fallback path.
- **Part B** — `moderation_status='pending'`. Pupil does NOT see the
  block; the row appears in `admin`'s `/admin/moderation` queue.
  Clear it from there and the block appears on refresh.

Output line prints the attempt URL. The two `prompt_version` /
`model_id` strings written on the synthetic rows are `v0.1.0` /
`demo-synthetic` so the rows are visually distinguishable from real
LLM marks in admin views.

### `npm run seed:ai-feedback-live -- --yes` — one real OpenAI call

```bash
# Dry-run (no --yes): prints the pupil answer it would send, exits 0.
npm run seed:ai-feedback-live

# Real call: costs approximately 1p at gpt-5-mini prices.
npm run seed:ai-feedback-live -- --yes
```

Drives one open-response part through the production marking stack:
`LlmOpenResponseMarker` → Structured Outputs → safety gate →
`writeLlmMark`. The `attempt_parts.raw_answer` is prefixed with
`[LIVE AI DEMO {ISO timestamp}]` so every row produced by this
script is unambiguously identifiable in the DB. After the call the
script prints:

- attempt id + `attempt_part_id`
- marks awarded / marks total
- model confidence
- safety gate verdict (flagged → `pending`, clean → `not_required`)
- OpenAI input/output tokens, cost in pence, and latency in ms
- the three-header feedback verbatim from the model
- a URL you can open as `pupil1`

Requires `LLM_ENABLED=true` and a non-empty `OPENAI_API_KEY`. Refuses
to run without `--yes`. The same content-guard patterns and safety
gate that production uses also run here, so a flagged row lands in
`admin`'s moderation queue just like a real submission.

Re-running either script tears down its own prior demo attempt
(matched by sentinel prefix) before writing the new one — they are
idempotent and do not accumulate clutter.

## What is NOT seeded and why

- **Real pupil submissions** — none; attempts start empty except for
  the widget harness attempt. Exercise flows by signing in as
  `pupil1`..`pupil20` and working through topic 2.1.
- **30 per prompt real eval fixtures** — the repo ships 5 synthetic
  fixtures per marking prompt under [prompts/eval/](prompts/eval/).
  The full 30 are a chunk 3i pilot deliverable (real anonymised
  answers don't exist yet).
- **Any PII** — pseudonyms are synthetic. There is no real pupil
  data anywhere in the dev DB.
