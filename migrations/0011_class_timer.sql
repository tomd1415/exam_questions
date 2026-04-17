-- Optional countdown timer for a class's topic sets.
--
-- A teacher can attach a minutes value to a class; when a pupil in that
-- class starts a new attempt, the value is snapshotted onto the attempt
-- so mid-set edits to the class timer do not mutate an attempt already
-- underway. On submit, the client posts an elapsed-seconds count; the
-- server clamps it to [0, timer_minutes * 60 + 30] before storing.

ALTER TABLE classes
  ADD COLUMN timer_minutes INT NULL
    CHECK (timer_minutes IS NULL OR (timer_minutes BETWEEN 1 AND 180));

-- Snapshot on the attempt. Null when the class was untimed at start-time
-- or for every attempt created before this migration.
ALTER TABLE attempts
  ADD COLUMN timer_minutes INT NULL
    CHECK (timer_minutes IS NULL OR (timer_minutes BETWEEN 1 AND 180));

-- Elapsed time recorded on submit. Null for untimed attempts. We keep it
-- separate from timer_minutes so we can tell "timer not used" (both null)
-- apart from "timer ran but pupil submitted early" (minutes set, seconds set).
ALTER TABLE attempts
  ADD COLUMN elapsed_seconds INT NULL
    CHECK (elapsed_seconds IS NULL OR elapsed_seconds >= 0);
