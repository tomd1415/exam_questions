-- Pupil feedback channel. Any logged-in user can submit a free-text comment
-- at any time; teachers/admins triage entries and record disposition.
--
-- The DB is the source of truth for raw submissions and triage state; a
-- curated markdown doc (PUPIL_FEEDBACK.md) is maintained by hand from this
-- table for project-planning purposes. Status/category domains are enforced
-- at the DB layer so an admin SQL edit cannot slip in an unexpected value.

CREATE TABLE pupil_feedback (
  id             BIGSERIAL   PRIMARY KEY,
  user_id        BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  comment        TEXT        NOT NULL,
  submitted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  status         TEXT        NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'triaged', 'in_progress', 'resolved', 'wontfix')),
  category       TEXT        NULL
    CHECK (category IS NULL OR category IN
      ('ui', 'ux', 'docs', 'new_feature', 'change_feature', 'bug', 'other')),
  triage_notes   TEXT        NULL,
  triaged_by     BIGINT      NULL REFERENCES users (id) ON DELETE SET NULL,
  triaged_at     TIMESTAMPTZ NULL,
  resolved_at    TIMESTAMPTZ NULL,
  CONSTRAINT pupil_feedback_comment_length
    CHECK (char_length(comment) BETWEEN 1 AND 2000),
  CONSTRAINT pupil_feedback_triage_notes_length
    CHECK (triage_notes IS NULL OR char_length(triage_notes) <= 2000)
);

CREATE INDEX pupil_feedback_status_submitted_idx
  ON pupil_feedback (status, submitted_at DESC);

CREATE INDEX pupil_feedback_user_idx
  ON pupil_feedback (user_id, submitted_at DESC);
