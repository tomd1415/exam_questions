-- Phase 1, Chunk 5: support pupil topic-set flow.
--
-- * class_assigned_topics links a class to the topics its pupils may
--   attempt. Phase 1 keeps this as a simple many-to-many; the teacher
--   decides which topics are visible.
-- * classes.topic_set_size lets a teacher tune how many questions land
--   in a single attempt (default 8). Range enforced at the app layer.
-- * The partial index on questions speeds up the hot picker query
--   ("active approved questions in topic T").

CREATE TABLE class_assigned_topics (
  class_id     BIGINT      NOT NULL REFERENCES classes (id) ON DELETE CASCADE,
  topic_code   TEXT        NOT NULL REFERENCES topics  (code) ON DELETE RESTRICT,
  assigned_by  BIGINT      NOT NULL REFERENCES users   (id)   ON DELETE RESTRICT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (class_id, topic_code)
);

CREATE INDEX class_assigned_topics_topic_idx ON class_assigned_topics (topic_code);

ALTER TABLE classes
  ADD COLUMN topic_set_size INT NOT NULL DEFAULT 8
  CHECK (topic_set_size BETWEEN 1 AND 30);

CREATE INDEX questions_active_topic_idx
  ON questions (topic_code)
  WHERE active = true AND approval_status = 'approved';
