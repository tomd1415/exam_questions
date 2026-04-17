-- Per-question reveal mode: pupils can choose to submit and get feedback
-- one question at a time (default), or submit the whole attempt at once.
--
-- Additive only — existing attempts keep working. A null `submitted_at` on
-- attempt_questions means "not yet submitted by the pupil"; whole_attempt
-- mode ignores that column entirely and locks the whole attempt via
-- attempts.submitted_at as before.

ALTER TABLE users
  ADD COLUMN reveal_mode TEXT NOT NULL DEFAULT 'per_question'
    CHECK (reveal_mode IN ('per_question', 'whole_attempt'));

-- Snapshot the pupil's preference onto the attempt at start-time so a mid-
-- attempt toggle doesn't change the flow for work already underway.
ALTER TABLE attempts
  ADD COLUMN reveal_mode TEXT NOT NULL DEFAULT 'per_question'
    CHECK (reveal_mode IN ('per_question', 'whole_attempt'));

-- Per-question lock. Non-null = that question is submitted and its parts
-- are read-only. Still null for everything pre-migration and for any
-- attempt running in whole_attempt mode.
ALTER TABLE attempt_questions
  ADD COLUMN submitted_at TIMESTAMPTZ NULL;

-- Pupil's self-estimated mark, recorded after the pupil has seen the mark
-- scheme for a part still awaiting teacher marking. The service validates
-- the upper bound against the part's marks total; we only enforce >= 0 here.
ALTER TABLE attempt_parts
  ADD COLUMN pupil_self_marks INT NULL
    CHECK (pupil_self_marks IS NULL OR pupil_self_marks >= 0);
