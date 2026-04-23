-- Chunk 3i. Pilot flag: when LLM_MARKING_PILOT=true, every LLM-
-- awarded row is additionally queued for teacher-shadow review even
-- when the safety gate didn't flag it. The row is live-visible to
-- the pupil (moderation_status can still be 'not_required'); this
-- column drives the second, parallel review surface at
-- /admin/moderation?mode=pilot.
--
-- Split from moderation_status on purpose: a row can be
-- moderation_status='not_required' (gate clean, pupil sees it) AND
-- pilot_shadow_status='pending_shadow' (teacher must still shadow-
-- review). Collapsing both into moderation_status would either hide
-- clean marks from pupils during the pilot (bad — the whole point is
-- to compare teacher-in-parallel against live AI marks) or lose the
-- "safety-gate flagged this" signal in the pilot queue UI.
--
-- Nullable when not in pilot. The partial index keeps the hot
-- "pending_shadow" list query fast regardless of table growth.

ALTER TABLE awarded_marks
  ADD COLUMN pilot_shadow_status TEXT NULL
    CHECK (pilot_shadow_status IS NULL
           OR pilot_shadow_status IN ('pending_shadow', 'reviewed'));

CREATE INDEX awarded_marks_pilot_shadow_idx
  ON awarded_marks (pilot_shadow_status)
  WHERE pilot_shadow_status = 'pending_shadow';
