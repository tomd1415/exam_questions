-- Phase 1, Chunk 7: teacher review and manual marking.
--
-- A teacher override records a replacement mark for a specific
-- awarded_marks row. When a teacher re-marks a part, the marking
-- service writes a fresh awarded_marks row with marker='teacher_override'
-- AND inserts a teacher_overrides row pointing at that new row. The
-- override row is the audit trail — every mark change is preserved,
-- even if the teacher re-marks the same part repeatedly.

CREATE TABLE teacher_overrides (
  id                BIGSERIAL PRIMARY KEY,
  awarded_mark_id   BIGINT      NOT NULL REFERENCES awarded_marks (id) ON DELETE CASCADE,
  teacher_id        BIGINT      NOT NULL REFERENCES users (id)         ON DELETE RESTRICT,
  new_marks_awarded INT         NOT NULL CHECK (new_marks_awarded >= 0),
  reason            TEXT        NOT NULL CHECK (length(reason) > 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX teacher_overrides_awarded_mark_idx ON teacher_overrides (awarded_mark_id);
CREATE INDEX teacher_overrides_teacher_idx ON teacher_overrides (teacher_id, created_at DESC);
