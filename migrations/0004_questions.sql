-- Question bank: questions + parts + mark points + misconceptions.
-- Phase 0 minimum (one handcrafted question must round-trip).
-- Mirrors DATA_MODEL.md "Question bank".

CREATE TABLE questions (
  id                      BIGSERIAL PRIMARY KEY,
  component_code          TEXT        NOT NULL REFERENCES components (code)          ON DELETE RESTRICT,
  topic_code              TEXT        NOT NULL REFERENCES topics (code)              ON DELETE RESTRICT,
  subtopic_code           TEXT        NOT NULL REFERENCES subtopics (code)           ON DELETE RESTRICT,
  command_word_code       TEXT        NOT NULL REFERENCES command_words (code)       ON DELETE RESTRICT,
  archetype_code          TEXT        NOT NULL REFERENCES question_archetypes (code) ON DELETE RESTRICT,
  stem                    TEXT        NOT NULL,
  marks_total             INT         NOT NULL CHECK (marks_total >= 0),
  expected_response_type  TEXT        NOT NULL,
  model_answer            TEXT        NOT NULL,
  feedback_template       TEXT        NULL,
  difficulty_band         INT         NOT NULL CHECK (difficulty_band BETWEEN 1 AND 9),
  difficulty_step         INT         NOT NULL CHECK (difficulty_step BETWEEN 1 AND 3),
  source_type             TEXT        NOT NULL CHECK (source_type IN ('teacher', 'imported_pattern', 'ai_generated')),
  approval_status         TEXT        NOT NULL DEFAULT 'draft'
                            CHECK (approval_status IN ('draft', 'pending_review', 'approved', 'rejected', 'archived')),
  active                  BOOLEAN     NOT NULL DEFAULT false,
  review_notes            TEXT        NULL,
  similarity_hash         TEXT        NULL,
  created_by              BIGINT      NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  approved_by             BIGINT      NULL     REFERENCES users (id) ON DELETE RESTRICT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX questions_topic_idx        ON questions (topic_code);
CREATE INDEX questions_subtopic_idx     ON questions (subtopic_code);
CREATE INDEX questions_active_idx       ON questions (active) WHERE active = true;

CREATE TABLE question_parts (
  id                      BIGSERIAL PRIMARY KEY,
  question_id             BIGINT      NOT NULL REFERENCES questions (id) ON DELETE CASCADE,
  part_label              TEXT        NOT NULL,
  prompt                  TEXT        NOT NULL,
  marks                   INT         NOT NULL CHECK (marks >= 0),
  expected_response_type  TEXT        NOT NULL,
  display_order           INT         NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (question_id, part_label)
);

CREATE INDEX question_parts_question_order_idx
  ON question_parts (question_id, display_order);

CREATE TABLE mark_points (
  id                      BIGSERIAL PRIMARY KEY,
  question_part_id        BIGINT      NOT NULL REFERENCES question_parts (id) ON DELETE CASCADE,
  text                    TEXT        NOT NULL,
  accepted_alternatives   TEXT[]      NOT NULL DEFAULT '{}',
  marks                   INT         NOT NULL DEFAULT 1 CHECK (marks >= 0),
  is_required             BOOLEAN     NOT NULL DEFAULT false,
  display_order           INT         NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX mark_points_part_order_idx
  ON mark_points (question_part_id, display_order);

CREATE TABLE common_misconceptions (
  id                BIGSERIAL PRIMARY KEY,
  question_part_id  BIGINT      NULL REFERENCES question_parts (id) ON DELETE CASCADE,
  topic_code        TEXT        NULL REFERENCES topics (code)        ON DELETE RESTRICT,
  label             TEXT        NOT NULL,
  description       TEXT        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (question_part_id IS NOT NULL OR topic_code IS NOT NULL)
);

CREATE INDEX common_misconceptions_part_idx  ON common_misconceptions (question_part_id);
CREATE INDEX common_misconceptions_topic_idx ON common_misconceptions (topic_code);
