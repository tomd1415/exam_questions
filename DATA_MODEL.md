# Data Model

The relational schema for the OCR J277 revision platform. Phase markers indicate when each table first appears. Types are PostgreSQL.

## Conventions

- Primary keys are `id BIGSERIAL` unless stated.
- All tables have `created_at TIMESTAMPTZ DEFAULT now()` and (where mutated) `updated_at TIMESTAMPTZ`.
- Soft delete is avoided; rows are either deleted or marked with explicit lifecycle status fields (`approval_status`, `active`).
- Foreign keys are `ON DELETE RESTRICT` by default; pupil cascade deletion is handled by an explicit retention job, not by the database, so deletions are auditable.
- All free text columns are `TEXT`. Length limits are enforced in the application layer, not in the database.

## Curriculum tables (Phase 0)

### `components`

| Column  | Type    | Notes                    |
| ------- | ------- | ------------------------ |
| `code`  | TEXT PK | `J277/01`, `J277/02`     |
| `title` | TEXT    | "Computer Systems", etc. |

### `topics`

| Column           | Type                 | Notes      |
| ---------------- | -------------------- | ---------- |
| `code`           | TEXT PK              | e.g. `1.3` |
| `component_code` | TEXT FK → components |            |
| `title`          | TEXT                 |            |
| `display_order`  | INT                  |            |

### `subtopics`

| Column          | Type             | Notes        |
| --------------- | ---------------- | ------------ |
| `code`          | TEXT PK          | e.g. `1.3.2` |
| `topic_code`    | TEXT FK → topics |              |
| `title`         | TEXT             |              |
| `display_order` | INT              |              |

### `command_words`

| Column                    | Type    | Notes                                                                                                           |
| ------------------------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| `code`                    | TEXT PK | `state`, `describe`, `explain`, `compare`, `evaluate`, `discuss`, `analyse`, `write`, `complete`, `trace`, etc. |
| `definition`              | TEXT    | OCR-aligned definition for prompt context                                                                       |
| `expected_response_shape` | TEXT    | "single fact", "fact + reason", "balanced points + judgement", etc.                                             |

### `question_archetypes`

| Column        | Type    | Notes                                                                                                                  |
| ------------- | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| `code`        | TEXT PK | `recall`, `explain`, `compare`, `evaluate`, `algorithm_completion`, `code_writing`, `trace_table`, `extended_response` |
| `description` | TEXT    |                                                                                                                        |

## People and groups (Phase 0–1)

### `users`

| Column                 | Type                          | Notes                                                                                                                                           |
| ---------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                   | BIGSERIAL PK                  |                                                                                                                                                 |
| `role`                 | TEXT                          | `pupil`, `teacher`, `admin`                                                                                                                     |
| `display_name`         | TEXT                          | First name + initial for pupils, full name for teachers                                                                                         |
| `username`             | TEXT UNIQUE                   | Login identifier                                                                                                                                |
| `password_hash`        | TEXT                          | Argon2id                                                                                                                                        |
| `must_change_password` | BOOLEAN DEFAULT true          |                                                                                                                                                 |
| `failed_login_count`   | INT DEFAULT 0                 |                                                                                                                                                 |
| `locked_until`         | TIMESTAMPTZ NULL              |                                                                                                                                                 |
| `last_login_at`        | TIMESTAMPTZ NULL              |                                                                                                                                                 |
| `active`               | BOOLEAN DEFAULT true          |                                                                                                                                                 |
| `pseudonym`            | TEXT UNIQUE                   | Stable pseudonymous ID; used in any AI-bound payload instead of display_name                                                                    |
| `reveal_mode`          | TEXT DEFAULT `'per_question'` | `per_question` \| `whole_attempt`. Per-user preference for attempt flow; snapshotted onto `attempts.reveal_mode` at start time (migration 0010) |

No DOB, no contact details, no SEND flags. School-side mapping (pseudonym ↔ MIS record) lives outside the app.

### `classes`

| Column           | Type                 | Notes                                                                           |
| ---------------- | -------------------- | ------------------------------------------------------------------------------- |
| `id`             | BIGSERIAL PK         |                                                                                 |
| `name`           | TEXT                 | e.g. "10C/Cp1"                                                                  |
| `teacher_id`     | BIGINT FK → users    |                                                                                 |
| `academic_year`  | TEXT                 | e.g. "2025-2026"                                                                |
| `active`         | BOOLEAN DEFAULT true |                                                                                 |
| `topic_set_size` | INT DEFAULT 8        | 1–30. Number of questions drawn into a pupil topic-set attempt (migration 0008) |

Uniqueness: `(teacher_id, name, academic_year)` — a teacher cannot have two classes sharing both name and year.

### `enrolments`

| Column                     | Type                | Notes      |
| -------------------------- | ------------------- | ---------- |
| `class_id`                 | BIGINT FK → classes |            |
| `user_id`                  | BIGINT FK → users   | pupil only |
| PK (`class_id`, `user_id`) |                     |            |

### `class_assigned_topics` (Phase 1, migration 0008)

Many-to-many: which topics a teacher has assigned to a class. Pupils see these on `/topics` and can start an attempt against any of them.

| Column                        | Type                                    | Notes               |
| ----------------------------- | --------------------------------------- | ------------------- |
| `class_id`                    | BIGINT FK → classes (ON DELETE CASCADE) |                     |
| `topic_code`                  | TEXT FK → topics                        |                     |
| `assigned_by`                 | BIGINT FK → users                       | teacher or admin id |
| `created_at`                  | TIMESTAMPTZ                             |                     |
| PK (`class_id`, `topic_code`) |                                         |                     |

Index: `class_assigned_topics (topic_code)`.

### `sessions` (Phase 0)

| Column         | Type              | Notes           |
| -------------- | ----------------- | --------------- |
| `id`           | TEXT PK           | random 256-bit  |
| `user_id`      | BIGINT FK → users |                 |
| `created_at`   | TIMESTAMPTZ       |                 |
| `last_seen_at` | TIMESTAMPTZ       |                 |
| `expires_at`   | TIMESTAMPTZ       |                 |
| `user_agent`   | TEXT              |                 |
| `ip_hash`      | TEXT              | hashed, not raw |

## Question bank (Phase 1)

### `questions`

| Column                      | Type                          | Notes                                                                                                               |
| --------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `id`                        | BIGSERIAL PK                  |                                                                                                                     |
| `component_code`            | TEXT FK → components          |                                                                                                                     |
| `topic_code`                | TEXT FK → topics              |                                                                                                                     |
| `subtopic_code`             | TEXT FK → subtopics           |                                                                                                                     |
| `command_word_code`         | TEXT FK → command_words       |                                                                                                                     |
| `archetype_code`            | TEXT FK → question_archetypes |                                                                                                                     |
| `stem`                      | TEXT                          | The question itself, including any scenario                                                                         |
| `marks_total`               | INT                           |                                                                                                                     |
| `expected_response_type`    | TEXT                          | `multiple_choice`, `tick_box`, `short_text`, `medium_text`, `extended_response`, `code`, `algorithm`, `trace_table` |
| `model_answer`              | TEXT                          |                                                                                                                     |
| `feedback_template`         | TEXT NULL                     | optional teacher-authored override of LLM feedback                                                                  |
| `difficulty_band`           | INT                           | 1–9, GCSE grade band                                                                                                |
| `difficulty_step`           | INT                           | 1–3 within band                                                                                                     |
| `source_type`               | TEXT                          | `teacher`, `imported_pattern`, `ai_generated`                                                                       |
| `approval_status`           | TEXT                          | `draft`, `pending_review`, `approved`, `rejected`, `archived`                                                       |
| `active`                    | BOOLEAN DEFAULT false         | only true once approved                                                                                             |
| `review_notes`              | TEXT NULL                     |                                                                                                                     |
| `similarity_hash`           | TEXT NULL                     | for cheap dedup on stem                                                                                             |
| `created_by`                | BIGINT FK → users             |                                                                                                                     |
| `approved_by`               | BIGINT FK → users NULL        |                                                                                                                     |
| `created_at` / `updated_at` | TIMESTAMPTZ                   |                                                                                                                     |

A question may have multiple parts. For Phase 1 a `parts` table is preferable to JSON-in-a-column.

### `question_parts`

| Column                   | Type                  | Notes                                   |
| ------------------------ | --------------------- | --------------------------------------- |
| `id`                     | BIGSERIAL PK          |                                         |
| `question_id`            | BIGINT FK → questions |                                         |
| `part_label`             | TEXT                  | "a", "b", "c(i)"                        |
| `prompt`                 | TEXT                  |                                         |
| `marks`                  | INT                   |                                         |
| `expected_response_type` | TEXT                  | overrides question's type for this part |
| `display_order`          | INT                   |                                         |

### `mark_points`

| Column                  | Type                       | Notes                                            |
| ----------------------- | -------------------------- | ------------------------------------------------ |
| `id`                    | BIGSERIAL PK               |                                                  |
| `question_part_id`      | BIGINT FK → question_parts |                                                  |
| `text`                  | TEXT                       | The credit-worthy point, in mark-scheme phrasing |
| `accepted_alternatives` | TEXT[]                     | Synonyms / equivalent phrasings                  |
| `marks`                 | INT DEFAULT 1              |                                                  |
| `is_required`           | BOOLEAN DEFAULT false      |                                                  |
| `display_order`         | INT                        |                                                  |

### `common_misconceptions`

| Column             | Type                            | Notes                                |
| ------------------ | ------------------------------- | ------------------------------------ |
| `id`               | BIGSERIAL PK                    |                                      |
| `question_part_id` | BIGINT FK → question_parts NULL | NULL if topic-level                  |
| `topic_code`       | TEXT FK → topics NULL           |                                      |
| `label`            | TEXT                            | short tag like "confuses MAC and IP" |
| `description`      | TEXT                            |                                      |

### `question_embeddings` (Phase 5)

| Column         | Type                     | Notes                               |
| -------------- | ------------------------ | ----------------------------------- |
| `question_id`  | BIGINT PK FK → questions |                                     |
| `embedding`    | VECTOR(1536)             | from `text-embedding-3-small`       |
| `model_id`     | TEXT                     | which embedding model produced this |
| `generated_at` | TIMESTAMPTZ              |                                     |

### `source_excerpts` (Phase 5)

Stored excerpts from OCR papers used only for similarity comparison; never served to pupils.

| Column         | Type         | Notes              |
| -------------- | ------------ | ------------------ |
| `id`           | BIGSERIAL PK |                    |
| `source_label` | TEXT         | "J277/01 2023 Q4a" |
| `text`         | TEXT         |                    |
| `embedding`    | VECTOR(1536) |                    |

## Attempts and marking (Phase 1, extended in Phase 3)

### `attempts`

| Column                 | Type                          | Notes                                                                                                                   |
| ---------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `id`                   | BIGSERIAL PK                  |                                                                                                                         |
| `user_id`              | BIGINT FK → users             |                                                                                                                         |
| `class_id`             | BIGINT FK → classes           |                                                                                                                         |
| `mode`                 | TEXT                          | `topic_set`, `weakest_areas`, `mixed`, `paper`, `mock`                                                                  |
| `started_at`           | TIMESTAMPTZ                   |                                                                                                                         |
| `submitted_at`         | TIMESTAMPTZ NULL              | Non-null once every question has been submitted (per-question mode) or the whole attempt submitted (whole-attempt mode) |
| `target_topic_code`    | TEXT NULL                     |                                                                                                                         |
| `target_subtopic_code` | TEXT NULL                     |                                                                                                                         |
| `reveal_mode`          | TEXT DEFAULT `'per_question'` | Snapshot of the pupil's `users.reveal_mode` at start time (migration 0010). See Reveal modes note below                 |

### `attempt_questions`

| Column          | Type                  | Notes                                              |
| --------------- | --------------------- | -------------------------------------------------- |
| `id`            | BIGSERIAL PK          |                                                    |
| `attempt_id`    | BIGINT FK → attempts  |                                                    |
| `question_id`   | BIGINT FK → questions |                                                    |
| `display_order` | INT                   |                                                    |
| `submitted_at`  | TIMESTAMPTZ NULL      | Per-question lock (migration 0010); see note below |

### `attempt_parts`

| Column                | Type                          | Notes                                                                                                 |
| --------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `id`                  | BIGSERIAL PK                  |                                                                                                       |
| `attempt_question_id` | BIGINT FK → attempt_questions |                                                                                                       |
| `question_part_id`    | BIGINT FK → question_parts    |                                                                                                       |
| `raw_answer`          | TEXT                          | exactly what the pupil typed                                                                          |
| `normalised_answer`   | TEXT NULL                     | trimmed/lowercased copy used by deterministic checks                                                  |
| `last_saved_at`       | TIMESTAMPTZ                   |                                                                                                       |
| `submitted_at`        | TIMESTAMPTZ NULL              |                                                                                                       |
| `pupil_self_marks`    | INT NULL                      | Pupil's self-estimated mark after reading the mark scheme for a teacher-pending part (migration 0010) |

**Reveal modes (migration 0010).** `attempts.reveal_mode = 'per_question'` lets a pupil submit and get feedback one question at a time; `attempt_questions.submitted_at` carries the per-question lock. In `'whole_attempt'` mode the lock is driven by `attempts.submitted_at` alone and the per-question column is ignored. The service layer validates `pupil_self_marks ≤ question_parts.marks` (DB only enforces `>= 0`).

### `awarded_marks` (Phase 1 deterministic, Phase 3 LLM)

| Column                | Type                      | Notes                                               |
| --------------------- | ------------------------- | --------------------------------------------------- |
| `id`                  | BIGSERIAL PK              |                                                     |
| `attempt_part_id`     | BIGINT FK → attempt_parts |                                                     |
| `marks_awarded`       | INT                       |                                                     |
| `marks_total`         | INT                       |                                                     |
| `mark_points_hit`     | BIGINT[]                  | FK refs into mark_points                            |
| `mark_points_missed`  | BIGINT[]                  |                                                     |
| `evidence_quotes`     | TEXT[]                    | spans from the pupil answer                         |
| `marker`              | TEXT                      | `deterministic`, `llm`, `teacher_override`          |
| `confidence`          | NUMERIC(3,2) NULL         | 0.00–1.00 for LLM marker                            |
| `moderation_required` | BOOLEAN DEFAULT false     |                                                     |
| `moderation_status`   | TEXT                      | `pending`, `accepted`, `overridden`, `not_required` |
| `prompt_version`      | TEXT NULL                 | for `llm` marker                                    |
| `model_id`            | TEXT NULL                 |                                                     |
| `created_at`          | TIMESTAMPTZ               |                                                     |

### `feedback_events`

| Column             | Type                      | Notes                       |
| ------------------ | ------------------------- | --------------------------- |
| `id`               | BIGSERIAL PK              |                             |
| `awarded_mark_id`  | BIGINT FK → awarded_marks |                             |
| `audience`         | TEXT                      | `pupil`, `teacher`          |
| `what_went_well`   | TEXT NULL                 |                             |
| `how_to_gain_more` | TEXT NULL                 |                             |
| `next_focus`       | TEXT NULL                 |                             |
| `raw_response`     | JSONB NULL                | full LLM response for audit |

### `teacher_overrides`

| Column              | Type                      | Notes    |
| ------------------- | ------------------------- | -------- |
| `id`                | BIGSERIAL PK              |          |
| `awarded_mark_id`   | BIGINT FK → awarded_marks |          |
| `teacher_id`        | BIGINT FK → users         |          |
| `new_marks_awarded` | INT                       |          |
| `reason`            | TEXT                      | required |
| `created_at`        | TIMESTAMPTZ               |          |

### `misconception_events` (Phase 6)

| Column             | Type                                   | Notes                      |
| ------------------ | -------------------------------------- | -------------------------- |
| `id`               | BIGSERIAL PK                           |                            |
| `awarded_mark_id`  | BIGINT FK → awarded_marks              |                            |
| `misconception_id` | BIGINT FK → common_misconceptions NULL |                            |
| `inferred_label`   | TEXT NULL                              | when no exact match exists |
| `embedding`        | VECTOR(1536) NULL                      | for clustering             |

## Mastery and selection (Phase 4)

### `mastery_state`

| Column                                                             | Type                    | Notes                              |
| ------------------------------------------------------------------ | ----------------------- | ---------------------------------- |
| `user_id`                                                          | BIGINT FK → users       |                                    |
| `topic_code`                                                       | TEXT FK → topics        |                                    |
| `command_word_code`                                                | TEXT FK → command_words |                                    |
| `response_type`                                                    | TEXT                    | from `expected_response_type`      |
| `score`                                                            | NUMERIC(5,2)            | 0.00–100.00                        |
| `confidence`                                                       | NUMERIC(3,2)            | derived from sample size + recency |
| `last_attempt_at`                                                  | TIMESTAMPTZ             |                                    |
| `updated_at`                                                       | TIMESTAMPTZ             |                                    |
| PK (`user_id`, `topic_code`, `command_word_code`, `response_type`) |                         |                                    |

### `question_calibration`

| Column                 | Type                     | Notes                  |
| ---------------------- | ------------------------ | ---------------------- |
| `question_id`          | BIGINT PK FK → questions |                        |
| `attempts_count`       | INT                      |                        |
| `mean_mark_pct`        | NUMERIC(5,2)             |                        |
| `discrimination`       | NUMERIC(5,3) NULL        | item-total correlation |
| `mean_seconds`         | INT NULL                 |                        |
| `last_recalibrated_at` | TIMESTAMPTZ              |                        |

## Audit and operations (Phase 0+)

### `audit_events`

Append-only.

| Column            | Type                      | Notes                                                                                           |
| ----------------- | ------------------------- | ----------------------------------------------------------------------------------------------- |
| `id`              | BIGSERIAL PK              |                                                                                                 |
| `at`              | TIMESTAMPTZ DEFAULT now() |                                                                                                 |
| `actor_user_id`   | BIGINT NULL               |                                                                                                 |
| `actor_role`      | TEXT                      |                                                                                                 |
| `subject_user_id` | BIGINT NULL               |                                                                                                 |
| `event_type`      | TEXT                      | dotted, e.g. `attempt.part.saved`, `marking.completed`, `marking.override`, `question.approved` |
| `details`         | JSONB                     |                                                                                                 |

### `llm_calls` (Phase 3)

| Column                | Type         | Notes                                                                  |
| --------------------- | ------------ | ---------------------------------------------------------------------- |
| `id`                  | BIGSERIAL PK |                                                                        |
| `at`                  | TIMESTAMPTZ  |                                                                        |
| `prompt_name`         | TEXT         | `mark_open_response_v3`, etc.                                          |
| `prompt_version`      | TEXT         |                                                                        |
| `model_id`            | TEXT         |                                                                        |
| `input_tokens`        | INT          |                                                                        |
| `output_tokens`       | INT          |                                                                        |
| `latency_ms`          | INT          |                                                                        |
| `cost_estimate_pence` | NUMERIC(8,4) |                                                                        |
| `outcome`             | TEXT         | `ok`, `validation_failed`, `circuit_open`, `provider_error`, `timeout` |
| `redaction_summary`   | JSONB        | what we stripped before sending                                        |

### `job_runs` (Phase 4)

| Column        | Type             | Notes                     |
| ------------- | ---------------- | ------------------------- |
| `id`          | BIGSERIAL PK     |                           |
| `job_name`    | TEXT             |                           |
| `started_at`  | TIMESTAMPTZ      |                           |
| `finished_at` | TIMESTAMPTZ NULL |                           |
| `status`      | TEXT             | `running`, `ok`, `failed` |
| `details`     | JSONB            |                           |

### `prompt_versions` (Phase 3)

| Column                 | Type        | Notes                        |
| ---------------------- | ----------- | ---------------------------- |
| `name`                 | TEXT        | e.g. `mark_open_response`    |
| `version`              | TEXT        | semver-style                 |
| `body`                 | TEXT        | full prompt text             |
| `schema_json`          | JSONB       | the structured-output schema |
| `notes`                | TEXT        | what changed                 |
| `created_at`           | TIMESTAMPTZ |                              |
| PK (`name`, `version`) |             |                              |

## Indexes (initial guesses; revisit with real data)

- `attempt_parts (attempt_question_id)`
- `awarded_marks (attempt_part_id)`
- `awarded_marks (moderation_status)` partial index where `moderation_status = 'pending'`
- `audit_events (at DESC)`
- `audit_events (actor_user_id, at DESC)`
- `mastery_state (user_id)`
- `teacher_overrides (awarded_mark_id)` and `(teacher_id, created_at DESC)` (migration 0009)
- `class_assigned_topics (topic_code)` (migration 0008)
- `questions (topic_code) WHERE active = true AND approval_status = 'approved'` — the hot picker used by the pupil topic-set flow (migration 0008)
- `question_embeddings USING ivfflat (embedding vector_cosine_ops)` once Phase 5 is live
- `source_excerpts USING ivfflat (embedding vector_cosine_ops)` once Phase 5 is live

## Retention

See [SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md). The retention job:

- Deletes `sessions` past `expires_at` daily.
- Deletes pupil personal data (users + cascades) for any pupil whose enrolment ended ≥12 months ago, unless explicitly preserved.
- Keeps anonymised aggregate analytics (counts, mastery distributions) indefinitely.
