-- Adds a soft-retirement flag to questions so teachers can take a question
-- out of pupil rotation without breaking existing pupil attempt history
-- (attempt_parts FK-restricts on question_parts). Pupil-facing queries
-- filter on `retired_at IS NULL`; teacher-facing list views still show
-- retired rows with a tag. See QUESTION_AUTHORING.md.
--
-- This migration also retires every pre-existing question so the bank can
-- be replaced with a freshly-authored set. The old curated JSON files are
-- archived under content/curated/retired/ so `npm run content:seed` won't
-- re-activate them. The phase0_seed demo question (inserted by 0007) is
-- preserved so integration tests that exercise /q/1 still have a target.

ALTER TABLE questions
  ADD COLUMN retired_at TIMESTAMPTZ NULL;

CREATE INDEX questions_active_live_idx
  ON questions (active)
  WHERE active = true AND retired_at IS NULL;

UPDATE questions q
   SET retired_at = now()
 WHERE retired_at IS NULL
   AND created_by <> (SELECT id FROM users WHERE username = 'phase0_seed');
