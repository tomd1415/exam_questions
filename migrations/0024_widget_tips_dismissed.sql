-- Phase 2.5 chunk 2.5i (Option B MVP) — per-user widget-tip dismissal.
--
-- Adds users.widget_tips_dismissed JSONB so each pupil sees the
-- "how to answer this widget" microcopy once per widget type, then
-- never again after they hit "Got it". The column stores a flat
-- object whose keys are widget keys from src/lib/widgets.ts (e.g.
-- 'matching', 'flowchart') and whose values are ISO-8601 timestamps:
--
--   { "matching": "2026-04-18T13:42:11.123Z",
--     "flowchart": "2026-04-18T13:55:02.004Z" }
--
-- Default '{}' so existing pupils get every tip on first encounter.
-- Teachers and admins also have the column but the MVP only renders
-- tips on the pupil attempt page.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS widget_tips_dismissed JSONB NOT NULL DEFAULT '{}'::jsonb;
