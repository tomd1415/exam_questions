-- Curriculum reference tables. Phase 0.
-- Mirrors DATA_MODEL.md "Curriculum tables".

CREATE TABLE components (
  code        TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE topics (
  code            TEXT PRIMARY KEY,
  component_code  TEXT NOT NULL REFERENCES components (code) ON DELETE RESTRICT,
  title           TEXT NOT NULL,
  display_order   INT  NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX topics_component_order_idx
  ON topics (component_code, display_order);

CREATE TABLE subtopics (
  code           TEXT PRIMARY KEY,
  topic_code     TEXT NOT NULL REFERENCES topics (code) ON DELETE RESTRICT,
  title          TEXT NOT NULL,
  display_order  INT  NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX subtopics_topic_order_idx
  ON subtopics (topic_code, display_order);

CREATE TABLE command_words (
  code                     TEXT PRIMARY KEY,
  definition               TEXT NOT NULL,
  expected_response_shape  TEXT NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE question_archetypes (
  code         TEXT PRIMARY KEY,
  description  TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
