-- Pupil attempts and the marking record. Phase 0 minimum.
-- Mirrors DATA_MODEL.md "Attempts and marking".

CREATE TABLE attempts (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               BIGINT      NOT NULL REFERENCES users (id)   ON DELETE RESTRICT,
  class_id              BIGINT      NOT NULL REFERENCES classes (id) ON DELETE RESTRICT,
  mode                  TEXT        NOT NULL CHECK (mode IN ('topic_set', 'weakest_areas', 'mixed', 'paper', 'mock')),
  started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at          TIMESTAMPTZ NULL,
  target_topic_code     TEXT        NULL REFERENCES topics (code)    ON DELETE RESTRICT,
  target_subtopic_code  TEXT        NULL REFERENCES subtopics (code) ON DELETE RESTRICT
);

CREATE INDEX attempts_user_started_idx ON attempts (user_id, started_at DESC);
CREATE INDEX attempts_class_idx        ON attempts (class_id);

CREATE TABLE attempt_questions (
  id             BIGSERIAL PRIMARY KEY,
  attempt_id     BIGINT NOT NULL REFERENCES attempts (id)  ON DELETE CASCADE,
  question_id    BIGINT NOT NULL REFERENCES questions (id) ON DELETE RESTRICT,
  display_order  INT    NOT NULL,
  UNIQUE (attempt_id, display_order)
);

CREATE INDEX attempt_questions_attempt_idx ON attempt_questions (attempt_id);

CREATE TABLE attempt_parts (
  id                   BIGSERIAL PRIMARY KEY,
  attempt_question_id  BIGINT      NOT NULL REFERENCES attempt_questions (id) ON DELETE CASCADE,
  question_part_id     BIGINT      NOT NULL REFERENCES question_parts (id)    ON DELETE RESTRICT,
  raw_answer           TEXT        NOT NULL DEFAULT '',
  normalised_answer    TEXT        NULL,
  last_saved_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at         TIMESTAMPTZ NULL,
  UNIQUE (attempt_question_id, question_part_id)
);

CREATE INDEX attempt_parts_aq_idx ON attempt_parts (attempt_question_id);

CREATE TABLE awarded_marks (
  id                   BIGSERIAL PRIMARY KEY,
  attempt_part_id      BIGINT      NOT NULL REFERENCES attempt_parts (id) ON DELETE CASCADE,
  marks_awarded        INT         NOT NULL CHECK (marks_awarded >= 0),
  marks_total          INT         NOT NULL CHECK (marks_total >= 0),
  mark_points_hit      BIGINT[]    NOT NULL DEFAULT '{}',
  mark_points_missed   BIGINT[]    NOT NULL DEFAULT '{}',
  evidence_quotes      TEXT[]      NOT NULL DEFAULT '{}',
  marker               TEXT        NOT NULL CHECK (marker IN ('deterministic', 'llm', 'teacher_override')),
  confidence           NUMERIC(3,2) NULL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  moderation_required  BOOLEAN     NOT NULL DEFAULT false,
  moderation_status    TEXT        NOT NULL DEFAULT 'not_required'
                          CHECK (moderation_status IN ('pending', 'accepted', 'overridden', 'not_required')),
  prompt_version       TEXT        NULL,
  model_id             TEXT        NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX awarded_marks_part_idx ON awarded_marks (attempt_part_id);

CREATE INDEX awarded_marks_pending_moderation_idx
  ON awarded_marks (created_at DESC)
  WHERE moderation_status = 'pending';
