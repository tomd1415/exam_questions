# Prompts

LLM prompt families used by the platform, with their inputs, outputs, JSON schemas, and operational rules. Every prompt has a versioned record in the `prompt_versions` table; the version id is included in every audit row.

> **Authoritative API reference.** Verify Responses API parameters, Structured Outputs schema rules, and model availability against the OpenAI Documentation MCP server at <https://developers.openai.com/mcp> before changing any schema or model id below. Training-cutoff knowledge in the developer's editor is not authoritative; the MCP is.

## General prompt rules

These apply to every prompt in the system.

1. **System prompt is fixed and not composed with pupil text.** Pupil text always arrives as a separate user-role chunk wrapped in clear delimiters.
2. **Always Structured Outputs.** Every call uses an OpenAI Responses API structured-output schema. A response that fails schema validation is rejected (not silently parsed). OpenAI strict mode requires **every key in `properties` also appear in `required`** — optional fields are expressed by giving them a nullable type (`{ "type": ["string", "null"] }`) rather than omitting them from `required`. Omitting a property from `required` produces an HTTP 400 `invalid_json_schema` on every call; see [AUDIT_2026-04-23.md](AUDIT_2026-04-23.md) for a concrete case.
3. **Marks are clipped to `[0, marks_total]` after the call.** The model can be asked to obey the bound, but the application enforces it.
4. **Confidence is required, never optional.** The model returns a calibrated `confidence` between 0.00 and 1.00. Low confidence triggers moderation.
5. **Evidence quotes are required for any non-zero mark.** If the model awards marks without quoting from the pupil's answer, the safety gate flags it.
6. **No personally identifying information is included.** Pseudonyms only; no display names, no school identifiers.
7. **Refusal handling.** If the model refuses, the application records the refusal and routes the answer to the moderation queue.
8. **Retry policy.** Single retry on transient errors. No retries on validation failure of the structured output.
9. **Costs are recorded.** Token usage is logged on every call.
10. **Kill switch.** A single environment flag disables every LLM call and routes all open responses to the teacher's manual queue.

## Prompt families

There are four families:

| Family | Phase introduced | Purpose                                |
| ------ | ---------------- | -------------------------------------- |
| A      | 5                | Question generation                    |
| B      | 3                | Marking open responses                 |
| C      | 6                | Misconception clustering and labelling |
| D      | 6                | Teacher analytics summaries            |

Each family has at least one validator-style sibling that re-checks the primary call's output against the spec or against the rubric.

---

## Family A — Question generation

Used in Phase 5 to draft new OCR-style questions from the spec, command-word vocabulary, and curated examples.

### Inputs

- `topic_code`, `subtopic_code`, `command_word_code`
- `target_marks` (1–9 typical)
- `target_response_type` (one of the values from the question schema)
- `target_difficulty_band` (1–9), `target_difficulty_step` (1–3)
- A short list of curated example structures from the existing bank (not OCR text).
- A retrieval pack: spec wording for the topic (chunked, embedded, top-k retrieved).
- Forbidden-overlap rule: do not reuse distinctive wording from any source-paper extract.

### Output schema (Zod)

```ts
const generatedQuestion = z.object({
  stem: z.string().min(20).max(2000),
  parts: z
    .array(
      z.object({
        part_label: z.string().regex(/^[a-z](\([ivx]+\))?$/),
        prompt: z.string().min(5).max(1000),
        marks: z.number().int().min(1).max(20),
        expected_response_type: z.enum([
          'multiple_choice',
          'tick_box',
          'short_text',
          'medium_text',
          'extended_response',
          'code',
          'algorithm',
          'trace_table',
        ]),
        mark_points: z
          .array(
            z.object({
              text: z.string().min(3).max(400),
              accepted_alternatives: z.array(z.string().max(200)).max(10),
              marks: z.number().int().min(1).max(5),
              is_required: z.boolean(),
            }),
          )
          .min(1)
          .max(12),
        model_answer: z.string().min(5).max(2000),
        common_misconceptions: z
          .array(
            z.object({
              label: z.string().min(2).max(60),
              description: z.string().min(5).max(400),
            }),
          )
          .max(8),
      }),
    )
    .min(1)
    .max(8),
  marks_total: z.number().int().min(1).max(20),
  topic_code: z.string(),
  subtopic_code: z.string(),
  command_word_code: z.string(),
  difficulty_band: z.number().int().min(1).max(9),
  difficulty_step: z.number().int().min(1).max(3),
  difficulty_rationale: z.string().min(10).max(500),
  teacher_notes: z.string().max(800).optional(),
  originality_self_check: z.string().min(10).max(500),
});
```

### Validator pass

A second prompt receives the generated question, the retrieval pack, and the forbidden-overlap rule, and returns:

```ts
const validationResult = z.object({
  spec_alignment: z.enum(['aligned', 'weak', 'off_spec']),
  spec_alignment_reason: z.string(),
  command_word_appropriate: z.boolean(),
  marks_to_response_appropriate: z.boolean(),
  notes: z.string().optional(),
});
```

If `spec_alignment != "aligned"` or either boolean is false, the question goes to the teacher with a "validator concern" tag.

### Originality check (deterministic, not LLM)

- Cosine similarity of the new question stem's embedding against `source_excerpts` and against existing `questions`.
- Default reject threshold: cosine ≥ 0.85 against any source excerpt; warn at ≥ 0.75.
- Reject threshold against existing questions: cosine ≥ 0.92 (true near-duplicate).

---

## Family B — Marking open responses

The most important prompt family. Used in Phase 3 onwards.

### Inputs

- The full question package: stem, the specific part being marked, marks_total for that part, command word, expected_response_type.
- The mark scheme: `mark_points` with text, accepted alternatives, mark values, required flags.
- Common misconceptions list for this question or topic.
- The pupil's redacted answer (no PII).
- A pseudonymous attempt id.

### System prompt content (high-level)

- Role: an OCR-style marker for GCSE Computer Science (J277).
- Constraints: only award marks that are evidenced in the pupil's text; never invent facts; respect the mark tariff; if the pupil writes contradictory statements that nullify each other, do not award the mark; if the pupil writes more than required and one of the additional points is wrong, follow OCR-style "first answer counts" conventions stated in the rubric block.
- Output: structured JSON only.

### Output schema (Zod)

```ts
const markingResult = z.object({
  marks_awarded: z.number().int().min(0),
  mark_points_hit: z.array(
    z.object({
      mark_point_id: z.string(),
      evidence_quote: z.string().min(1).max(500),
    }),
  ),
  mark_points_missed: z.array(z.string()), // mark_point_ids
  contradiction_detected: z.boolean(),
  over_answer_detected: z.boolean(),
  confidence: z.number().min(0).max(1),
  feedback_for_pupil: z.object({
    what_went_well: z.string().min(10).max(300),
    how_to_gain_more: z.string().min(10).max(300),
    next_focus: z.string().min(10).max(300),
  }),
  feedback_for_teacher: z.object({
    summary: z.string().max(400),
    suggested_misconception_label: z.string().max(60).optional(),
    suggested_next_question_type: z.string().max(60).optional(),
  }),
  refusal: z.boolean(),
  notes: z.string().max(400).optional(),
});
```

### Safety gate (deterministic, runs after the call)

The mark goes to moderation if **any** of:

- `confidence < 0.6`
- `marks_awarded > 0` and `mark_points_hit` is empty (marks without evidence)
- Any `evidence_quote` is not actually present (case-insensitive substring) in the pupil's redacted answer
- `marks_awarded` is clipped because it exceeded `marks_total`
- `refusal` is true
- The pupil's answer contains a flagged safeguarding pattern
- The pupil's answer contains a flagged prompt-injection pattern

### Pupil-facing feedback constraints (post-process)

- Each of the three feedback fields ≤ 280 characters.
- Reading level target: Flesch reading ease ≥ 60. If a passage falls below, the application substitutes a teacher-authored fallback (per question, optional) or shows a generic "ask your teacher to talk this through" prompt.
- No jargon outside the J277 specification's vocabulary.
- No sarcasm, no negative comparisons to other pupils, no streak shaming.

### Worked example of expected output (illustrative)

For a pupil who answered "HTTPS keeps your data safe":

```json
{
  "marks_awarded": 1,
  "mark_points_hit": [{ "mark_point_id": "42", "evidence_quote": "HTTPS keeps your data safe" }],
  "mark_points_missed": ["43", "44"],
  "contradiction_detected": false,
  "over_answer_detected": false,
  "confidence": 0.78,
  "feedback_for_pupil": {
    "what_went_well": "You named HTTPS and linked it to safety.",
    "how_to_gain_more": "Say what HTTPS protects (the data while it travels) and how (encryption).",
    "next_focus": "When the command word is 'Explain', add the reason as well as the term."
  },
  "feedback_for_teacher": {
    "summary": "Identified protocol but no mechanism. Classic recall-only answer.",
    "suggested_misconception_label": "names protocol without explaining function",
    "suggested_next_question_type": "explain"
  },
  "refusal": false
}
```

---

## Family C — Misconception clustering and labelling

Phase 6. Two complementary calls:

### C1: cluster summariser

Inputs:

- A list of (pseudonymous) flagged-misconception events with their `inferred_label` and a short text excerpt.
- Topic and command-word context.

Output schema:

```ts
const clusterSummary = z.object({
  clusters: z
    .array(
      z.object({
        label: z.string().min(2).max(60),
        description: z.string().min(10).max(400),
        representative_event_ids: z.array(z.string()).min(1).max(5),
        suggested_reteach_step: z.string().max(300),
      }),
    )
    .max(10),
});
```

### C2: per-event labeller

Inputs: a single pupil answer + question + mark scheme.
Output: `inferred_label` (string ≤ 60), `confidence` (0–1).
Used inline by the marking pipeline only when no `mark_point` was hit; otherwise the labeller is not called.

---

## Family D — Teacher analytics summaries

Phase 6. One call per artefact (no batched generation across pupils in a single prompt).

### D1: weekly pupil summary

Inputs:

- Aggregate counts of attempts, marks, and missed mark points for one pupil over the last week.
- Top three flagged misconceptions.
- The pupil's mastery profile snapshot.

Output schema:

```ts
const pupilWeeklySummary = z.object({
  one_line_headline: z.string().max(160),
  strengths: z.array(z.string().max(200)).max(3),
  focus_areas: z.array(z.string().max(200)).max(3),
  suggested_next_questions: z
    .array(
      z.object({
        topic_code: z.string(),
        command_word_code: z.string(),
        response_type: z.string(),
        difficulty_band: z.number().int().min(1).max(9),
        difficulty_step: z.number().int().min(1).max(3),
        rationale: z.string().max(200),
      }),
    )
    .max(5),
});
```

### D2: class summary

Inputs: aggregate-only data for the class (no individual rows). Output mirrors D1 but framed for a class group.

### D3: intervention groups

Inputs: pseudonymous IDs grouped by shared weakness clusters.
Output: a list of suggested groups with a recommended reteach focus per group.

---

## Versioning and change control

- Every prompt is stored in `prompts/` in the repo with a name and a semver-style version (`mark_open_response_v1.2.0.md`).
- A change to wording, schema, or model tier is a version bump. Active prompt versions are loaded into the `prompt_versions` table at startup.
- The current production version per prompt name lives in `config`. Switching is a one-line config change, not a redeploy.
- Every `awarded_marks` row records the prompt version used. This makes "did this batch use the old prompt?" answerable instantly.

## Evaluation and regression checks

A growing set of golden test cases lives in [prompts/eval/](prompts/eval/):

- Each fixture is a JSON file: question stem, part prompt, mark scheme, pupil answer, the `expected` rubric (mark range, required mark-point ids, forbidden mark-point ids, `shouldRefuse` flag, optional `maxAbsoluteError` override). Schema: [src/services/eval/fixtures.ts](src/services/eval/fixtures.ts).
- `npm run eval` (wraps [scripts/eval/run-prompt-evals.ts](scripts/eval/run-prompt-evals.ts)) replays each `active` prompt across its fixtures, scores pass/fail, and writes a report to `scripts/eval/out/{timestamp}.{json,md}`. `EVAL_DRY_RUN=1` skips the OpenAI call and uses a stub marker so the harness can be exercised in CI without an API key.
- Exit code is non-zero on any fail, so a CI job can gate prompt promotions on a clean run.
- `/admin/evals/latest` renders the most recent JSON report as an admin-only dashboard: totals card with a pass-rate band, per-prompt aggregates with worst-offender lists, and an all-failures table.
- Shipped fixtures are a synthetic seed (5 per prompt) authored to exercise every branch of the scorer. Chunk 3h's full ask is 30 anonymised real submissions per prompt — the pilot (chunk 3i) generates these.

This is how prompt changes stop breaking historical agreement with teacher marking.
