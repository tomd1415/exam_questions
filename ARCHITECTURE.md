# Architecture

System architecture for the OCR J277 revision platform. Written to be readable on its own; cross-references [DATA_MODEL.md](DATA_MODEL.md) and [PROMPTS.md](PROMPTS.md) for detail.

## Architectural goals

1. **Useful without the LLM.** Pupils can revise objective questions and teachers can mark open responses by hand if every external service is offline.
2. **One language, one database.** TypeScript everywhere on the server; Postgres for both relational and vector data.
3. **Auditable.** Every AI call, every awarded mark, every override, every prompt version is recorded.
4. **Boring on purpose.** Standard HTTP, standard SQL, server-rendered HTML. No exotic infrastructure for one school.
5. **Replaceable LLM.** All LLM calls go through a single client wrapper so the underlying provider or model can change without touching marking logic.

## High-level shape

```text
                    ┌─────────────────────────┐
                    │   Browser (pupil/teacher)│
                    │   HTML + HTMX            │
                    └────────────┬────────────┘
                                 │ HTTPS
                                 ▼
                ┌─────────────────────────────────┐
                │          Fastify app            │
                │  ┌───────────┐  ┌────────────┐  │
                │  │ Routes    │  │ Templates  │  │
                │  └─────┬─────┘  └────────────┘  │
                │        │                        │
                │  ┌─────▼─────────────────────┐  │
                │  │ Application services      │  │
                │  │ (auth, attempts, marking, │  │
                │  │  selection, analytics)    │  │
                │  └─────┬─────────────────────┘  │
                │        │                        │
                │  ┌─────▼──────┐  ┌───────────┐  │
                │  │ Repos (SQL)│  │ LLM client│  │
                │  └─────┬──────┘  └─────┬─────┘  │
                └────────┼───────────────┼────────┘
                         │               │
                ┌────────▼─────┐  ┌──────▼────────┐
                │ PostgreSQL   │  │ OpenAI API    │
                │ + pgvector   │  │ (Responses)   │
                └──────────────┘  └───────────────┘
                         │
                ┌────────▼─────┐
                │ Daily backup │
                │ (school's    │
                │  existing    │
                │  off-site    │
                │  regime)     │
                └──────────────┘
```

In Phase 4+ a Redis instance is added for background jobs (calibration, embedding batches, analytics rollups). Until then there are no queues.

## Components

### Web layer (Fastify)

- Server-rendered HTML by default. HTMX for partial updates (autosave, mark reveal, dashboard filters).
- One route per pupil/teacher action. No GraphQL, no client-side router.
- All POSTs are CSRF-protected. Session cookies are HttpOnly, Secure, SameSite=Strict.
- Per-route Zod schemas for input validation. Validation failures return a templated error, not raw JSON, for pupil-facing routes.

### Application services

These are the only place business logic lives. Routes call services; services call repos and the LLM client.

- **AuthService** — login, lockout, session, password reset (teacher-initiated), role checks.
- **AttemptService** — starts a topic-set attempt, saves a part answer, submits a single question (per-question reveal mode) or the whole attempt (whole-attempt mode), resumes, lists past attempts for a pupil, records a pupil self-estimate, and stores the pupil's `reveal_mode` preference. Public surface today: `startTopicSet`, `loadAttemptBundleForActor`, `saveAnswer`, `savePartOne` (autosave), `submitAttempt`, `submitQuestion`, `recordPupilSelfMark`, `listAttemptsForPupil`, `setRevealModeForUser`. All calls are authz-gated via an `ActorForAttempt` (pupil owner, class teacher, or admin). Starting a timed attempt snapshots `classes.timer_minutes` onto `attempts.timer_minutes`; submit writes a client-reported `elapsed_seconds`, clamped server-side to `[0, timer_minutes * 60 + 30]`. Marking of objective parts is delegated to the deterministic marker; open parts stay as `teacher_pending` until a teacher posts an override.
- **ClassService** — teacher-facing CRUD for classes, enrolments, topic assignments, and the optional countdown timer. Public surface includes `createClass`, `listClassesForActor`, `getClassFor`, `addEnrolment`/`removeEnrolment`, `assignTopic`/`unassignTopic`, and `setClassTimer(actor, classId, minutes | null)` which validates the 1–180 range, writes via `ClassRepo.updateClassTimer`, and emits a `class.timer_set` audit event. Authz runs through `ClassAccessError` with a discriminated `reason` (`not_teacher`, `not_owner`, `invalid_timer`, `pupil_not_found`).
- **TeacherMarkingService** — records a teacher override for any attempt part (writes a new `awarded_marks` row plus a `teacher_overrides` row, transactionally) and emits a `marking.override` audit event.
- **MarkingService** — orchestrates the marking pipeline (deterministic pre-checks → LLM call → safety gate → persistence).
- **SelectionService** — chooses the next question for a pupil. Phase 1 returns "next in fixed order"; Phase 4 implements adaptive selection.
- **MasteryService** — reads/writes mastery state per pupil × topic × command word × response type.
- **ContentService** — CRUD for questions; approval workflow; similarity checks; publish/archive.
- **GenerationService** (Phase 5) — retrieval, generation, validator, originality checks.
- **AnalyticsService** (Phase 6) — class heatmaps, misconception clusters, low-confidence queue, intervention groups.
- **AuditService** — append-only audit events.

Services do not import each other freely. Dependencies go one direction; circular imports are a code-review block.

### Repository layer

Thin SQL wrappers per table. No ORMs. Hand-written queries with parameter binding. This keeps the SQL legible to anyone reviewing the code and avoids the usual "where is this query coming from?" debugging.

### LLM client wrapper

A single module that:

- Loads the right prompt template by name and version.
- Validates the input against a Zod schema.
- Calls the provider (OpenAI Responses API in Phase 3+).
- Validates the response against the structured-output schema.
- Records: prompt version, model id, input tokens, output tokens, latency, cost estimate, redaction summary, response snippet, and outcome.
- Implements a circuit breaker (open the circuit after N consecutive errors; close after a cool-down).
- Honours the global kill switch (a single setting that disables all LLM calls).

All LLM calls go through this wrapper. There is no other path to the API.

### Background jobs (Phase 4+)

- Difficulty recalibration (per question, on schedule).
- Embedding generation for new questions and answers.
- Misconception clustering job.
- Cost rollup job.

Jobs are idempotent. Each job records a start/end row in a `job_runs` table.

### Storage

- **PostgreSQL** for everything: users, classes, questions, attempts, marks, audit, mastery state, embeddings (`pgvector`).
- **Object storage** for backups only.
- **No file uploads from pupils** in Phase 1–6. Removes a large class of risk.

## Request lifecycles

### Pupil submits a part answer

1. Browser POSTs to `/attempt/:id/part/:partId/answer` with the answer text.
2. CSRF + session check.
3. Zod validates payload size and shape.
4. AttemptService stores the raw answer and timestamps a `last_saved_at`.
5. If the question is objective: MarkingService runs deterministic marking inline and returns the awarded marks.
6. If the question is open response and we are in Phase 3+: a `marking_required` row is enqueued. The browser receives a "saved" response; the mark arrives via a follow-up request when the pupil opens the review screen.
7. AuditService records `attempt.part.saved`.

### LLM-marked open response (Phase 3+)

1. MarkingService picks up the `marking_required` row.
2. Deterministic pre-checks run (empty? too short? obvious contradiction?). If any tripwire fires, a deterministic outcome is recorded and the LLM is not called.
3. The pupil answer is run through the redactor (strip names, school name, common PII patterns).
4. The LLM client calls the marking prompt with rubric, mark points, accepted alternatives, misconceptions, and the redacted answer.
5. The response is validated against the marking JSON schema. Out-of-range marks are clipped to `[0, marks_total]` and flagged.
6. The safety gate runs: low confidence, weak evidence, marks high but evidence thin → moderation flag.
7. Marks, evidence quotes, feedback, and the moderation flag are written to `awarded_marks` and `feedback_events`.
8. AuditService records `marking.completed` with the prompt version and cost.

### Teacher overrides a mark

1. Teacher opens moderation queue, picks a flagged answer.
2. POST to `/moderation/:awardedMarkId/override` with the corrected mark and a short reason.
3. The original AI mark is preserved; an override row is inserted.
4. The pupil's mastery state is recomputed.
5. AuditService records `marking.override` with the reason.

## Authentication and sessions

- Local accounts only in Phase 1–6. Optional Google SSO in Phase 7 only if the school requests it.
- Passwords hashed with Argon2id; cost parameters tuned to ~250ms on the production VM.
- Sessions stored server-side (signed session id in cookie, state in Postgres). No JWTs.
- Roles: `pupil`, `teacher`, `admin`. Admin is an internal role for the user; not exposed in the UI.
- Pupils cannot self-register. Teachers create pupil accounts and provide a one-time password that must be changed on first login.
- Lockout: 5 failed attempts → 15-minute lockout. Teacher can clear the lockout from the admin panel.

## Authorisation

- Row-level checks in services. Every read and write of pupil data verifies the requesting user is either the pupil themselves or a teacher of the pupil's class.
- The LLM client never sees user IDs or display names.

## Configuration and secrets

- All configuration via environment variables; no secrets in the repo.
- Secrets file readable only by the app user; backed up encrypted.
- Three environments: `local`, `staging` (optional), `production`.
- The kill switch (`LLM_ENABLED=false`) takes effect on next request; no restart required.

## Observability

- Structured JSON logs to disk; rotated daily; redact pupil answers in logs.
- A small admin page showing: app version, prompt versions in use, today's API spend, last backup status, last restore drill date.
- Alerting starts simple: cron job that posts to the teacher's email on backup failure, on circuit breaker open, and on monthly cost cap reached.

## Performance budget

- Page render under 200ms p95 for pupil-facing screens at one-class load.
- LLM marking call returns within 8 seconds p95 in Phase 3, with a hard timeout at 30 seconds.
- Page weight under 200KB on the pupil's slowest target device.

## Folder structure

Actual as of 2026-04-17. `llm/` and `jobs/` are still placeholders — LLM
arrives in Phase 3, background jobs in Phase 4.

```text
src/
├── app.ts                 Fastify wiring (plugins, decorators, route registration)
├── index.ts               process entry point (binds to :3030)
├── config.ts              env loading and validation
├── db/
│   └── migrate.ts         migration runner invoked by `npm run db:migrate`
├── lib/                   shared helpers (csrf, flash, auth preHandlers, template helpers)
├── routes/
│   ├── auth.ts            login/logout, session bootstrap
│   ├── questions.ts       legacy /q/1 smoke endpoint
│   ├── attempts.ts        pupil topic-set flow (/topics, /attempts/:id, save, submit, self-mark)
│   ├── admin-classes.ts   teacher class + enrolment + topic assignment CRUD
│   ├── admin-questions.ts teacher question authoring read/write
│   └── admin-attempts.ts  teacher review + mark override
├── services/
│   ├── auth.ts
│   ├── classes.ts
│   ├── questions.ts
│   ├── attempts.ts
│   ├── audit.ts
│   └── marking/
│       ├── deterministic.ts   pure marker for objective parts
│       └── teacher.ts         teacher override path (Chunk 7)
├── repos/
│   ├── users.ts
│   ├── sessions.ts
│   ├── classes.ts
│   ├── curriculum.ts
│   ├── questions.ts
│   ├── attempts.ts
│   └── audit.ts
├── templates/             Eta templates (_chrome, _admin_*, attempt_edit, attempt_review, topics_list, …)
├── static/                CSS + minimal JS
└── scripts/               CLI entry points: create-user, seed-curated-content, setup-lesson
```

Additional top-level folders on disk:

- `tests/` — `unit/`, `integration/` (DB-backed), `http/` (Fastify `inject`), plus helpers.
- `scripts/` — bash + Playwright for human-test walkers (`human-test-phase0.sh`, `human-test-phase1.sh`, `phase0-browser.ts`, `phase1-browser.ts`), DB helpers (`backup-db.sh`, `restore-drill.sh`, `db-init.sh`), and Debian production bootstrap (`debian-bootstrap.sh`, `server-setup.sh`, `deploy-test-server.sh`).
- `migrations/` — numbered SQL migrations 0001 … 0010 (current).
- `content/curated/` — curated question bank JSON (Phase 1 seed).

## Widget registry

`src/lib/widgets.ts` is the single source of truth for the question types
the platform supports. Each entry binds a response-type code (matching
`EXPECTED_RESPONSE_TYPES`) to:

- the marker that grades it (`deterministic` or `teacher_pending`);
- a `validateConfig` function for the optional `part_config` JSONB blob;
- wizard-facing metadata: `displayName`, `description`,
  `markPointGuidance`, an `exampleConfig`, and a JSON Schema descriptor
  (`configSchema`) for non-trivial widgets.

The functional `validateConfig` is authoritative — it checks both
structural shape and cross-field semantic invariants (e.g. `correctByRow`
length matches `rows`; cloze `text` gap ids appear in `gaps`). The JSON
Schema covers structural constraints only and is **at least as strict**
as the functional validator (it adds `additionalProperties: false` on
top), so a schema-pass is a necessary but not sufficient condition. The
parity test in `tests/unit/widgets-schema.test.ts` enforces this and the
"stricter schema" tests document the deliberate gap.

A snapshot of the registry is committed to
[`docs/widgets.schema.json`](docs/widgets.schema.json), regenerated by
`npm run gen:widgets-schema`. CI's freshness test fails the build if the
committed snapshot drifts from the live registry — run the script and
commit the regenerated file. The same payload is exposed at
`GET /api/widgets` (teacher/admin authenticated, JSON) for in-app
wizards and external integrations that need to discover the question
type catalogue at runtime.

## What is deliberately not in the architecture

- No microservices.
- No message broker beyond Redis-backed BullMQ in Phase 4+.
- No client-side framework (React/Vue/etc.). HTMX covers the interactivity needed.
- No GraphQL, no tRPC.
- No multi-tenant schema partitioning. Multi-teacher in Phase 7 means rows tagged with `class_id`, not separate schemas.
- No event sourcing. Audit log is append-only; the system of record is normal tables.
