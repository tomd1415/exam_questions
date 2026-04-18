-- Phase 2.5 chunk 2.5b — matrix_tick_multi widget + tick_box tickExactly.
--
-- Documentation-only migration. `question_parts.expected_response_type`
-- remains unconstrained TEXT (see migration 0004); the recognised set
-- lives at the application layer in src/lib/question-invariants.ts and
-- the widget registry in src/lib/widgets.ts.
--
-- This migration records that 'matrix_tick_multi' joins
-- 'matrix_tick_single' as a deterministically-marked grid response
-- type, and that the existing 'tick_box' value gains an optional
-- `part_config = { tickExactly: <number> }` payload (added at the
-- column level in migration 0015) that the marker uses to apply a
-- "tick exactly N" constraint without rejecting the form. Existing
-- tick_box rows have NULL part_config and behave as before.

SELECT 1;
