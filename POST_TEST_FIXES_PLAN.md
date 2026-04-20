# Post-test fixes plan

Ten issues surfaced while hand-testing the Phase 2.5 wizard (see
[my_notes.md](my_notes.md)). This plan chunks the fixes in dependency
order: **A → B → C → E → D**. Each chunk is one commit unless noted.

> **Scope note:** all questions currently in the running system are
> test data. Phase B is a clean delete-and-reseed, not an in-place
> repair. The teacher has no real classroom content to preserve yet.

---

## Phase A — Contrast & affordance (light + dark)

Covers issues **2, 5, 7**. Low-risk CSS + JS polish; every change must
be verified against `[data-theme='dark']` as well as light mode.

### Chunk A1 — Step-3 widget tile + step-2 chip selected state

**Scope:** the `is-selected` state on the step-3 widget tiles and
step-2 command-word chips is too subtle to see at a glance. Current
CSS only tweaks border colour; there's no fill change.

**Tasks:**

- Update `.wizard__chip.is-selected` and `.wizard__widget-tile.is-selected`
  in `src/static/site.css`: filled background via `--color-accent-*`,
  heavier border, slight scale or inner-shadow cue.
- Confirm the same selectors work under `[data-theme='dark']` (the
  accent tokens should auto-remap — if not, add dark-mode overrides
  next to the existing ones in `src/static/design-tokens.css`).
- Keep focus ring visible on top of the new background (don't rely on
  border colour alone for focus).

**Tests:**

- Extend `tests/http/wizard-v2/shell.test.ts` (or equivalent) to
  assert the selected chip/tile receives `is-selected` after POST
  round-trip.
- Visual check in both themes via `npm run dev` before commit.

### Chunk A2 — Drawing toolbar button contrast

**Scope:** pen / eraser / undo buttons in the drawing widget have
text colour too close to button background in both themes.

**Tasks:**

- Audit `src/static/logic_diagram.js` toolbar CSS (and any
  `_widget_*.eta` that inlines button styles). Move idle + active
  states onto `--color-ink-*` / `--color-surface-*` tokens with a
  ≥4.5:1 ratio.
- Add a visible `:hover` and `[aria-pressed='true']` treatment so the
  current tool is obvious.

**Tests:**

- Add `tests/browser/axe-drawing.test.ts` — load a pupil attempt page
  that renders the drawing widget, axe in light mode, then toggle
  `data-theme='dark'` and re-scan.

### Chunk A3 — Text-input contrast sweep

**Scope:** login text boxes and every `<input>` / `<textarea>` on the
teacher- and pupil-facing pages have field text + placeholder too
close to the field background.

**Tasks:**

- Token audit: `--color-field-bg`, `--color-field-ink`, `--color-field-placeholder`.
  Ensure AA contrast in both themes. Rename tokens if current names
  obscure intent.
- Update `.form-control`, `.widget input`, `.widget textarea`, and the
  login template's inline overrides.
- Placeholder colour must still pass 3:1 (WCAG 1.4.11 non-text).

**Tests:**

- Extend `tests/browser/axe.test.ts` to scan the login page and one
  sample pupil attempt page under both `data-theme='light'` and
  `data-theme='dark'`. Assert no `color-contrast` serious violations.

### Chunk A4 — Dark-mode axe sweep over the v2 wizard

**Scope:** `tests/browser/axe-wizard-v2.test.ts` currently runs in
default (light) theme only. Duplicate the loop with
`data-theme='dark'` set before navigation so contrast regressions
can't ship.

**Tasks:**

- Parametrise the existing test file over `[light, dark]`, or add a
  second describe block.
- Fix any new violations surfaced (likely the same
  `--color-accent-warm-700` publish button if dark needs a lighter
  ramp).

**Commit:** closes Phase A.

---

## Phase B — Delete-and-reseed with a shape invariant

Covers issues **9, 6, 8**. Locks the invariant "model answer shape
matches `expected_response_type`" into code, then nukes and rebuilds
seed data using it. No in-place repair — the running system has only
test data.

### Chunk B1 — Model-answer shape invariant

**Scope:** codify the shape rules in one place so both seed and
wizard submissions reject mismatches.

**Tasks:**

- Add `validateModelAnswerShape(part)` in
  `src/lib/question-invariants.ts`. Per `expected_response_type`:
  - `short_text` / `long_text`: `mark_points[].text` is a string; no
    widget-specific fields.
  - `multiple_choice`: `mark_points[].option_code` must reference a
    defined option; no free-text model answer.
  - `tick_box`: same, array of `option_code`s.
  - `matching`: `mark_points[].pairs[]` of `{left, right}`.
  - `matrix_tick_single` / `_multi`: `mark_points[].cells[]` of
    `{row, col}`.
  - `cloze_free` / `_code` / `_with_bank`: `mark_points[].gap_id` +
    accepted values array.
  - `trace_table`: `mark_points[].cells[]` of `{row, col, value}`.
  - `diagram_labels`: `mark_points[].labels[]` of `{label_id, text}`.
  - `logic_diagram` / `flowchart`: `mark_points[].graph` (JSON graph
    representation — see Phase D for the exact shape).
- Wire `validateModelAnswerShape` into the wizard publish route
  (step 9 submit) so malformed drafts can't publish.
- Wire it into the draft payload normaliser so teachers see field-level
  errors instead of opaque 500s.

**Tests:**

- Unit tests in `tests/lib/question-invariants.test.ts` — one happy
  case + one failing case per response type.
- HTTP test: publishing a draft with a mismatched shape returns 400
  with field errors.

### Chunk B2 — Rewrite the seed with correct shapes

**Scope:** `src/scripts/seed-curated-content.ts` currently stores some
model answers as plain text regardless of response type. Rewrite so
every seeded question passes `validateModelAnswerShape`.

**Tasks:**

- For each seeded question, restructure `mark_points` to the shape
  required by its `expected_response_type`.
- Where a seed question's current `expected_response_type` is wrong
  for its content (e.g. a matching question stored as `short_text`),
  fix the type.
- Drawings-as-model-answer: for any seed question that logically
  needs a drawing as the model answer, either upgrade the response
  type to a visual widget or defer the question to the Phase D
  regeneration list (see Phase D plan chunk).

**Tests:**

- `tests/seed/curated-content.test.ts` — run the seed against a clean
  DB, assert every inserted question passes `validateModelAnswerShape`.

### Chunk B3 — Delete-and-reseed migration

**Scope:** one-shot clean-up of the running dev/prod instance.

**Tasks:**

- Script `src/scripts/reset-questions.ts` that truncates
  `question_parts`, `questions`, `question_drafts`, and any dependent
  attempts/feedback rows in the correct order (or uses
  `TRUNCATE ... CASCADE`).
- Runbook entry in [RUNBOOK.md](RUNBOOK.md) — exact commands to reset
  the school VM once this is merged.
- Re-run the seed.

**Tests:**

- Manual: run against the dev Docker Postgres, confirm seed completes
  and every question renders end-to-end (pupil view, teacher review,
  admin questions list).

**Commit:** closes Phase B. The user runs `reset-questions.ts` on the
school VM as part of the deploy.

---

## Phase C — Wizard UX fixes

Covers issues **1, 4**.

### Chunk C1 — Subtopic-first cascade on step 1

**Scope:** currently the teacher picks component → topic → subtopic
top-down. Picking a subtopic directly (via the combobox) should
auto-fill topic + component.

**Tasks:**

- In the step-1 combobox JS (`src/static/v2/wizard_step_1.js` or
  wherever the combobox lives), listen for subtopic selection and
  patch the `topic_code` / `component_code` hidden fields or selects.
- Keep the select-only fallback working: if JS is off, the existing
  cascading-selects flow is untouched.
- Update `src/templates/v2/_wizard_step_1.eta` hint copy so teachers
  know they can start from any level.

**Tests:**

- `tests/http/wizard-v2/step-1.test.ts` — POST step 1 with only a
  subtopic_code set, assert the service resolves topic + component
  from curriculum data server-side (defence-in-depth; don't rely on
  JS).
- `tests/browser/wizard-step-1-cascade.test.ts` — headed Playwright:
  pick a subtopic, assert parent selects update.

### Chunk C2 — Preserve payload on validation failure

**Scope:** when the boolean/logic-gate widget editor rejects input on
POST, the re-render currently drops everything the teacher typed.
Audit every step-5 partial for the same bug.

**Tasks:**

- In `src/routes/admin-question-wizard.ts`, on validation failure
  re-render the step template with the submitted payload merged in
  (not the stored payload). Mark invalid fields via a `fieldErrors`
  map that templates consume.
- Audit pass over all 13 `_wizard_step_5_*.eta` partials: confirm each
  reads from the merged payload, not the draft payload alone.
- Special attention to `_wizard_step_5_logic_diagram.eta` and
  `_wizard_step_5_flowchart.eta` — these have non-trivial JSON
  round-trips.

**Tests:**

- Parametrised HTTP test per widget type: POST invalid data, assert
  the response contains every submitted field value back in the DOM
  plus field-level error messages.

**Commit:** closes Phase C.

---

## Phase E — Test-fixture seed

Covers issue **10**. Depends on Phase B's invariant and seed
correctness — without them the fixtures would themselves be wrong.

### Chunk E1 — Two questions per response type for a test pupil

**Scope:** a dedicated `test_pupil` user gets assigned two example
questions of every `expected_response_type` so the teacher can
exercise every widget end-to-end in one session.

**Tasks:**

- `src/scripts/seed-test-questions.ts` — idempotent seed that:
  - Upserts a `test_pupil` user (with a known password recorded in
    RUNBOOK).
  - Inserts 2 questions for each enum value in `EXPECTED_RESPONSE_TYPES`.
  - Creates an `attempts` row assigning them to the test pupil.
- Every inserted question must pass `validateModelAnswerShape`.
- Register the script in `package.json` as `npm run seed:test`.

**Tests:**

- `tests/seed/test-questions.test.ts` — run against a clean DB,
  assert exactly `2 × |EXPECTED_RESPONSE_TYPES|` questions exist, all
  assigned to the test pupil.

**Commit:** closes Phase E.

---

## Phase D — Visual editors (mini-plan only, no implementation)

Covers issue **3** plus the user's follow-up: "check for other answer
types that may also need a more visual interface."

This phase produces a **design doc**, not code. Implementation is
scoped out of this round because a visual gate editor is a week's
work on its own and the same pattern likely applies to several other
widget types.

### Chunk D-PLAN — Survey + design doc

**Scope:** produce `VISUAL_EDITORS_PLAN.md` covering:

**Survey** — one paragraph per widget type assessing whether its
authoring experience (step-5 partial) needs a visual upgrade:

| widget                            | visual editor needed?                                                                                                     | reason                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| short_text / long_text            | no                                                                                                                        | plain textarea is the right shape    |
| multiple_choice / tick_box        | no                                                                                                                        | list editor is already visual enough |
| matching                          | **maybe** — drag-to-pair might beat paired pickers                                                                        |
| matrix_tick_single / \_multi      | no                                                                                                                        | grid editor already visual           |
| cloze_free / \_code / \_with_bank | **maybe** — "click a word to blank it" beats markdown markers                                                             |
| trace_table                       | no                                                                                                                        | grid editor already visual           |
| diagram_labels                    | **yes** — teacher should place labels on the image, not enter coordinates                                                 |
| logic_diagram                     | **yes — primary driver** — click-to-place gates + wires, with per-element "editable by pupil" + "hidden from pupil" flags |
| flowchart                         | **yes** — same pattern as logic_diagram, different palette                                                                |
| (drawing-as-model-answer)         | **yes — new** — surface a drawing editor in step 6 for questions where the model answer itself needs to be a drawing      |

**Design for the logic_diagram editor** (the template for the others):

- Canvas with a gate palette (AND / OR / NOT / NAND / NOR / XOR).
- Click-to-place gates; drag to reposition; click-drag between pins to
  wire.
- Per-element metadata: `{ id, kind, x, y, label, editable_by_pupil: bool, hidden_from_pupil: bool }`.
- Same canvas component rendered on the pupil side, but gated by the
  per-element flags — pupils can only move/change what's marked
  editable, only see what isn't hidden.
- Marking (Phase 3): compare pupil's final graph to teacher's model
  on topology + labels, ignoring x/y layout.

**Shared infrastructure** proposed:

- A `CanvasEditor` JS module reused by logic_diagram, flowchart, and
  diagram_labels — each supplies its own palette + validation rules.
- JSON schema for the shared graph representation so Phase 3's marker
  parses one format, not three.

**Rollout proposal:**

- D1: logic_diagram editor + pupil-side renderer.
- D2: flowchart editor (reuses D1 infrastructure).
- D3: diagram_labels editor.
- D4: drawing-as-model-answer surface in step 6.
- D5: optional cloze "click to blank" and matching "drag to pair"
  upgrades if user still wants them after D1–D4 land.

**Commit:** closes Phase D-PLAN. A follow-up round opens
`VISUAL_EDITORS_PLAN.md` for implementation sign-off before any D1+
code is cut.

---

## Order of execution

1. **Phase A** (A1 → A2 → A3 → A4). Low-risk CSS/JS polish.
2. **Phase B** (B1 → B2 → B3). Invariant + clean reseed. Unblocks E.
3. **Phase C** (C1 → C2). Wizard UX.
4. **Phase E** (E1). Test-fixture seed, needs B's invariant.
5. **Phase D-PLAN**. Design doc; implementation deferred to its own plan.

After Phase D-PLAN merges, open a separate round to ship D1–D5.
