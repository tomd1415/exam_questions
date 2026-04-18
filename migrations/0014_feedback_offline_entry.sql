-- Offline-entry support for pupil feedback.
--
-- When a pupil gives feedback verbally / in class / on paper, a teacher
-- enters it on their behalf through /admin/feedback/new. The feedback
-- row is still attributed to the pupil (`user_id`) so it shows in the
-- pupil's own /feedback list, but `submitted_by_user_id` records which
-- teacher logged it. NULL means the pupil submitted it themselves through
-- the site.

ALTER TABLE pupil_feedback
  ADD COLUMN submitted_by_user_id BIGINT NULL
    REFERENCES users (id) ON DELETE SET NULL;

-- A teacher cannot have submitted the feedback on behalf of themselves.
ALTER TABLE pupil_feedback
  ADD CONSTRAINT pupil_feedback_submitted_by_not_self
    CHECK (submitted_by_user_id IS NULL OR submitted_by_user_id <> user_id);
