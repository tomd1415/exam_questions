# Question authoring — JSON reference for curated seed content

This document is a **self-contained specification**. An AI (or future-me) can
read it end-to-end and produce a valid curated question JSON file for any of
the 17 widget types, without needing to read the codebase. It is derived
from — and must stay consistent with — the authoritative sources:

- `src/lib/content-schema.ts` — top-level Zod schema (`CuratedQuestionJson`).
- `src/lib/question-invariants.ts` — `EXPECTED_RESPONSE_TYPES`, `SOURCE_TYPES`,
  and the model-answer shape invariant.
- `src/lib/widgets.ts` — per-widget `part_config` JSON Schema + validator.
- `migrations/0006_seed_curriculum.sql` — curriculum codes.

If the code disagrees with this doc, the code wins. File a doc fix.

---

## 1. Where files live and how they are loaded

- Place a new question file at `content/curated/<slug>.json`. One question
  per file. The slug is free-form — convention is `<topic>_<short-name>.json`
  (e.g. `1.1_cache.json`) but the file name is not parsed.
- Run `npm run content:seed` to load it. The seeder:
  1. Reads every `*.json` **directly inside** `content/curated/` — it does
     **not** recurse into subdirectories. Use `content/curated/retired/` to
     archive content you do not want loaded (see §10).
  2. Parses each file with `CuratedQuestionJson` (Zod) then re-validates
     with `validateQuestionDraft` against live curriculum codes and with
     the widget registry against `part_config`.
  3. Upserts on `similarity_hash = 'curated:' + external_key`. Re-seeding
     the same file is a no-op; editing fields and re-seeding updates the
     existing row in place.
- Loaded questions land in `approval_status = 'approved'` and are
  immediately visible to pupils.

## 2. Top-level JSON shape

Every question is a single JSON object with these keys. Unknown keys are
rejected (`additionalProperties: false`).

```jsonc
{
  "external_key": "<slug, letters/digits/._- only, max 120 chars>",
  "component_code": "J277/01" | "J277/02",
  "topic_code":     "<one of §3.2>",
  "subtopic_code":  "<one of §3.3>",
  "command_word_code": "<one of §3.4>",
  "archetype_code":    "<one of §3.5>",
  "expected_response_type": "<one of §4>",
  "stem":  "<1..4000 chars — shared context shown above the parts>",
  "model_answer": "<1..4000 chars — see §5 for per-type shape rules>",
  "feedback_template": null,      // optional, null or omitted = no template
  "difficulty_band": 1..9,          // 1 easiest, 9 hardest
  "difficulty_step": 1..3,          // relative difficulty within the band
  "source_type": "teacher" | "imported_pattern" | "ai_generated",
  "review_notes": null,             // optional freeform (<=2000 chars)
  "parts": [
    {
      "label":  "(a)",              // 1..20 chars, unique within the question
      "prompt": "…",                // 1..2000 chars
      "marks":  2,                  // integer >= 0
      "expected_response_type": "<must match this part's widget, see §4>",
      "part_config": { … } | null,  // widget-specific config, see §6
      "mark_points": [              // at least one required
        {
          "text": "…",              // 1..1000 chars
          "marks": 1,               // integer >= 0, default 1
          "required": false,        // default false
          "accepted_alternatives": []
        }
      ],
      "misconceptions": [           // optional, default []
        { "label": "…", "description": "…" }
      ]
    }
  ]
}
```

### Rules that catch most authors out

- `external_key` must match `^[a-z0-9][a-z0-9._-]*$` (case-insensitive). We
  use `j277-<component>-<topic>-<short-name>` as a convention — e.g.
  `j277-1-1-alu-purpose`. The slug is used verbatim to derive the
  idempotency hash, so never change it once a question is published.
- `part_label` values must be unique inside one question. OCR convention is
  `(a)`, `(b)`, `(c)(i)`, `(c)(ii)` — any string works but pupils see it.
- The question-level `expected_response_type` is a summary for the bank
  list. If a question has exactly one part and the part's type matches,
  the model-answer shape invariant (§5) kicks in.
- Every part needs at least one `mark_point`. `marks_total` is computed
  by summing `parts[*].marks` — keep it coherent with the mark_points.
- `difficulty_band` drives selection: 1–3 is warm-up, 4–6 is main paper
  territory, 7–9 is stretch. `difficulty_step` refines ordering inside a
  band.

## 3. Curriculum codes

These are all hand-keyed from the OCR J277 specification v3.0 and live in
migration `0006_seed_curriculum.sql`. Any new content must reference a code
that already exists in that migration.

### 3.1 Components

| Code      | Title                                              |
| --------- | -------------------------------------------------- |
| `J277/01` | Computer systems                                   |
| `J277/02` | Computational thinking, algorithms and programming |

### 3.2 Topics

| Code  | Component | Title                                                                    |
| ----- | --------- | ------------------------------------------------------------------------ |
| `1.1` | J277/01   | Systems architecture                                                     |
| `1.2` | J277/01   | Memory and storage                                                       |
| `1.3` | J277/01   | Computer networks, connections and protocols                             |
| `1.4` | J277/01   | Network security                                                         |
| `1.5` | J277/01   | Systems software                                                         |
| `1.6` | J277/01   | Ethical, legal, cultural and environmental impacts of digital technology |
| `2.1` | J277/02   | Algorithms                                                               |
| `2.2` | J277/02   | Programming fundamentals                                                 |
| `2.3` | J277/02   | Producing robust programs                                                |
| `2.4` | J277/02   | Boolean logic                                                            |
| `2.5` | J277/02   | Programming languages and Integrated Development Environments            |

### 3.3 Subtopics

| Code    | Title                                             |
| ------- | ------------------------------------------------- |
| `1.1.1` | Architecture of the CPU                           |
| `1.1.2` | CPU performance                                   |
| `1.1.3` | Embedded systems                                  |
| `1.2.1` | Primary storage (memory)                          |
| `1.2.2` | Secondary storage                                 |
| `1.2.3` | Units                                             |
| `1.2.4` | Data storage                                      |
| `1.2.5` | Compression                                       |
| `1.3.1` | Networks and topologies                           |
| `1.3.2` | Wired and wireless networks, protocols and layers |
| `1.4.1` | Threats to computer systems and networks          |
| `1.4.2` | Identifying and preventing vulnerabilities        |
| `1.5.1` | Operating systems                                 |
| `1.5.2` | Utility software                                  |
| `1.6.1` | Ethical, legal, cultural and environmental impact |
| `2.1.1` | Computational thinking                            |
| `2.1.2` | Designing, creating and refining algorithms       |
| `2.1.3` | Searching and sorting algorithms                  |
| `2.2.1` | Programming fundamentals                          |
| `2.2.2` | Data types                                        |
| `2.2.3` | Additional programming techniques                 |
| `2.3.1` | Defensive design                                  |
| `2.3.2` | Testing                                           |
| `2.4.1` | Boolean logic                                     |
| `2.5.1` | Languages                                         |
| `2.5.2` | The Integrated Development Environment (IDE)      |

A subtopic's topic is fixed; `validateQuestionDraft` rejects mismatched
pairs.

### 3.4 Command words

Codes (verbatim from the OCR spec §3d). Pick the one whose definition
matches what the prompt actually asks for — pupils learn to read these.

`add`, `analyse`, `annotate`, `calculate`, `compare`, `complete`, `convert`,
`define`, `describe`, `design`, `discuss`, `draw`, `evaluate`, `explain`,
`give`, `how`, `identify`, `justify`, `label`, `list`, `order`, `outline`,
`refine`, `show`, `solve`, `state`, `tick`, `what`, `write_rewrite`

### 3.5 Archetypes

| Code                   | Use for                                                              |
| ---------------------- | -------------------------------------------------------------------- |
| `recall`               | Single-fact recall (typically state/identify/define).                |
| `explain`              | Fact + reason or causation (typically explain/describe/give).        |
| `compare`              | Similarities and differences across two or more items.               |
| `evaluate`             | Balanced assessment with judgement (evaluate/discuss/justify).       |
| `algorithm_completion` | Complete a partially given algorithm (pseudocode or flow).           |
| `code_writing`         | Write a program/function from scratch.                               |
| `trace_table`          | Produce or complete a trace table for a given algorithm or program.  |
| `extended_response`    | Multi-mark structured response, often describe + explain + evaluate. |

## 4. Expected response types (17)

The `expected_response_type` string must be exactly one of:

```
multiple_choice   tick_box         short_text         medium_text
extended_response code             algorithm          trace_table
matrix_tick_single  matrix_tick_multi  cloze_free      cloze_with_bank
cloze_code        matching         logic_diagram      diagram_labels
flowchart
```

Widgets with `marker: 'deterministic'` are auto-marked. Widgets with
`marker: 'teacher_pending'` queue for teacher review:

- Deterministic: `multiple_choice`, `tick_box`, `short_text`, `trace_table`,
  `matrix_tick_single`, `matrix_tick_multi`, `cloze_free`, `cloze_with_bank`,
  `cloze_code`, `matching`, `diagram_labels`.
- Teacher-review: `medium_text`, `extended_response`, `code`, `algorithm`,
  `logic_diagram`, `flowchart`.

For teacher-review widgets, `mark_points` describe indicators the teacher
can tick against the pupil's response; they are not used for auto-marking.

## 5. Model-answer shape (required for deterministic single-part questions)

When a question has exactly one part AND the question's
`expected_response_type` equals that part's, the marker enforces the
following shape on `model_answer`:

| Widget                                        | `model_answer` must be …                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `short_text`                                  | any non-empty prose (no structural check)                                                      |
| `medium_text`                                 | any non-empty prose                                                                            |
| `extended_response`                           | any non-empty prose                                                                            |
| `code`, `algorithm`                           | any non-empty prose                                                                            |
| `multiple_choice`                             | equal (verbatim) to one entry in `part_config.options`                                         |
| `tick_box`                                    | JSON array of option strings, each drawn from `part_config.options`                            |
| `matching`                                    | JSON array of `[leftIdx, rightIdx]` integer pairs                                              |
| `cloze_free`, `cloze_with_bank`, `cloze_code` | JSON object `{ "<gap id>": "answer", … }` with **every** gap id present                        |
| `matrix_tick_single`                          | JSON object `{ "<row>": "<column>", … }` one entry per row, columns from `part_config.columns` |
| `matrix_tick_multi`                           | JSON object `{ "<row>": ["col", …], … }` one entry per row                                     |
| `trace_table`                                 | JSON object `{ "r,c": "value", … }` — keys must match `\d+,\d+`                                |
| `diagram_labels`                              | JSON object `{ "<hotspot id>": "label", … }` covering every hotspot                            |
| `logic_diagram`, `flowchart`                  | any non-empty prose (teacher review)                                                           |

For multi-part questions, `model_answer` is a single prose summary covering
all parts — the shape check is skipped.

## 6. Per-widget `part_config` reference

Every widget entry below includes: purpose, constraints distilled from
`src/lib/widgets.ts`, a minimal example, and any invariants that the
registry validator checks in addition to the JSON Schema.

All widgets other than `short_text`, `medium_text`, `extended_response`,
`code`, `algorithm` require a `part_config`; the free-text widgets reject
a non-null `part_config` (set it to `null` or omit it).

### 6.1 `multiple_choice`

Exactly one `options` array; every entry is a non-empty, unique string.

```jsonc
{ "options": ["Fetch", "Decode", "Execute", "Store"] }
```

### 6.2 `tick_box`

Optional `tickExactly` (positive integer) forces a fixed count of ticks.
Optional `options` lists the pool the pupil sees; if omitted the wizard
derives options from `mark_points`.

```jsonc
{ "tickExactly": 2, "options": ["Bounds check", "Whitelist", "Comment out errors", "Type check"] }
```

### 6.3 `matrix_tick_single`

Every row picks exactly one column. `correctByRow` is aligned with `rows`
by index, and each entry must appear in `columns`.

```jsonc
{
  "rows": ["Bubble sort", "Linear search", "Binary search"],
  "columns": ["Sorting algorithm", "Searching algorithm"],
  "correctByRow": ["Sorting algorithm", "Searching algorithm", "Searching algorithm"],
  "allOrNothing": false,
}
```

### 6.4 `matrix_tick_multi`

Each row may require zero or more ticks. `correctByRow` is an array-of-arrays
aligned with `rows`; every inner entry must be a column name.

```jsonc
{
  "rows": ["RAM", "ROM"],
  "columns": ["Volatile", "Read-only", "Stores BIOS"],
  "correctByRow": [["Volatile"], ["Read-only", "Stores BIOS"]],
  "partialCredit": true,
}
```

### 6.5 `cloze_free`

Text contains `{{id}}` placeholders that match `gaps[*].id` (regex
`^[A-Za-z0-9_-]+$`). Every gap lists at least one acceptable answer.
Optional `bank` adds visible hint words but is not required.

```jsonc
{
  "text": "Eight bits make one {{u1}}. 1024 bytes make one {{u2}}.",
  "gaps": [
    { "id": "u1", "accept": ["byte", "B"] },
    { "id": "u2", "accept": ["kilobyte", "kibibyte", "KB", "KiB"] },
  ],
}
```

`caseSensitive` / `trimWhitespace` on a gap default to false / true
respectively.

### 6.6 `cloze_with_bank`

As `cloze_free` but `bank` is required, minItems 1, unique items. Include
distractors so the bank is not a giveaway.

```jsonc
{
  "text": "A {{d1}} forwards traffic within a LAN; a {{d2}} joins LANs into a WAN.",
  "gaps": [
    { "id": "d1", "accept": ["switch"] },
    { "id": "d2", "accept": ["router"] },
  ],
  "bank": ["switch", "router", "hub", "bridge"],
}
```

### 6.7 `cloze_code`

Same shape as `cloze_free`; the UI renders the passage in a monospace code
block. Use for pseudocode or program fill-ins.

```jsonc
{
  "text": "for i = 1 to {{stop}}\n  print({{what}})\nnext i",
  "gaps": [
    { "id": "stop", "accept": ["5"] },
    { "id": "what", "accept": ["i"] },
  ],
}
```

### 6.8 `trace_table`

A grid of rows × columns. `prefill` populates read-only cells; `expected`
lists the author-marked cells. Both use `"row,col"` string keys (zero-based
indexes). `marking.mode` is `perCell` (default), `perRow`, or
`allOrNothing`.

```jsonc
{
  "columns": [
    { "name": "i", "width": 3 },
    { "name": "total", "width": 4 },
    { "name": "output", "width": 6 },
  ],
  "rows": 5,
  "prefill": { "0,0": "1", "1,0": "2", "2,0": "3", "3,0": "4" },
  "expected": { "0,1": "2", "1,1": "6", "2,1": "12", "3,1": "20", "4,2": "20" },
  "marking": { "mode": "perCell" },
}
```

### 6.9 `matching`

Pupil pairs left-row i with right-column j. `correctPairs` lists the
`[i, j]` pairs that earn a mark; the right column may be longer than the
left (distractors) or shorter (options reused across rows).

```jsonc
{
  "left": ["HTTP", "SMTP", "FTP"],
  "right": ["web pages", "email", "file transfer", "remote shell"],
  "correctPairs": [
    [0, 0],
    [1, 1],
    [2, 2],
  ],
  "partialCredit": true,
}
```

### 6.10 `diagram_labels`

Pupils type short labels into hotspots overlaid on an image. `imageUrl`
must start with `/static/` or `https://`. `width`/`height` are the
natural pixel dimensions the hotspots are coordinated against. Each
hotspot's `accept` list drives deterministic marking.

```jsonc
{
  "imageUrl": "/static/curated/network-topology-star.svg",
  "imageAlt": "Star topology with a central switch and four hosts.",
  "width": 600,
  "height": 360,
  "hotspots": [
    { "id": "centre", "x": 260, "y": 140, "width": 100, "height": 60, "accept": ["switch", "hub"] },
    { "id": "host1", "x": 40, "y": 40, "width": 120, "height": 40, "accept": ["client", "host"] },
  ],
}
```

Hotspot ids match `^[A-Za-z0-9_-]{1,40}$`; the image pattern enforces no
external CDNs.

### 6.11 `logic_diagram` (five variants)

A `variant` discriminator chooses the shape. The validator runs the
corresponding branch; mixing fields from two variants is rejected.

**a) `image`** — freehand drawing on a canvas; pupil PNG goes to teacher
review.

```jsonc
{ "variant": "image", "canvas": { "width": 600, "height": 400 } }
```

**b) `gate_in_box`** — teacher places labelled gates and terminals; blank
"?" gates are filled in by the pupil and auto-marked per blank via `accept`.

```jsonc
{
  "variant": "gate_in_box",
  "canvas": { "width": 600, "height": 400 },
  "gates": [
    { "id": "g1", "type": "AND", "x": 200, "y": 100, "width": 80, "height": 50 },
    { "id": "g2", "x": 400, "y": 100, "width": 80, "height": 50, "accept": ["OR"] },
  ],
  "terminals": [
    { "id": "A", "kind": "input", "label": "A", "x": 40, "y": 80 },
    { "id": "B", "kind": "input", "label": "B", "x": 40, "y": 160 },
    { "id": "Q", "kind": "output", "label": "Q", "x": 540, "y": 120 },
  ],
  "wires": [
    { "from": "A", "to": "g1" },
    { "from": "B", "to": "g1" },
    { "from": "g1", "to": "g2" },
    { "from": "g2", "to": "Q" },
  ],
}
```

Gate/terminal/wire ids all match `^[A-Za-z0-9_-]{1,40}$`. Terminal labels
are <=8 characters.

**c) `guided_slots`** — pupil picks from a dropdown per slot.

```jsonc
{
  "variant": "guided_slots",
  "slots": [
    {
      "id": "op1",
      "prompt": "Which gate outputs 1 only when both inputs are 1?",
      "options": ["AND", "OR", "NOT", "XOR"],
      "accept": "AND",
    },
  ],
}
```

**d) `boolean_expression`** — pupil types a Boolean expression; marker
tokenises and matches against `accept`.

```jsonc
{
  "variant": "boolean_expression",
  "accept": ["(A AND B) OR NOT C", "NOT C OR (A AND B)"],
  "allowedOperators": ["AND", "OR", "NOT"],
  "normaliseSymbols": true,
}
```

**e) `gate_palette`** — pupil drags gates onto a canvas; marker runs the
truth table the author supplies.

```jsonc
{
  "variant": "gate_palette",
  "canvas": { "width": 600, "height": 400 },
  "terminals": [
    { "id": "A", "kind": "input", "label": "A", "x": 40, "y": 80 },
    { "id": "B", "kind": "input", "label": "B", "x": 40, "y": 160 },
    { "id": "Q", "kind": "output", "label": "Q", "x": 540, "y": 120 },
  ],
  "palette": ["AND", "OR", "NOT"],
  "maxGates": 4,
  "expected": {
    "truthTable": [
      { "inputs": { "A": 0, "B": 0 }, "output": 0 },
      { "inputs": { "A": 0, "B": 1 }, "output": 0 },
      { "inputs": { "A": 1, "B": 0 }, "output": 0 },
      { "inputs": { "A": 1, "B": 1 }, "output": 1 },
    ],
  },
}
```

### 6.12 `flowchart` (two variants)

**a) `image`** — freehand drawing on a canvas.

```jsonc
{ "variant": "image", "canvas": { "width": 600, "height": 500 } }
```

**b) `shapes`** — teacher places flowchart shapes; any shape with `accept`
but no `text` is a pupil-fill blank, auto-marked.

Shape types: `terminator` (Start/Stop), `process` (rectangle),
`decision` (diamond), `io` (parallelogram). Provide `text` for prefilled
shapes, `accept` for blank ones (provide one, not both).

```jsonc
{
  "variant": "shapes",
  "canvas": { "width": 600, "height": 400 },
  "shapes": [
    {
      "id": "start",
      "type": "terminator",
      "x": 220,
      "y": 20,
      "width": 160,
      "height": 50,
      "text": "Start",
    },
    {
      "id": "input",
      "type": "io",
      "x": 200,
      "y": 90,
      "width": 200,
      "height": 50,
      "text": "Input A, B",
    },
    {
      "id": "q1",
      "type": "decision",
      "x": 200,
      "y": 160,
      "width": 200,
      "height": 80,
      "text": "Is A > B?",
    },
    {
      "id": "out_a",
      "type": "io",
      "x": 40,
      "y": 270,
      "width": 200,
      "height": 50,
      "accept": ["Output A", "Print A", "Display A"],
    },
    {
      "id": "out_b",
      "type": "io",
      "x": 360,
      "y": 270,
      "width": 200,
      "height": 50,
      "accept": ["Output B", "Print B", "Display B"],
    },
    {
      "id": "stop",
      "type": "terminator",
      "x": 220,
      "y": 340,
      "width": 160,
      "height": 50,
      "text": "Stop",
    },
  ],
  "arrows": [
    { "from": "start", "to": "input" },
    { "from": "input", "to": "q1" },
    { "from": "q1", "to": "out_a", "label": "Yes" },
    { "from": "q1", "to": "out_b", "label": "No" },
    { "from": "out_a", "to": "stop" },
    { "from": "out_b", "to": "stop" },
  ],
}
```

### 6.13 Free-text widgets (`short_text`, `medium_text`, `extended_response`, `code`, `algorithm`)

Never attach a `part_config`. Use `null` or omit the field.

```jsonc
{
  "label": "(a)",
  "prompt": "Describe the purpose of the ALU.",
  "marks": 2,
  "expected_response_type": "short_text",
  "mark_points": [
    {
      "text": "performs arithmetic operations",
      "marks": 1,
      "accepted_alternatives": ["does calculations", "adds and subtracts"],
    },
    {
      "text": "performs logical operations",
      "marks": 1,
      "accepted_alternatives": ["handles Boolean logic", "carries out comparisons"],
    },
  ],
}
```

Only `short_text` is deterministic — the marker compares the pupil's trimmed
answer to each mark_point's text and `accepted_alternatives` (case-
insensitive). `medium_text`, `extended_response`, `code`, `algorithm` go to
teacher review; mark_points become the marker's checklist.

## 7. Mark points

- `text` (required, <=1000 chars) — short phrase the marker displays.
- `marks` (default 1) — integer, non-negative.
- `required` (default false) — hint to the marker, not structural.
- `accepted_alternatives` — only meaningful for `short_text` (exact match)
  and for deterministic widgets where the `part_config.*.accept` list is
  the true source of truth. For all other widgets it is author documentation.

For cloze/matrix/matching/trace_table, authoring convention is one mark_point
per gap / per row / per pair / per marked cell, in the same order as the
structural array. Sum of `mark_points[*].marks` should equal the part's
`marks`.

## 8. Misconceptions

Optional — these feed into the teacher-review and analytics surfaces. Each
entry is `{ "label": "short tag", "description": "what the pupil got wrong" }`.
Keep them specific to common errors rather than generic hints.

## 9. Naming convention

- `external_key`: `j277-<topic flattened>-<short-name>`, e.g.
  `j277-1-1-alu-purpose`, `j277-2-4-and-truth-table`.
- File name: `<topic>_<short-name>.json`, e.g. `1.1_alu-purpose.json`.
- `mark_point.text`: start with a verb or term, not "the pupil should…".

## 10. Retiring a question

- Never delete a `questions` row — `attempt_parts.question_part_id` is
  FK-restricted so pupils' historical attempts would break.
- The live filter is `active = true AND retired_at IS NULL`. To take a
  question out of rotation, **both steps are required** and order matters:
  1. **First**, move the JSON file to `content/curated/retired/` (the
     seeder ignores subdirectories, so it will stop re-activating).
  2. **Then**, set `retired_at = now()` on the `questions` row. A teacher
     admin UI handles this in normal operation; for bulk changes,
     migration 0027 demonstrates the pattern.
- Skipping step 1 is a bug trap: `npm run content:seed` calls
  `QuestionRepo.clearRetirement` on every curated JSON it finds on disk,
  which would un-retire the row on the next seed. The archive step is
  what makes retirement stick.

Retired questions still appear in teacher-facing list views with a "retired"
tag but never in pupil paper builders or preview selectors.

## 11. End-to-end minimal example

```jsonc
{
  "external_key": "j277-1-3-osi-layers-cloze-bank",
  "component_code": "J277/01",
  "topic_code": "1.3",
  "subtopic_code": "1.3.2",
  "command_word_code": "complete",
  "archetype_code": "recall",
  "expected_response_type": "cloze_with_bank",
  "stem": "Complete the sentences about TCP/IP model layers.",
  "model_answer": "{\"l1\": \"application\", \"l2\": \"transport\", \"l3\": \"network\"}",
  "difficulty_band": 3,
  "difficulty_step": 2,
  "source_type": "imported_pattern",
  "parts": [
    {
      "label": "(a)",
      "prompt": "Fill in the layer names using the bank below.",
      "marks": 3,
      "expected_response_type": "cloze_with_bank",
      "part_config": {
        "text": "HTTP runs at the {{l1}} layer. TCP runs at the {{l2}} layer. IP runs at the {{l3}} layer.",
        "gaps": [
          { "id": "l1", "accept": ["application"] },
          { "id": "l2", "accept": ["transport"] },
          { "id": "l3", "accept": ["network", "internet"] },
        ],
        "bank": ["application", "transport", "network", "data link"],
      },
      "mark_points": [
        { "text": "application", "marks": 1 },
        { "text": "transport", "marks": 1 },
        { "text": "network / internet", "marks": 1 },
      ],
    },
  ],
}
```

## 12. Authoring workflow at a glance

1. Decide the curriculum triple: component / topic / subtopic. Pick a
   command word and archetype that describe the cognitive ask.
2. Choose the widget — prefer deterministic widgets so pupils get
   instant feedback. Reach for teacher-review widgets when the OCR
   mark scheme actually demands extended reasoning.
3. Draft the stem (shared context) and each part's prompt. If there
   is only one part, the prompt still carries the direct instruction.
4. Fill `part_config` from §6; cross-check it renders in the wizard
   preview (`/admin/questions/new` has a live preview).
5. Write `model_answer` in the exact shape from §5.
6. Write one `mark_point` per structural unit; include `accepted_alternatives`
   only for short_text.
7. Save as `content/curated/<topic>_<slug>.json`, run `npm run content:seed`,
   and visit the pupil page to sanity-check it renders.
8. (Optional, dev-only.) To hand-test through the pupil UI without
   drawing against a live class, run `npm run test-questions:seed -- --reset`
   — every live curated question is attached to the `test_pupil`'s
   pre-loaded attempt alongside the 34 widget fixtures. See RUNBOOK §5.2.
