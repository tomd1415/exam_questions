-- Widget-specific configuration for a question part.
--
-- Phase 2.5 introduces structured response widgets (matrix tick grids,
-- truth/trace tables with prefilled cells, cloze gaps, etc.) whose shape
-- is not captured by `expected_response_type` alone. Each widget reads
-- its own slice of `part_config` (e.g. row/column labels for a matrix,
-- gap positions for a cloze). The schema is intentionally JSONB rather
-- than per-widget columns: validation lives in the widget registry at
-- the application layer (see src/lib/widgets.ts), so adding a new
-- widget is a registry entry plus a doc-only migration, not a schema
-- change.
--
-- NULL means the widget needs no extra config — true for every existing
-- response type as of this migration (multiple_choice, tick_box,
-- short_text, medium_text, extended_response, code, algorithm,
-- trace_table). 2.5a-i ships the column empty; 2.5a-ii and later
-- chunks populate it for the new widgets.

ALTER TABLE question_parts
  ADD COLUMN part_config JSONB NULL;
