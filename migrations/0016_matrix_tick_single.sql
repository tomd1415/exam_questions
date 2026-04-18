-- Phase 2.5 chunk 2.5a-ii — matrix_tick_single widget.
--
-- Documentation-only migration. `question_parts.expected_response_type`
-- is unconstrained TEXT (see migration 0004); the recognised set lives
-- at the application layer in src/lib/question-invariants.ts and is
-- now mirrored by the widget registry in src/lib/widgets.ts.
--
-- This migration records that 'matrix_tick_single' joins
-- multiple_choice / tick_box / short_text as a deterministically-marked
-- response type. Widget shape (rows, columns, correctByRow,
-- allOrNothing) is stored on question_parts.part_config (added in
-- migration 0015).

SELECT 1;
