-- Chunk 3d. The safety gate runs deterministically after every LLM
-- `awarded` outcome; when any of its rules fire, the mark goes to the
-- moderation queue with `moderation_status='pending'`. `moderation_notes`
-- stores the typed reason list (SafetyGateReason[]) so the moderation
-- detail page can render "here's why it was flagged" without re-running
-- the gate against the pupil answer on every request. Nullable because
-- deterministic and teacher_override rows never populate it.
--
-- `moderation_reviewed_by` and `moderation_reviewed_at` record who
-- closed the moderation (accept or override) and when. Both are
-- nullable until the row leaves 'pending'. An overridden row keeps
-- its original marks on this row; the teacher's new mark lives in a
-- separate awarded_marks row with marker='teacher_override' (see
-- AttemptRepo.overrideAiMarkInTxn).

ALTER TABLE awarded_marks
  ADD COLUMN moderation_notes       JSONB       NULL,
  ADD COLUMN moderation_reviewed_by BIGINT      NULL REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN moderation_reviewed_at TIMESTAMPTZ NULL;
