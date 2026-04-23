# Golden fixtures for the nightly prompt eval harness

Fixtures are JSON files under `mark_open_response/` and `mark_code_response/`.
Each file is a single marking scenario: question stem, part prompt, mark
scheme, pupil answer, and the rubric the harness grades the LLM's
output against.

Schema: see `src/services/eval/fixtures.ts`.

Runner: `npm run eval` (wraps `scripts/eval/run-prompt-evals.ts`).
The harness writes a report to `scripts/eval/out/{timestamp}.{json,md}`
and exits non-zero when any fixture fails — so CI can gate prompt
promotions on a clean run.

## Target set size

Phase 3 plan §5 chunk 3h asks for 30 fixtures per prompt authored from
real pupil submissions with IDs stripped. The files currently shipped
in this directory are a **synthetic seed** (5 per prompt) so the
harness has something to exercise before the pilot generates real
submissions. Replace them with anonymised real answers during the
pilot-seeding pass.

## Adding a fixture

1. Copy an existing file and update the answer, mark scheme, and
   `expected` block.
2. Keep `id` unique across the directory — the reporter sorts by id.
3. `mustHitMarkPointIds` must reference real ids from `markPoints`;
   the loader validates this and throws on mismatch.
4. `marksAwardedRange` is inclusive on both ends; use `[2, 2]` for an
   exact expectation and `[1, 2]` when a moderator could go either
   way. `maxAbsoluteError` defaults to 1 and bounds how far the
   LLM's mark may drift from the midpoint.
