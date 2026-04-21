-- Chunk 3e. Pupils see AI feedback on the attempt review page under
-- the three `feedback_for_pupil` headings, but only after the teacher
-- has cleared the row out of moderation. Two columns:
--
--   awarded_marks.feedback_for_pupil
--       JSONB blob with {what_went_well, how_to_gain_more, next_focus}
--       written by writeLlmMark. Nullable because deterministic and
--       teacher_override rows never populate it.
--
--   question_parts.pupil_feedback_fallback
--       Teacher-authored fallback string shown when the LLM feedback
--       for that part scores Flesch < 60 (too hard to read). Nullable:
--       when not set, the template renders a generic "ask your
--       teacher to talk this through" prompt.

ALTER TABLE awarded_marks
  ADD COLUMN feedback_for_pupil JSONB NULL;

ALTER TABLE question_parts
  ADD COLUMN pupil_feedback_fallback TEXT NULL;
