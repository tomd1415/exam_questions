# Phase 2.5 implementation plan

**Phase in [PLAN.md](PLAN.md):** Phase 2.5 — Extended answer widgets
and authoring ergonomics. Duration estimate: 4–6 weeks of evening
work.

> **Status (2026-04-18):** Scoped, ready to start. Phase 2 chunks
> 1–8 have shipped; the pupil-feedback channel (9a/9b) is on `main`
> with the [PUPIL_FEEDBACK.md](PUPIL_FEEDBACK.md) tracker. **Phase 2
> chunk 9 (real-lesson sign-off) is deferred and rolled into Phase
> 2.5's user test** — the only Phase 2 feedback to date was about
> widget types and authoring ergonomics, both addressed by Phase
> 2.5, so running the lesson now would regenerate the same feedback
> against a soon-to-change widget set. The combined lesson at the
> end of Phase 2.5 exercises the Phase 2 paper layout, autosave,
> timer, print, and accessibility surfaces alongside every new
> Phase 2.5 widget. Phase 2.5 is inserted
> between Phase 2 and Phase 3 because a live-paper audit across the
> six 2022–2024 J277/01 and J277/02 question papers surfaced answer
> formats that are not adequately represented by the existing
> `EXPECTED_RESPONSE_TYPES` enum, and because pupils using the Phase
> 2 build have already flagged seven widget gaps (see
> [PUPIL_FEEDBACK.md](PUPIL_FEEDBACK.md) rows 1–7). Fixing the widget
> set here — before Phase 3's LLM marking prompts are written —
> avoids writing those prompts twice.

## 1. Phase goal in one paragraph

At the end of Phase 2.5, a pupil answering any J277 live-paper
question format sees a widget that fits the shape of the answer,
rather than a generic textarea with a hand-rolled convention. Matrix
ticks render as a proper grid of radios or checkboxes; cloze
questions render as prose (or code) with inline gap inputs and an
optional word bank; trace tables render as an editable grid with
named columns and optional pre-filled cells; matching renders as a
paired picker; logic diagrams, flowcharts, and labelled diagrams are
canvas-based with a palette. Every widget autosaves, is
keyboard-navigable, meets the Phase 2 accessibility bar, and stores
its answer as a single `attempt_parts.raw_answer` string (the widget
owns serialisation). Teachers author these questions through a
step-by-step wizard that asks one thing per screen and narrows
choices based on prior answers — no raw JSON editing, no single
wall-of-form page. The widget set is **frozen** at the end of this
phase so Phase 3's marking prompts are written once.

No LLM marking, no LLM-assisted authoring, no adaptive routing —
those remain Phase 3, 5, and 4 respectively. Logic diagrams,
flowcharts, and other canvas widgets introduced in this phase are
teacher-marked; Phase 3 revisits whether a deterministic or LLM
marker can parse their JSON representation.

Success is measured by the Phase 2.5 user test in
[PLAN.md](PLAN.md) §Phase 2.5: the teacher authors one question per
widget type in under 10 minutes each using only the wizard, and a
revision lesson containing at least one question of each new widget
type runs without pupils reporting the widget as "wrong shape for
this question".

## 2. What already exists (end of Phase 2)

Live on `main` as of 2026-04-18 and _not_ re-done in Phase 2.5:

- **Widget dispatcher.** `src/templates/_paper_part_widget.eta`
  branches on `question_parts.expected_response_type` and includes
  the matching partial: `_widget_mc.eta`, `_widget_tick.eta`,
  `_widget_short.eta`, `_widget_medium.eta`, `_widget_extended.eta`,
  `_widget_code.eta`, `_widget_algorithm.eta`,
  `_widget_trace_table.eta`. Each widget rehydrates from
  `attempt_parts.raw_answer` and self-serialises on save. Phase 2.5
  inherits this pattern — new widgets are new partials + a registry
  entry, not a new wire format.
- **Autosave infrastructure.** `src/static/autosave.js`
  (~150 lines, no dependencies) posts one part per call to
  `POST /attempts/:id/parts/:pid/save` with CSRF; the service-layer
  `savePartOne` is idempotent and debounced to at most one
  `attempt.part.saved` audit event per 60 s per part. Every Phase
  2.5 widget must be drivable by the existing module without a
  rewrite; the widget advertises its state through a
  `data-autosave-part-id` attribute.
- **Paper chrome and design tokens.** `src/static/paper.css`,
  `src/static/design-tokens.css`, `src/static/site.css`,
  `src/static/print.css`, and the shared `_chrome.eta` /
  `_admin_chrome.eta` layouts. `.btn--*`, `.card`, `.flash--*`,
  `.page-header`, `.empty-state`, `.site-nav`, `.breadcrumb`,
  `.admin-card`, `.admin-table`, `.stacked-form`, `.inline-form`
  classes are already in use; new widgets must reuse these, not
  ship parallel styles.
- **Countdown timer and print-to-PDF.** `classes.timer_minutes`,
  `attempts.timer_minutes`, `attempts.elapsed_seconds`;
  `src/static/timer.js`; `GET /attempts/:id/print` and
  `GET /topics/:code/print`. Phase 2.5 widgets must render
  correctly under `@media print` (Chunk 2.5i owns the audit).
- **Accessibility pass.** axe-core runs as part of
  `npm run test:human:phase2` against seven core pages with zero
  "serious" violations. `users.font_preference` (`system` |
  `dyslexic`) is live and toggles `OpenDyslexic` globally via
  `<html data-font>`. Every Phase 2.5 widget must leave the axe
  target set at zero serious and must render correctly under the
  dyslexic font.
- **Pupil feedback channel.** `pupil_feedback` table,
  `GET /feedback` (pupil submit + own history),
  `GET /admin/feedback` (teacher triage),
  `POST /admin/feedback/:id/triage`,
  `GET/POST /admin/feedback/new` (teacher logs feedback on behalf
  of a pupil). `FeedbackRepo` / `FeedbackService` with `submit`,
  `triage`, `submitOnBehalf`; audit events `feedback.submitted`,
  `feedback.submitted_on_behalf`, `feedback.triaged`. Phase 2.5
  user-test findings feed this channel, not an ad-hoc spreadsheet.
- **Content pipeline.** `content/curated/*.json` → `npm run
content:seed` with idempotent upsert preserving `question_part.id`
  values. New widget types need matching JSON schema entries in
  `content/curated/` and a seeder branch; the authoring wizard
  writes into the same tables as the seeder (Chunk 2.5j).
- **Standing rules.** Authz in `preHandler`, CSRF on every POST,
  one audit event per state change, no inline `<style>`, no new
  runtime dependencies without justification, no ES-module
  frameworks in `src/static/`. All carry over verbatim.

Eight values remain in `EXPECTED_RESPONSE_TYPES`. Phase 2.5 **adds
new values** (matrix_tick_single, matrix_tick_multi, cloze_free,
cloze_with_bank, cloze_code, matching, logic_diagram,
diagram_labels, flowchart) and **extends** one existing value
(tick_box gains a "tick exactly N" variant). The `trace_table`
widget is re-implemented on top of the existing enum value — no
schema rename — so live seeded content continues to resolve.

## 3. What Phase 2.5 will build

Grouped by user-visible surface. Detailed per-chunk breakdown is §5.

- **Widget registry.** `src/lib/widgets.ts` exports a registry keyed
  by `expected_response_type`. Each entry now carries marker
  classification, a `validateConfig` function, and wizard-facing
  metadata: `displayName`, `description`, `markPointGuidance`, an
  `exampleConfig`, and a JSON Schema (`configSchema`) describing the
  shape of `part_config`. `_paper_part_widget.eta` branches on the
  registered type rather than a hardcoded `if` chain. The full
  registry is snapshotted to `docs/widgets.schema.json` (regenerate
  with `npm run gen:widgets-schema`; freshness is enforced by a CI
  test) and re-served at runtime via `GET /api/widgets`
  (teacher/admin only) so the wizard in 2.5j and any future
  external integration can discover the question type catalogue
  without booting a Fastify route handler. Adding a widget is an
  entry + a template + (optionally) a marker + a regenerated
  schema snapshot.
- **New answer widgets,** each with its own pupil-facing partial,
  teacher-facing editor partial (used by the wizard in 2.5j), audit
  events where a state change warrants one, tests at HTTP /
  integration / (where relevant) browser layers, and a registry
  entry:
  - `matrix_tick_single` — rows × columns, one radio group per row.
  - `matrix_tick_multi` — rows × columns, checkbox group per row;
    `tick_box` extended with a "tick exactly N" constraint that
    surfaces a calm inline counter rather than an alert.
  - `cloze_free`, `cloze_with_bank`, `cloze_code` — shared data
    model, three renderers; authoring uses `{{ }}` gap syntax.
  - `trace_table` v2 — named columns, optional pre-filled cells,
    structured JSON storage (replacing the current pipe-separated
    textarea backing). **Truth tables are the same widget** —
    same grid shape, same per-cell marker, same prefill
    mechanism. Input columns are authored as prefilled cells
    (all 0/1 combinations); output columns are left empty for the
    pupil, or partly prefilled when the question gives some rows
    away (e.g. 2022/02 Q2a).
  - `matching` — drag-line on desktop, paired-dropdown fallback on
    mobile / screen reader; right-column distractors supported.
  - `logic_diagram` — free-draw canvas + gate-in-box variant; JSON
    storage of gates + wires; teacher-marked in this phase.
  - `diagram_labels` — teacher-uploaded image with click-target
    hotspots; pupil types a label into each hotspot.
  - `flowchart` — shape-aware canvas (terminator / process /
    decision), JSON storage, teacher-marked.
- **Pupil answer-entry polish.** Cross-widget UX pass: autosave
  parity, keyboard navigation across grids and gaps, mobile tap
  targets, ARIA labelling, undo-one-level for destructive edits in
  the canvas widgets, "how to answer this widget" microcopy on first
  encounter (dismissible, remembered per user).
- **Teacher question-creation wizard.** `/admin/questions/new` is
  replaced with a nine-step wizard that asks one question per
  screen, saves after each step, and narrows choices based on
  earlier answers (e.g. "write an algorithm" does not offer
  matrix_tick on the widget picker). The last step is a "review
  and try yourself" preview that runs the pupil flow against the
  deterministic marker so rubric errors are caught by the author
  before pupils see them.
- **Authoring ergonomics.** Clone-a-question, save-as-draft at
  every step, question-bank filters (topic / command word / widget
  / difficulty), inline help authored in plain language.

## 4. What Phase 2.5 will _not_ build

From [PLAN.md](PLAN.md) §Phase 2.5 "Do not build", expanded:

- **No LLM marking.** All new widgets that are not trivially
  deterministic route to `marker='teacher_pending'` exactly as the
  Phase 1/2 open-response types do. Phase 3 revisits.
- **No LLM-assisted authoring.** The wizard is deterministic —
  dropdowns, pickers, previews. No "write the stem for me" button,
  no "suggest a model answer" button. Phase 5.
- **No new marking pipeline.** Per-widget deterministic markers
  (matrix_tick, cloze, matching, trace_table) plug into the
  existing Phase 1 marker dispatch; nothing about the overall
  pipeline changes.
- **No pixel-grid widget.** One occurrence across six audited
  papers (2023/01 Q3bii). Teacher uploads an image and asks for a
  text description as an `extended_response`, or uses the
  free-draw logic canvas as a fallback. Revisit if demand emerges.
- **No sort-step visualisation widget.** One occurrence
  (2022/02 Q3a). Same fallback as pixel-grid.
- **No cross-question "question packs" or templates.** Each
  question is authored individually via the wizard. Clone covers
  near-duplicates.
- **No rich-text editor for stems.** Stems remain plain text with a
  live preview. A rich-text editor is a large scope area and not
  required for J277 content.
- **No offline / service-worker support for canvas widgets.** The
  canvas widgets require a live session so autosave can persist
  JSON; offline-draft mode is out of scope.
- **No mobile-first redesign of the admin UI.** The wizard is
  desktop-first (authoring happens on a laptop). Pupil answer
  entry remains the mobile target.
- **No change to `raw_answer` storage contract.** Every widget
  serialises to and rehydrates from a single `TEXT` column; no
  per-widget join tables. Adding a join table is a Phase 6 / 7
  decision if analytics justify it.

## 5. Chunk-by-chunk plan

Standing rules from [PHASE1_PLAN.md](PHASE1_PLAN.md) §5 and
[PHASE2_PLAN.md](PHASE2_PLAN.md) §5 carry over verbatim.

Three extra Phase 2.5 rules:

- **Widgets register themselves.** No new `if
(expected_response_type === 'matrix_tick_single')` branches in
  routes, services, or templates outside the widget registry and
  its partials. Adding a tenth widget should touch the registry,
  one template, and (optionally) one marker — not twelve files.
- **Widgets are subject-agnostic by default.** Identifiers,
  widget registry keys, audit event names, CSS class names, and
  pupil-facing copy outside the question content itself must not
  embed "J277", "computer science", "pseudocode", or any other
  subject-specific vocabulary. Subject terminology belongs in
  question content and subject-scoped config (see PLAN.md §"Design
  decisions worth recording" — multi-subject rollout).
- **Every widget chunk ships a seeder fixture.** `content/curated/`
  gains a minimal example so the seeder, widget renderer, and (if
  applicable) deterministic marker are all exercised by
  `npm run content:seed && npm run check` on every PR.

### Chunk 2.5a — Matrix tick (single-select per row)

**Goal.** The single most common table format across all six
audited papers renders as a proper radio grid. Pupil ticks exactly
one box per row from a fixed column set; answer is deterministically
marked per row.

**Schema.** Two migrations, split because 2.5a is itself split into
2.5a-i (registry + part_config plumbing, baseline green, no new
widget visible to users) and 2.5a-ii (matrix_tick_single widget
rides on top of the registry):

- `0015_question_part_config.sql` — `ALTER TABLE question_parts
ADD COLUMN part_config JSONB NULL`. `question_parts.part_config`
  did **not** previously exist (the older PHASE2.5 draft assumed
  it; correcting the record). All existing rows stay NULL; widgets
  that need structured config opt in. Lands in 2.5a-i.
- `0016_matrix_tick_single.sql` — no DDL. Documentation-only
  migration recording that `matrix_tick_single` is now a
  recognised value of `question_parts.expected_response_type` (the
  column is unconstrained TEXT; the source of truth is
  `EXPECTED_RESPONSE_TYPES` in `src/lib/question-invariants.ts`
  and the new widget registry in `src/lib/widgets.ts`). Lands in
  2.5a-ii alongside the type addition.
- The grid shape (rows, columns, correct-cell per row) lives in
  `question_parts.part_config` per the new column. Shape
  documented in [DATA_MODEL.md](DATA_MODEL.md) and in
  [src/lib/widgets.ts](src/lib/widgets.ts).

**App code.**

- `src/lib/widgets.ts` (new): registry type and the first three
  entries (`matrix_tick_single` plus the existing `multiple_choice`
  and `tick_box` migrated to the registry so the shape is proven
  against a working baseline).
- `src/templates/_widget_matrix_tick_single.eta`: renders a
  `<table class="matrix-tick">` with row headings in the first
  column and one `<input type="radio" name="row-{{i}}">` per cell.
  `aria-describedby` points at the part's marks tag; each row
  group has an `aria-label` derived from the row heading.
- `src/static/paper.css` additions: `.matrix-tick` grid styles,
  focus states, high-contrast row striping that survives the
  OpenDyslexic font.
- `src/services/attempts.ts`: a `matrixTickSingle` deterministic
  marker reading `part_config.correctByRow`; one mark per correct
  row; configurable "all-or-nothing" flag per part.
- `content/curated/` seeder gains a minimal fixture with one
  `matrix_tick_single` question (three rows, three columns).

**Audit events added.** None (re-uses `attempt.part.saved`).

**Tests.**

| Level       | File                                           | What it proves                                                                                                                                                          |
| ----------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | `tests/unit/widgets-registry.test.ts`          | Registry exports an entry per known `expected_response_type`; every entry has a partial file that exists on disk; `deterministicMarker` is either `null` or a callable. |
| Integration | `tests/integration/matrix-tick-marker.test.ts` | All-correct → full marks; one wrong row → N−1 marks; "all-or-nothing" flag → 0 when any row wrong; invalid row index in `raw_answer` → deterministic 0, no crash.       |
| HTTP        | `tests/http/pupil-widget-matrix-tick.test.ts`  | GET renders one radio group per row with correct `name`; POST save round-trips the answer; re-render populates the previously selected radio.                           |
| Browser     | `scripts/phase2_5-browser.ts` matrix-tick step | Keyboard-only: Tab lands on the first row's group; Arrow keys move within the row without changing row; Tab moves to next row; Enter on the final `<button>` submits.   |
| Human       | HUMAN_TEST_GUIDE §2.5.a                        | Teacher and pupil both describe the widget unprompted as "feels like the real table on the paper".                                                                      |

**Exit criteria.** At least two seeded matrix_tick_single
questions in `content/curated/`; axe-core "serious" count
unchanged; marker covered end-to-end by integration tests.

### Chunk 2.5b — Matrix tick (multi-select per row) and multi-select tick_box

**Goal.** Cover "tick one or more boxes on each row"
(2022/01 Q6a(ii), 2023/01 Q4a) and "tick **two** boxes" non-matrix
variants (2023/01 Q1d). One chunk because they share data shape,
marker, and most of the renderer.

**Schema.** Migration `0017_matrix_tick_multi.sql`:

- Add `matrix_tick_multi` to `expected_response_type`.
- `tick_box` gains an optional `part_config.tickExactly: number`;
  absent → existing single-select behaviour.

**App code.**

- `src/templates/_widget_matrix_tick_multi.eta`: checkbox grid
  with a per-row live counter ("1/2 ticked"). Over-tick does not
  reject the input; the marker handles it.
- `src/templates/_widget_tick.eta` extended: when
  `tickExactly` is set, a calm inline counter appears beneath the
  group; submitting under- or over-ticked passes through to the
  marker (which scores accordingly).
- Marker: set-equality per row (or per part for non-matrix
  multi-select); configurable partial credit.
- Registry entries for `matrix_tick_multi`; `tick_box` entry gets
  the extended schema.

**Audit events added.** None.

**Tests.**

| Level       | File                                           | What it proves                                                                                                                                       |
| ----------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Integration | `tests/integration/matrix-tick-multi.test.ts`  | Set-equality scoring; partial-credit flag; over-tick scored as zero for that row; under-tick partial; marker is pure (no DB writes beyond the mark). |
| HTTP        | `tests/http/pupil-widget-matrix-multi.test.ts` | Multi-select renders a checkbox group per row; `tickExactly` on `tick_box` renders a counter; counter updates via JS without autosave storm.         |
| Browser     | `scripts/phase2_5-browser.ts` multi-tick step  | Keyboard-only: space toggles; Arrow navigates within row; Tab moves between rows; submit works at any tick count (marker, not widget, rejects).      |
| Human       | HUMAN_TEST_GUIDE §2.5.b                        | Pupil does a "tick exactly 2" item without the counter feeling nagging; teacher confirms the per-row counter is not oppressive.                      |

**Exit criteria.** `tick_box` single-select regression coverage
still green; the seeder has at least one question exercising
`tickExactly`.

### Chunk 2.5c — Cloze widgets

**Goal.** Three cloze variants — `cloze_free`, `cloze_with_bank`,
`cloze_code` — built on one data model and one widget partial
switched by a rendering flag. Gaps in prose; optional word bank
above the prose; monospaced code-block renderer for the code
variant.

**Schema.** Migration `0018_cloze_response_types.sql`:

- Add `cloze_free`, `cloze_with_bank`, `cloze_code` to
  `expected_response_type`.
- `part_config` JSON carries `{ text, gaps: [{id, accept:
string[], caseSensitive, trimWhitespace}], bank?: string[] }`.
  `text` uses `{{gap-id}}` markers for substitution at render
  time.

**App code.**

- `src/lib/cloze.ts` (new): pure functions `parseClozeText(text)`
  → segments, `markCloze(gaps, pupilAnswers)` → per-gap
  hit/miss, `summariseCloze(gaps, answers)` for the review page.
  100% branch coverage target — the regex-ish parser is the
  riskiest part of the chunk.
- `src/templates/_widget_cloze.eta`: iterates segments; renders
  text chunks verbatim and gap chunks as `<input
type="text" class="cloze-gap" …>`. If `rendering === 'code'`,
  wraps in a `<pre class="cloze-code">` and forbids line reflow
  (CSS `white-space: pre`). If a bank is present, renders
  `<ul class="cloze-bank">` above the prose with
  `role="list"`, each term as a `<li>` with a drag handle on
  desktop and a "copy" button on mobile.
- Serialisation: JSON object `{gapId: answer, …}` stored in
  `raw_answer`. Rehydration reads this and populates each input.
- Marker: set-match per gap (`accept` is an array of acceptable
  values); configurable case / whitespace handling.
- `src/static/paper.css`: `.cloze-gap`, `.cloze-bank`,
  `.cloze-code` styles; bank terms are tap-targets ≥44px; gap
  inputs are as wide as the longest acceptable answer.

**Audit events added.** None.

**Tests.**

| Level       | File                                     | What it proves                                                                                                                                                                   |
| ----------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | `tests/unit/cloze-parser.test.ts`        | Text with 0, 1, N gaps parses correctly; malformed `{{ }}` produces a readable error; escaped braces pass through; 100% branch coverage.                                         |
| Integration | `tests/integration/cloze-marker.test.ts` | All-correct full marks; one wrong gap partial; accept-list equivalence (`"="` vs `"equals"`); case-insensitive option; whitespace-trim option; unknown gap id in answer ignored. |
| HTTP        | `tests/http/pupil-widget-cloze.test.ts`  | Each of the three variants GET-renders as expected; POST round-trips; re-render populates; code variant preserves whitespace; bank renders only when present.                    |
| Browser     | `scripts/phase2_5-browser.ts` cloze step | Tab moves between gaps in document order; bank drag works on desktop; bank "copy" works on mobile emulator; code variant preserves indentation visually.                         |
| Human       | HUMAN_TEST_GUIDE §2.5.c                  | Pupil completes a bank cloze and a code cloze; reports the bank is a help, not a distraction; code cloze reads as code, not as a reformatted mess.                               |

**Exit criteria.** Resolves rows 3 and 4 of
[PUPIL_FEEDBACK.md](PUPIL_FEEDBACK.md) (cloze_with_bank and
cloze_free). At least one seeded question per variant.

### Chunk 2.5d — Trace table (proper grid) with optional pre-filled cells

**Goal.** Replace the Phase 2 pipe-separated textarea backing the
`trace_table` widget (row 1 of [PUPIL_FEEDBACK.md](PUPIL_FEEDBACK.md))
with a real grid: named columns (variables + Output + optional Line),
editable cells, teacher-configurable pre-filled cells (see
2022/02 Q2d(ii)).

**Truth tables use this same widget.** 2023/02 Q4b (complete the
truth table for AND / OR / XOR) and 2022/02 Q2a (complete a
multi-gate truth table with the left-hand input columns given)
are the same grid shape with the same per-cell marker. Input
columns of a truth table are authored as prefilled cells (every
0/1 combination); output columns are left empty for the pupil.
The "partly filled in" case — some output rows given to the
pupil — is the same `prefill` map; the author marks any cell,
input or output, as prefilled.

**Schema.** No enum change — the existing `trace_table` value is
re-implemented. Migration `0019_trace_table_grid.sql`:

- `part_config` JSON upgraded to
  `{ columns: [{name, width?}], rows: number, prefill?:
Record<"r,c", string>, marking: {perCell|perRow|allOrNothing,
caseSensitive, trimWhitespace} }`.
- Live existing `trace_table` `part_config` values are backfilled
  via an idempotent migration script that parses the old
  pipe-separated convention. Backfill is committed as a one-shot
  script in `scripts/migrate/` and is re-runnable.

**App code.**

- `src/templates/_widget_trace_table.eta` rewritten: renders
  `<table class="trace-grid">` with `<thead>` from `columns`, one
  `<tr>` per row, `<input>` per cell; pre-filled cells render as
  read-only text (not disabled inputs — screen readers announce
  them as content).
- Serialisation: JSON array of row objects, one key per column;
  pre-filled cells are absent from the pupil's `raw_answer` (the
  renderer fills them back in on review).
- Marker: per-cell exact match with configurable case /
  whitespace handling; per-cell default; per-row and
  all-or-nothing as configurable flags.
- `src/static/paper.css`: `.trace-grid` with sticky left column
  (row headings or line numbers) that survives horizontal scroll
  on mobile; tabular-numeral font-feature on numeric columns.
- **Truth-table authoring shortcut** in the widget's editor
  partial (`_widget_editor_trace_table.eta`, surfaced by wizard
  step 4): a "Truth table: generate input columns" button that
  asks for the number of input variables (1–4) and their names,
  then writes every 0/1 combination into the grid as prefilled
  cells. The author then names the output column(s) and fills
  (or leaves blank) the expected output values. Purely a
  convenience — the underlying data is still the generic
  trace-table `part_config`; nothing at the schema, renderer, or
  marker layer distinguishes a truth table from any other grid.

**Audit events added.** None.

**Tests.**

| Level       | File                                              | What it proves                                                                                                                                                                        |
| ----------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Integration | `tests/integration/trace-grid-migration.test.ts`  | Existing pipe-separated `part_config` values backfill correctly; backfill is idempotent; a never-authored `trace_table` without legacy `part_config` is left untouched.               |
| Integration | `tests/integration/trace-grid-marker.test.ts`     | Per-cell marker; per-row marker; all-or-nothing; pre-filled cells are not double-scored; missing cells score zero; answer with extra rows ignored.                                    |
| Integration | `tests/integration/truth-table-authoring.test.ts` | "Generate input columns" with 2, 3, and 4 variables produces the correct 2ⁿ-row prefill; author can then mark any output cell empty or prefilled; marker scores as expected.          |
| HTTP        | `tests/http/pupil-widget-trace-grid.test.ts`      | Grid renders; pre-filled cells render as read-only; save round-trips; review page shows pre-filled cells in their original positions.                                                 |
| Browser     | `scripts/phase2_5-browser.ts` trace-grid step     | Arrow keys navigate cells; Tab skips pre-filled cells; mobile viewport scrolls horizontally without losing the sticky left column.                                                    |
| Human       | HUMAN_TEST_GUIDE §2.5.d                           | Pupil completes a trace table (2023/02 Q1d, 2022/02 Q2d(ii)) and a truth table (2022/02 Q2a, 2023/02 Q4b); teacher confirms the pre-fill and truth-table authoring flows are obvious. |

**Exit criteria.** Row 1 of
[PUPIL_FEEDBACK.md](PUPIL_FEEDBACK.md) marked resolved. The
backfill migration is green on a restored copy of production data
(run as part of the chunk's PR check).

### Chunk 2.5e — Matching

**Goal.** Resolve row 2 of [PUPIL_FEEDBACK.md](PUPIL_FEEDBACK.md):
"match term to definition" questions (2022/01 Q5b method/description,
2024/01 Q2a protocol/purpose) render as a proper paired picker, not
a textarea.

**Schema.** Migration `0020_matching.sql`:

- Add `matching` to `expected_response_type`.
- `part_config`:
  `{ left: string[], right: string[], correctPairs:
[leftIdx, rightIdx][], partialCredit: boolean }`. Right may be
  longer than left (distractors).

**App code.**

- `src/templates/_widget_matching.eta`:
  - Desktop (viewport ≥ 720px, pointer coarse/fine): drag-line
    UI. Each left item is a draggable endpoint; each right item
    is a drop target. Lines render via an SVG overlay.
  - Mobile / screen reader: `<select>` next to each left item
    listing all right items plus a "—" default. Equivalent data
    shape.
  - Both modes serialise as `Record<leftIdx, rightIdx>` JSON.
- `src/static/matching.js` (~120 lines, no dependencies): drag
  handlers, SVG line drawing, keyboard fallback (Enter on a left
  item opens a floating list of right items). Emits
  `input`-equivalent events so autosave picks up changes without
  a special-case hook.
- Marker: set-match against `correctPairs`; partial credit
  configurable.

**Audit events added.** None.

**Tests.**

| Level       | File                                        | What it proves                                                                                                                                      |
| ----------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Integration | `tests/integration/matching-marker.test.ts` | All-correct full; one wrong pair partial (if flag); one wrong all-or-nothing zero; distractor never accepted; duplicate right selection OK.         |
| HTTP        | `tests/http/pupil-widget-matching.test.ts`  | Desktop viewport renders drag UI; mobile emulation renders select-based UI; both serialise to the same JSON.                                        |
| Browser     | `scripts/phase2_5-browser.ts` matching step | Drag on desktop; `<select>` on mobile emulator; keyboard-only path (Enter / Arrow / Enter) selects a pair without using a pointer.                  |
| Human       | HUMAN_TEST_GUIDE §2.5.e                     | Pupil on the slowest lab laptop completes a 5-pair matching item in under 90 s; screen-reader user completes the same item via the `<select>` path. |

**Exit criteria.** Row 2 of
[PUPIL_FEEDBACK.md](PUPIL_FEEDBACK.md) marked resolved.
Deterministic marker covered.

### Chunk 2.5f — Logic diagrams

**Goal.** Resolve row 5 of [PUPIL_FEEDBACK.md](PUPIL_FEEDBACK.md):
pupils can draw a logic diagram (2023/02 Q4a floodlight) or drop a
gate into a pre-wired box (2022/02 Q2a(i)). Stored as structured
JSON so a future Phase 3 marker can parse; in 2.5, teacher-marked.

**Schema.** Migration `0021_logic_diagram.sql`:

- Add `logic_diagram` to `expected_response_type`.
- `part_config`:
  `{ variant: 'free' | 'gate_in_box', canvas: {width, height},
inputs: {id, label, x, y}[], outputs: {id, label, x, y}[],
boxes?: {id, x, y, width, height, targetGate?}[],
wires?: {from, to}[] }`. For `gate_in_box`, `boxes` are
  pre-positioned and `wires` are pre-drawn; pupil only drops a
  gate into each box.

**App code.**

- `src/templates/_widget_logic_diagram.eta`: renders a
  `<canvas>` (or SVG — see Decision 4 below) plus a palette of
  AND/OR/NOT/XOR/NAND/NOR gates + a "wire" tool (free variant
  only). Input and output pins are labelled and positioned per
  `part_config`.
- `src/static/logic_canvas.js` (~400 lines, no dependencies):
  canvas rendering, hit-testing for palette drops, wire-drag
  with grid snapping, undo-one-level, JSON serialisation
  compatible with autosave.
- Serialisation: `{ gates: [{id, type, x, y}], wires: [{from,
to}] }`. JSON is the on-wire format; the widget emits an
  `input` event on each change so autosave runs.
- Marker: `null` in the registry — routes to
  `marker='teacher_pending'`. Teacher review page renders the
  pupil's diagram as a static preview next to the model (if one
  has been uploaded).
- Teacher review addition: an "Accept / Reject / Override" UI
  consistent with the Phase 1 teacher marking flow.

**Audit events added.** Reuses `attempt.part.saved`. No new event.

**Tests.**

| Level   | File                                             | What it proves                                                                                                                         |
| ------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Unit    | `tests/unit/logic-diagram-serialisation.test.ts` | A canvas state round-trips through `serialise → JSON → deserialise` losslessly; malformed JSON renders as an empty canvas (no crash).  |
| HTTP    | `tests/http/pupil-widget-logic-diagram.test.ts`  | Both variants render; POST round-trips a JSON `raw_answer`; teacher-marked path is reached; non-owning teacher cannot view the canvas. |
| Browser | `scripts/phase2_5-browser.ts` logic-diagram step | Drop a gate from palette; connect two wires; undo removes last action; submit saves; reopen shows the saved canvas.                    |
| Human   | HUMAN_TEST_GUIDE §2.5.f                          | Pupil draws the floodlight circuit from 2023/02 Q4a; teacher marks it on the review page in under 60 s.                                |

**Exit criteria.** Row 5 of
[PUPIL_FEEDBACK.md](PUPIL_FEEDBACK.md) marked resolved; at least
one question per variant seeded.

### Chunk 2.5g — Diagram labels

**Goal.** Resolve row 6 of [PUPIL_FEEDBACK.md](PUPIL_FEEDBACK.md):
teacher uploads an image; teacher defines click-target hotspots
with expected labels; pupil types a label into each hotspot.

**Schema.** Migration `0022_diagram_labels.sql`:

- Add `diagram_labels` to `expected_response_type`.
- `part_config`:
  `{ imageUrl, imageAlt, width, height, hotspots: [{id, x, y,
width, height, accept: string[], caseSensitive,
trimWhitespace}] }`.
- Image upload: a new route `POST /admin/uploads/diagram-image`
  returns a URL under `/static/uploads/…`. Uploads are hashed
  and deduplicated; MIME and size validation; path traversal
  guarded.

**App code.**

- `src/routes/admin-uploads.ts`: the upload handler, disk-backed
  under `uploads/` (gitignored). `Content-Type`
  allowlist: `image/png`, `image/jpeg`, `image/svg+xml`. Max 2 MB.
- `src/templates/_widget_diagram_labels.eta`: renders the image
  with a positioned absolute overlay per hotspot; each hotspot
  contains an `<input>` sized to the hotspot rectangle.
  `<label>` is the hotspot index; `alt` on the image comes from
  `imageAlt` (required at authoring time).
- Marker: per-hotspot set-match against `accept`. Configurable
  case / whitespace handling.
- Deterministic; registry entry points at the marker.

**Audit events added.** `admin.upload.created` (actor, filename,
bytes, sha256) — new event, because uploaded files are a
state-affecting operation outside the existing question content
flow.

**Tests.**

| Level       | File                                              | What it proves                                                                                                                                   |
| ----------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| HTTP        | `tests/http/admin-upload-diagram-image.test.ts`   | Authorised teacher upload succeeds; non-teacher 403; disallowed MIME 400; oversize 400; dedup on sha256 collision (same URL returned).           |
| Integration | `tests/integration/diagram-labels-marker.test.ts` | Per-hotspot scoring; accept-list equivalence; missing hotspot scores zero; image-less part_config rejected at service layer.                     |
| HTTP        | `tests/http/pupil-widget-diagram-labels.test.ts`  | Renders image + overlay; POST round-trips; review shows correct/incorrect per hotspot; image `alt` is present and non-empty.                     |
| Human       | HUMAN_TEST_GUIDE §2.5.g                           | Teacher uploads the star-topology image and defines four hotspots in the wizard (2.5j); pupil labels all four; review explains which were wrong. |

**Exit criteria.** Row 6 of
[PUPIL_FEEDBACK.md](PUPIL_FEEDBACK.md) marked resolved. Uploads
directory has a clear retention policy documented in
[RUNBOOK.md](RUNBOOK.md).

### Chunk 2.5h — Flowchart drawing / completion

**Goal.** A shape-aware canvas for "draw the flowchart" and
"complete this partially-drawn flowchart" questions (2022/02 Q2b,
2024/02 Q2). Stored as JSON; teacher-marked; same canvas layering
approach as the logic diagram widget.

**Schema.** Migration `0023_flowchart.sql`:

- Add `flowchart` to `expected_response_type`.
- `part_config`:
  `{ canvas, palette: ('terminator'|'process'|'decision'|'io'|
'arrow')[], prefilled?: {shapes: [{id, type, x, y, text}],
arrows: [{id, from, to, label?}]} }`.

**App code.**

- `src/templates/_widget_flowchart.eta` and
  `src/static/flowchart_canvas.js` (~500 lines): similar
  architecture to the logic canvas but with shape-aware drop
  (rectangles for process, diamonds for decision, rounded for
  terminator, parallelograms for I/O, arrows with labels).
- Both canvas widgets share a small common module
  `src/static/canvas_core.js` (~150 lines) for hit-testing,
  undo-one-level, autosave integration. The shared module is
  extracted _after_ 2.5f is proven, not before, to avoid a
  premature abstraction.
- Serialisation JSON with `shapes` and `arrows`.
- Marker: `null` → teacher-marked; review renders the pupil's
  flowchart next to the model.

**Audit events added.** None.

**Tests.**

| Level   | File                                         | What it proves                                                                                                                  |
| ------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Unit    | `tests/unit/flowchart-serialisation.test.ts` | Round-trip; malformed JSON → empty canvas; shape positions respect canvas bounds.                                               |
| HTTP    | `tests/http/pupil-widget-flowchart.test.ts`  | Complete-this variant renders pre-filled shapes as read-only; draw-new variant renders empty canvas; pupil can complete either. |
| Browser | `scripts/phase2_5-browser.ts` flowchart step | Drop process → connect arrow → label arrow → undo removes arrow; save persists; reopen restores.                                |
| Human   | HUMAN_TEST_GUIDE §2.5.h                      | Pupil completes the flowchart from 2024/02 Q2 and draws a new flowchart for a "write an algorithm" variant.                     |

**Exit criteria.** Both variants ship; canvas_core extracted and
covered; teacher-marking flow parity with 2.5f.

### Chunk 2.5i — Pupil answer-entry polish

**Goal.** Cross-widget UX pass: every new widget behaves the same
way for autosave, keyboard navigation, mobile ergonomics, ARIA,
and undo. This chunk is the gate between "widgets exist" and
"pupils can sit a full paper without a mid-lesson UX complaint".

**Schema.** Migration `0024_widget_tips_dismissed.sql`:

- `users.widget_tips_dismissed JSONB NOT NULL DEFAULT '{}'::jsonb`
  — tracks per-user dismissal of the "how to answer this widget"
  microcopy on first encounter.

**App code.**

- `src/static/autosave.js` audit: every new widget advertises
  `data-autosave-part-id`; autosave is exercised by the browser
  walker against one question of every type.
- Keyboard navigation sweep: every widget type has a
  `scripts/phase2_5-browser.ts` keyboard-only subtest.
- Mobile pass: every widget renders correctly at 360 / 768 /
  1024 / 1440; tap targets ≥44×44; grids scroll horizontally
  without losing row headers; cloze gaps carrying code set
  `autocapitalize="off" autocorrect="off" spellcheck="false"`.
- ARIA review per widget, documented in
  `src/templates/_widget_*.eta` top-comment (one line each).
- `src/templates/_widget_help.eta` + `src/static/widget_tips.js`:
  first time a pupil encounters a widget type, a short
  "how to answer this" flash panel appears with a "Got it"
  dismiss. Dismissal persists to `users.widget_tips_dismissed`
  via `POST /me/widget-tips/dismiss`.
- Undo-one-level: canvas widgets (logic, flowchart) already have
  in-memory undo. Trace grid gets Ctrl/Cmd-Z on the last cell
  edit. Matrix tick does not need undo (radios self-reset).
- axe-core target set extended: the seven core pages plus one
  attempt page per new widget type.

**Audit events added.** `user.widget_tip_dismissed` (actor, widget
key) — one per dismissal. Useful in Phase 6 analytics for "which
widgets are confusing enough that most pupils need the tip vs.
skip it straight away".

**Tests.**

| Level   | File                                         | What it proves                                                                                                                                |
| ------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP    | `tests/http/widget-tips.test.ts`             | First GET renders the tip; POST dismiss persists; second GET omits the tip; pupil cannot dismiss another pupil's tips (shared-session guard). |
| Browser | `scripts/phase2_5-browser.ts` keyboard sweep | Keyboard-only walkthrough of one question of every new widget type completes without a pointer; axe-core "serious" count stays at zero.       |
| Browser | `scripts/phase2_5-browser.ts` mobile sweep   | Same question set at 360 px emulation; no horizontal overflow outside `.trace-grid` and `.matching-svg`; all tap targets ≥44 px.              |
| Human   | HUMAN_TEST_GUIDE §2.5.i                      | Real pupil on the slowest lab Chromebook completes a 10-question mixed-widget set with no "how do I…" questions to the teacher.               |

**Exit criteria.** axe-core serious count remains zero on every
`_widget_*.eta` page; every new widget has a dismissible tip; the
mobile sweep passes on a live Chromebook.

#### MVP scope (2026-04-18) vs deferred follow-up

The full chunk-2.5i plan above is the **Option A reference** and
remains the eventual exit bar. To unblock chunk 2.5j without
sitting on a multi-week UX sweep, 2.5i ships in two passes.

**Option B — MVP shipped 2026-04-18.** Just enough polish that a
pupil meeting a new widget for the first time gets oriented and
can recover from a misclick:

- Migration `0024_widget_tips_dismissed.sql` (the JSONB column
  exactly as specified above).
- `src/templates/_widget_help.eta` partial rendered on the
  attempt page above each widget the pupil has not yet
  dismissed.
- `src/static/widget_tips.js` — progressive-enhancement
  "Got it" dismiss button; POSTs to
  `POST /me/widget-tips/dismiss` and hides the panel.
- Audit event `user.widget_tip_dismissed` per dismissal.
- Trace-grid Ctrl/Cmd-Z last-cell undo (small, local change to
  the trace-grid static JS).
- `tests/http/widget-tips.test.ts` covering first-render,
  POST-persists, second-render-omits, audit event written,
  CSRF-required, and shared-session guard.

**Option A remainder — deferred follow-up.** Carried into a
future chunk (target: just before Phase 2+2.5 sign-off, behind a
`PHASE2.5_PLAN.md` revision-history row when picked up). These
items each need a live Chromebook or a non-trivial scripts/
extension and are bigger than the MVP can absorb in one session:

- `scripts/phase2_5-browser.ts` keyboard-only walker covering one
  question of every new widget type (chunks 2.5b–2.5h).
- `scripts/phase2_5-browser.ts` mobile sweep at
  360 / 768 / 1024 / 1440; checks no horizontal overflow outside
  `.trace-grid` / `.matching-svg`, tap targets ≥44 px, code-input
  fields keep `autocapitalize="off" autocorrect="off" spellcheck="false"`.
- Canvas undo for `logic_diagram` and `flowchart` (one-level
  stroke history; today both clear-only). Pencil-and-paper
  parity, not a blocker for MVP.
- ARIA review one-liner in each `src/templates/_widget_*.eta`
  top-comment, recording the chosen role / labelling pattern.
- `src/static/autosave.js` audit documenting which
  `data-autosave-part-id` each widget exposes (today verified
  ad-hoc; the doc closes the loop).
- HUMAN_TEST_GUIDE §2.5.i — slowest-lab-Chromebook 10-question
  mixed-widget pupil sit; can only happen during a real lesson.
- axe-core target set extended to one attempt page per new
  widget type — needs a Playwright fixture per widget type (each
  with valid `part_config` and a started attempt), which is a
  meaningful test-fixture lift. The tip partial itself is
  designed to pass axe by construction (semantic `role="note"`,
  `<h3>` title, button inside form), so the existing seven-page
  axe gate is the MVP floor; per-widget axe coverage is the
  Option-A bar.

The MVP exit bar is: tip panel renders + dismisses + persists for
every new widget; trace-grid undo works; existing axe-core
serious count stays at zero. The full Option A exit bar above
remains the bar for Phase 2+2.5 sign-off.

### Chunk 2.5j — Teacher question-creation wizard

**Goal.** Replace `/admin/questions/new` with a nine-step wizard.
The teacher sees a series of questions about the question they're
creating — never a schema, never JSON. Progress is saved after
every step so a draft can be resumed across sessions or devices.

**Schema.** Migration `0025_question_drafts.sql`:

- New table `question_drafts`:
  - `id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`
  - `author_user_id BIGINT NOT NULL REFERENCES users(id)`
  - `current_step SMALLINT NOT NULL CHECK (current_step BETWEEN
1 AND 9)`
  - `payload JSONB NOT NULL` — accumulated wizard state
  - `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`
  - `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`
  - `published_question_id BIGINT NULL REFERENCES questions(id)`
  - Unique index `(author_user_id, created_at)` for the "my
    drafts" list.

**App code.**

- `src/repos/question_drafts.ts`, `src/services/question_drafts.ts`:
  CRUD + `advance(draftId, stepData)` with audit event per step
  advance, and `publish(draftId)` which writes into the live
  `questions` / `question_parts` / `mark_points` /
  `common_misconceptions` tables via the same service the
  content seeder uses (no duplicate insert path).
- `src/routes/admin-question-wizard.ts`: nine GET routes
  (`/admin/questions/wizard/:draftId/step/:n`) and nine POST
  routes (advance). `GET /admin/questions/wizard/new` creates a
  fresh draft and redirects to step 1.
- Nine templates `_wizard_step_1.eta` … `_wizard_step_9.eta`,
  each with one question and Back/Next controls. Only step 4
  varies per widget — it delegates to per-widget editor
  partials `_widget_editor_<type>.eta`:
  - **Step 1** — Where does this live? Component → topic →
    subtopic pickers. Saved to draft payload.
  - **Step 2** — Command word picker with typical mark tariff
    hints. "Write an algorithm" / "Explain" / "State" / "Complete
    the table" / etc.
  - **Step 3** — Widget picker, filtered by the command word. Each
    widget tile shows a miniature preview and a one-sentence "use
    this when…". Unreasonable combinations (e.g. "write an
    algorithm" → matrix_tick) are hidden, not greyed out.
  - **Step 4** — Widget-specific editor. The only step that
    varies. Inline validation: matrix tick with no correct
    answer marked, cloze with no gaps, trace table with empty
    columns, etc.
  - **Step 5** — Stem and context. Plain-text stem with a live
    preview panel showing the stem + widget exactly as the pupil
    will see it.
  - **Step 6** — Marks and model answer. Mark tariff slider,
    model answer textarea, mark-point bullets (one per line,
    each will become a `mark_points` row), accepted-alternative
    list.
  - **Step 7** — Common misconceptions. Optional. Each
    misconception carries a free-text tag that Phase 6 will
    cluster on.
  - **Step 8** — Difficulty and tags. 1–9 grade band, 1–3
    challenge step, optional paper-section tag (Section A /
    Section B for /02).
  - **Step 9** — Review and try yourself. Full pupil-flow
    preview with a "try answering it yourself" button that
    actually runs the deterministic marker (or surfaces the
    teacher-pending label, for non-deterministic widgets) so
    the author catches rubric errors before pupils do. Publish
    button is the only way to leave this step.
- `src/templates/_admin_drafts_list_body.eta`: a "My drafts" list
  with resume / clone / delete actions.
- Question-bank filters on `/admin/questions`: topic, command
  word, widget type, difficulty, status (draft / pending /
  approved).
- "Clone this question" action on approved questions: seeds a new
  draft at step 4 with the original's widget editor pre-filled.

**Audit events added.**

- `question.draft.created` (actor, draft_id)
- `question.draft.advanced` (actor, draft_id, step, widget_type)
- `question.draft.published` (actor, draft_id, question_id)
- `question.draft.cloned` (actor, source_question_id, new_draft_id)

Audit is per draft **advance**, not per keystroke — step-level
granularity is enough for Phase 6 analytics on wizard drop-off.

**Tests.**

| Level       | File                                             | What it proves                                                                                                                                                                                           |
| ----------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Integration | `tests/integration/question-draft-flow.test.ts`  | Create → advance through 1–9 → publish writes the same rows the seeder would; resume at any step works; another teacher cannot see this author's drafts; published draft is locked from further advance. |
| Integration | `tests/integration/wizard-clone.test.ts`         | Clone of an approved question round-trips into a draft at step 4 with widget editor pre-filled; clone audit event recorded; original left untouched.                                                     |
| HTTP        | `tests/http/wizard-steps.test.ts`                | Each step GET/POST round-trips; POST with missing required fields 400s with a readable flash; CSRF required on every POST; authz (non-owner can't advance).                                              |
| HTTP        | `tests/http/wizard-widget-filter.test.ts`        | Step 3 widget picker for command word "write an algorithm" does not include `matrix_tick_single` or `cloze_with_bank`; for "complete the table", trace_table is highlighted.                             |
| HTTP        | `tests/http/wizard-try-yourself.test.ts`         | Step 9 "try yourself" runs the widget through the deterministic marker for deterministic widgets; surfaces the teacher-pending label for non-deterministic widgets.                                      |
| Browser     | `scripts/phase2_5-browser.ts` wizard walkthrough | Teacher creates one question per widget type through the wizard; time per widget recorded in the walker report (target: ≤5 min simple, ≤10 min complex).                                                 |
| Human       | HUMAN_TEST_GUIDE §2.5.j                          | Real teacher authors 10 questions (one per widget type) in a single sitting using only the wizard; reports no schema terminology exposed at any point.                                                   |

**Exit criteria.** Teacher authors one question per widget type
using only the wizard, meeting the time targets. Drafts can be
resumed across sessions. "Try yourself" catches at least one
planted rubric error in the human test.

#### Implementation sequencing (agreed 2026-04-18)

Chunk 2.5j is the largest single chunk in Phase 2.5 and gates
teacher uptake (and therefore the pupil-feedback signal that
Phase 3 marking quality depends on). Rather than landing it as
one wall-of-diff, it ships in six reviewable steps. Each step
is independently runnable (`npm run check` green) and each step
locks decisions before the next one builds on them.

1. **Schema + repo + service + audit.** Migration
   `0025_question_drafts.sql`, `src/repos/question_drafts.ts`,
   `src/services/question_drafts.ts` with `create`, `advance`,
   and `publish`. The four audit events
   (`question.draft.created`, `.advanced`, `.published`,
   `.cloned`) all wired. `publish` writes through the same
   service path the seeder uses — no second insert path. No
   UI yet. `tests/integration/question-draft-flow.test.ts`
   covers create → advance 1–9 → publish → row equality with a
   seeder-equivalent insert; cross-author isolation; published
   draft locked from further advance.
2. **Wizard scaffolding.** `src/routes/admin-question-wizard.ts`
   with `GET /admin/questions/wizard/new`,
   `GET /admin/questions/wizard/:draftId/step/:n`, the matching
   POST advance routes, and the "My drafts" list at
   `/admin/questions/wizard`. Base `_wizard_chrome.eta` and
   `_admin_drafts_list_body.eta`. Owner-only authz preHandler.
   Back/Next plumbing. Initial `tests/http/wizard-steps.test.ts`
   covering authz, CSRF on every POST, and step routing.
3. **Non-widget steps (1, 2, 3, 5, 6, 7, 8).** Where-it-lives
   pickers, command-word picker with mark-tariff hints, widget
   picker filtered by command word, stem-with-live-preview,
   marks/model-answer/mark-points editor, misconceptions,
   difficulty/tags. Each step is its own `_wizard_step_<n>.eta`
   with one question per screen. Extends `wizard-steps.test.ts`
   with per-step round-trip + missing-field validation.
   `tests/http/wizard-widget-filter.test.ts` lands here.
4. **Step 4 — per-widget editor partials.** One
   `_widget_editor_<type>.eta` per widget (11 partials, grouped
   for review: tick / matrix-tick family →
   cloze family → trace_table → matching → diagram_labels →
   logic_diagram + flowchart). Each editor enforces the widget's
   own validation (matrix tick must mark a correct answer; cloze
   must contain at least one gap; trace table must have at least
   one column; canvas widgets must contain at least one node).
   This is where the teacher-ergonomics work concentrates and
   where most of the human-test risk lives.
5. **Step 9 — review and try-yourself.** Full pupil-flow
   preview using the existing `_paper_part_widget.eta`
   dispatcher. "Try yourself" button starts a throwaway
   self-attempt that runs through the deterministic marker (or
   surfaces the teacher-pending label) so the author catches
   rubric errors before publish. Publish button only available
   from step 9. `tests/http/wizard-try-yourself.test.ts` covers
   the deterministic + teacher-pending branches.
6. **Clone, filters, walker, human guide.** Clone-from-approved
   action (seeds a draft at step 4 with widget editor
   pre-filled), `tests/integration/wizard-clone.test.ts`,
   topic / command-word / widget / difficulty / status filters
   on `/admin/questions`, the wizard walkthrough in
   `scripts/phase2_5-browser.ts`, and `HUMAN_TEST_GUIDE §2.5.j`.

Each step has its own revision-history row in §10 when it lands.
Teacher-ergonomics decisions made during step 4 (and any UX
changes that turn out to be needed in steps 1–3 once a real
editor is in front of them) are captured as inline edits to this
sequencing block, not as a parallel design doc.

## 6. Test strategy across the phase

Same layers as Phase 1 and Phase 2. Additions:

| Layer                   | When run                      | What it catches                                                                                |
| ----------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------- |
| Widget registry unit    | `npm run check`               | Every `expected_response_type` has a registry entry; every entry's partial file exists on disk |
| Canvas serialisation    | `npm run check`               | Logic + flowchart JSON round-trip without drift; malformed input never crashes the renderer    |
| Seeder fixture coverage | `npm run content:seed` in CI  | Every new widget has at least one seeded curated question; seeder remains idempotent           |
| Wizard integration      | `npm run check`               | Draft → advance → publish produces the same rows as the seeder; no second insert path          |
| axe-core extended       | `npm run test:human:phase2_5` | Seven core pages plus one attempt page per new widget type remain at zero "serious" violations |
| Mobile viewport sweep   | `npm run test:human:phase2_5` | Every new widget renders without horizontal overflow at 360 px; tap targets ≥44 px             |

**Coverage target.** Maintain ≥85% line coverage on
`src/services/**` and `src/repos/**`. Every deterministic marker
added in this phase (`matrix_tick_single`, `matrix_tick_multi`,
`cloze_*`, `trace_table` v2, `matching`, `diagram_labels`) ships
at 100% branch coverage. `src/lib/cloze.ts` is a named 100% branch
target because the parser is the riskiest single module in the
phase. Canvas widgets (`logic_diagram`, `flowchart`) are tested
through serialisation unit tests + HTTP round-trip + browser +
human layers; no attempt to unit-test the canvas rendering code.

**No mocks.** Same policy. Integration tests hit the dockerised
Postgres. The upload route (2.5g) writes to a temp dir under
`tests/tmp/` that is wiped per test.

## 7. Ordering and dependencies

```
Chunk 2.5a (matrix tick single + registry)
  ├─► Chunk 2.5b (matrix tick multi + tick_box extended)
  ├─► Chunk 2.5c (cloze)          ◄── parallelisable with 2.5b/2.5d
  ├─► Chunk 2.5d (trace grid)
  ├─► Chunk 2.5e (matching)
  ├─► Chunk 2.5f (logic diagram)
  │     └─► Chunk 2.5h (flowchart, extracts canvas_core)
  ├─► Chunk 2.5g (diagram labels + upload route)
  └─► (all widgets in)
        └─► Chunk 2.5i (pupil entry polish — cross-widget)
              └─► Chunk 2.5j (wizard — needs every widget's editor partial)
                    └─► [sign off → Phase 3]
```

Chunk 2.5a must land first — it establishes the widget registry
pattern that every subsequent widget chunk plugs into. Chunks
2.5b through 2.5g are independent and can ship in any order (or in
parallel on different branches) after 2.5a. Chunk 2.5h depends on
2.5f only because it extracts the shared `canvas_core.js`; order
2.5f → 2.5h, not the reverse.

Chunk 2.5i (polish) is deliberately after every widget because
it sweeps the whole widget set; running it earlier would just
re-fail as new widgets arrive.

Chunk 2.5j (wizard) is last because it needs every widget's
editor partial to exist. A teacher-blocking bug in the wizard
would also block pupils from getting new content; running the
wizard chunk last limits that window.

## 8. Risks specific to Phase 2.5 (and their mitigations)

- **Widget sprawl diluting Phase 3.** The temptation during this
  phase is to add a tenth or eleventh widget "while we're here".
  Mitigation: the widget set is frozen at 2.5j publish; any widget
  not in the §3 list is a Phase 3.x or Phase 7 conversation. The
  multi-subject rollout note (see PLAN.md) accommodates future
  widgets via the registry, not via a mid-phase scope bump.
- **Canvas widgets become a rabbit-hole.** Logic diagrams and
  flowcharts are both "just draw something" with a palette, but
  polish can absorb arbitrary time. Mitigation: both widgets are
  teacher-marked; only the JSON representation needs to be
  correct. Rendering polish can slip to Phase 7 without
  blocking Phase 3.
- **Wizard becomes a wall of forms.** Mitigation: every step with
  no information to ask about is **skipped**, not shown with a
  "nothing to do here" message. Step 4 is the only step that
  varies per widget. Human test measures wall-clock time per
  widget — if a simple widget takes > 5 min, the step flow is
  wrong, not the teacher.
- **Drafts table grows unbounded.** Every wizard step writes a
  draft row update. Mitigation: garbage-collect drafts abandoned
  for > 30 days (a scheduled job added in 2.5j; documented in
  RUNBOOK.md §retention). Published drafts are retained until
  the published question is retired.
- **Image uploads are a new attack surface.** MIME sniffing, path
  traversal, SVG-embedded scripts. Mitigation in 2.5g: strict
  MIME allowlist; SVG sanitisation via `DOMPurify` or equivalent
  on upload; files stored under hashed names; served via
  `Content-Disposition: inline` with `Content-Security-Policy`
  applied by the existing chrome; no `Content-Type: text/html`
  rewrite possible because uploads are served under `/static/`
  with a fixed allowlist.
- **Trace-table backfill migration corrupts live data.**
  Mitigation: backfill runs on a restored copy of production
  before the chunk's PR merges; the migration script is
  committed to `scripts/migrate/` and is re-runnable (idempotent
  on second apply).
- **Keyboard navigation regressions in new widgets.** Matrix
  ticks, cloze gaps, matching, and canvas widgets all have
  non-obvious keyboard behaviours. Mitigation: every widget
  chunk ships a `scripts/phase2_5-browser.ts` keyboard-only
  subtest; 2.5i has a whole-set keyboard sweep before sign-off.
- **Mobile viewports on the school's 360 px-equivalent
  Chromebooks.** Canvas widgets and matching's SVG overlay both
  fight for space. Mitigation: canvas widgets accept a
  `canvas.width` > viewport and become horizontally scrollable
  inside a contained scroll region; matching falls back to the
  `<select>` path at viewport < 720px.
- **Phase 3 blocks on a single late widget.** If 2.5h flowchart
  slips, Phase 3 cannot start. Mitigation: each chunk's exit
  criteria are independently verifiable; if 2.5h is not
  shipping, consider pulling it out of the "frozen set" and
  booking it as Phase 3.1 — do not hold Phase 3 LLM work for it.

See [RISKS.md](RISKS.md) §1, §2.1, and a new §2.5 added in the
first chunk PR.

## 9. Decisions taken before starting

Resolved on 2026-04-18. Binding for Phase 2.5 unless a later
chunk commit explicitly revisits one.

1. **Widget registry lives in `src/lib/widgets.ts`.** Not a new
   top-level module, not a database table. A TypeScript const
   keyed by enum value is the source of truth for which widgets
   exist, which partial renders them, and whether a deterministic
   marker applies. Live values are the union of this registry's
   keys; the DB `expected_response_type` CHECK is regenerated
   from the registry at migration-write time.
2. **Shared `raw_answer` contract unchanged.** Every widget
   serialises to a single `TEXT` JSON string. No per-widget join
   tables in this phase. Analytics may change this in Phase 6.
3. **Canvas widgets use `<canvas>` + programmatic drawing, not
   SVG.** Easier undo implementation, lighter DOM, and the
   serialisation is the real contract anyway. Trade-off: canvas
   is less accessible; mitigation is that these widgets are
   teacher-marked and always have an `extended_response`
   fallback configurable at authoring time for pupils who cannot
   use a canvas.
4. **Cloze gap syntax is `{{gap-id}}` in the authored text.**
   Matches the existing templating convention elsewhere in the
   project; authors never see the double-braces (the wizard's
   click-to-blank UI handles it). Escape sequence is `\{{` for
   literal braces in content.
5. **Matching on mobile uses `<select>` fallback.** Drag UIs on
   a 360px Chromebook with a trackpad are hostile. The select
   fallback serialises to the same JSON.
6. **Wizard "try yourself" runs the real deterministic marker.**
   Not a mock and not a preview — the author's own session runs
   the pupil flow against the marker. The author's own
   `attempt` row is flagged with `is_authoring_preview=true`
   (new column on `attempts`) and excluded from pupil-facing
   stats and Phase 6 analytics.
7. **Drafts are private to the author.** No shared drafts in
   this phase. A teacher cannot hand a draft to another teacher
   mid-authoring. Publishing + cloning covers the shared-work
   case.
8. **Every new widget ships with a seeded fixture.** The CI
   `content:seed` step is a load-bearing test — it proves the
   widget, the seeder, and (where relevant) the deterministic
   marker end-to-end on every PR.

Where these decisions affect the schema, the migration lands in
the chunk that first needs it and is recorded in
[DATA_MODEL.md](DATA_MODEL.md) at merge time. Migrations 0013–0014
are already taken (pupil_feedback, feedback_offline_entry shipped
under chunk 9 of Phase 2). Phase 2.5 migrations in scope, in
expected order:
`0015_question_part_config.sql` (2.5a-i),
`0016_matrix_tick_single.sql` (2.5a-ii — doc-only),
`0017_matrix_tick_multi.sql` (2.5b),
`0018_cloze_response_types.sql` (2.5c),
`0019_trace_table_grid.sql` (2.5d),
`0020_matching.sql` (2.5e),
`0021_logic_diagram.sql` (2.5f),
`0022_diagram_labels.sql` (2.5g),
`0023_flowchart.sql` (2.5h),
`0024_widget_tips_dismissed.sql` (2.5i),
`0025_question_drafts.sql` (2.5j).

## 10. Deliverables checklist (sign off before starting Phase 3)

- [ ] Chunks 2.5a–2.5j merged with tests green.
- [ ] Phase 2.5 human-test walker report attached to
      [RUNBOOK.md](RUNBOOK.md) §10 with PASS.
- [ ] Real lesson test completed with the teacher's class
      containing at least one question of every new widget type.
      **This lesson is the combined Phase 2 + Phase 2.5 sign-off**
      (Phase 2 chunk 9 was deferred into this event); the Phase 2
      success criteria from PHASE2_PLAN.md §Chunk 9 are also
      checked: pupils describe the experience unprompted as
      "looks like the real paper", no accessibility blocker, and
      print-to-PDF accepted by the teacher as "I'd mark that on
      paper".
- [ ] axe-core clean on the seven core pages plus one attempt
      page per new widget type.
- [ ] PUPIL_FEEDBACK.md rows 1–6 marked resolved (trace table,
      matching, cloze_with_bank, cloze_free, logic_diagrams,
      diagram_labels). Row 7 (paper audit) was completed during
      scoping.
- [ ] Teacher-wizard time targets met in the human test
      (≤5 min simple, ≤10 min complex) for every widget type.
- [ ] DATA_MODEL.md reflects every migration listed in §9.
- [ ] Widget registry is the single source of truth — a grep
      for `expected_response_type ===` outside the registry and
      its partials returns zero results.
- [ ] PLAN.md §Phase 2.5 "Success criteria" all ticked, or a
      documented reason for any exception.
- [ ] Forward-compatibility note honoured: no subject-specific
      vocabulary has leaked into widget identifiers, route
      paths, audit event names, or generic UI copy.
- [ ] Go/no-go decision for Phase 3 recorded in
      [RUNBOOK.md](RUNBOOK.md) §10 (one line: date, initials,
      PASS/FAIL, link to lesson report).

## Appendix — Revision history

| Date       | Author | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-04-18 | TD     | First draft at the close of Phase 2 chunk 9b. Phase 2.5 scoped off the live-paper audit (2022–2024 J277/01 + /02) and the first seven rows of PUPIL_FEEDBACK.md. Ten chunks 2.5a–2.5j scheduled: eight widget chunks, one cross-widget polish chunk, one teacher-wizard chunk. Decisions §9 recorded. Forward-compatibility note honoured.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2026-04-18 | TD     | Mini-chunk between 2.5c and 2.5d: extended `WidgetRegistration` with wizard metadata (displayName, description, markPointGuidance, exampleConfig) and a JSON Schema (`configSchema`) per widget. Snapshot committed to `docs/widgets.schema.json` via `npm run gen:widgets-schema`; freshness test enforces it. New `GET /api/widgets` endpoint (teacher/admin only) returns the same payload at runtime. Parity tests assert ajv and the functional validator agree on every schema-checkable fixture; "stricter schema" tests document `additionalProperties: false` as a wizard-facing tightening. Documented in ARCHITECTURE.md. Unblocks 2.5j wizard.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2026-04-18 | TD     | Chunk 2.5d shipped: trace*table re-implemented as a proper grid via the new `src/lib/trace-grid.ts` (config types, validator, parser, marker, `generateTruthTablePrefill` for truth-table authoring). Promoted from `teacher_pending` to `deterministic` in the marker; per-cell, per-row, and all-or-nothing modes. Template renders `<table class="trace-grid">` with sticky left column and pre-filled cells as read-only `<span>`s (screen-reader friendly). Form fields posted as `part*<id>\_\_r,c`and aggregated via the existing`routes/attempts.ts`suffix path. Migration`0019_trace_table_grid.sql`(documentation-only) plus idempotent`scripts/migrate/0019-trace-table-backfill.ts`. Curated `2.1_trace-table.json`updated with new`part_config`. Resolves PUPIL_FEEDBACK row 1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2026-04-18 | TD     | Chunk 2.5e shipped: new `matching` widget via `src/lib/matching.ts` (config types, validator, parser, marker). Added to `EXPECTED_RESPONSE_TYPES`; registered in the widget registry with `marker='deterministic'` and a JSON Schema. Template renders a native `<select>` per left row as the baseline (keyboard- and screen-reader-friendly); `src/static/matching.js` progressively enhances on fine-pointer ≥720px viewports into a click-line drag UI over an SVG overlay. Marker supports `partialCredit` (default true) and shared right targets. Form field shape `part_<id>__<leftIdx>=<rightIdx>` reuses the existing `routes/attempts.ts` suffix aggregator. Migration `0020_matching.sql` (documentation-only, no backfill — new type). Curated `1.3_protocols-matching.json` fixture added. Resolves PUPIL_FEEDBACK row 2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2026-04-18 | TD     | Chunk 2.5f shipped (MVP scope, scoped down from the original chunk plan). New `logic_diagram` widget via `src/lib/logic-diagram.ts`: config validator (`variant: 'image'` only, canvas dimensions clamped 100–2000), raw-answer parser/serialiser for the `image=<dataURL>` line. Added to `EXPECTED_RESPONSE_TYPES`; registered in the widget registry with `marker='teacher_pending'` and a JSON Schema; deterministic marker treats it as an open response. Template renders a `<canvas>` plus pen/eraser/clear toolbar and a hidden `part_<id>__image` input that the route aggregator stores as `image=…`. `src/static/logic_diagram.js` wires mouse + touch drawing and exports a PNG dataURL on every stroke. Restricted to `data:image/png;base64,…` payloads (≤600 KB) so the teacher review page can render `<img>` without sanitising. Migration `0021_logic_diagram.sql` (documentation-only). Curated `2.4_logic-diagram-and-or.json` fixture added. Resolves PUPIL_FEEDBACK row 5 as `triaged` — the structured `gate_in_box`/`structured_free` variants from the original chunk plan are deferred to Phase 3 and will live alongside the MVP under the same `expected_response_type`, dispatched by the `variant` field, with no further migration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2026-04-18 | TD     | Chunk 2.5g shipped (MVP scope). New `diagram_labels` widget via `src/lib/diagram-labels.ts`: config validator (image URL restricted to `/static/...` or `https://`, hotspots overlaid as rectangular text inputs with per-hotspot `caseSensitive`/`trimWhitespace` flags), raw-answer parser/serialiser for `<hotspotId>=<value>` lines, deterministic per-hotspot set-match marker. Added to `EXPECTED_RESPONSE_TYPES`; registered in the widget registry with `marker='deterministic'` and a JSON Schema. Template renders `<img>` plus one absolutely-positioned `<input>` per hotspot named `part_<id>__<hotspotId>`; the existing `routes/attempts.ts` suffix aggregator collapses them into the line-encoded `raw_answer`. Mark points are matched to hotspots by index, mirroring `matching`. Migration `0022_diagram_labels.sql` (documentation-only). Curated `1.4_topology-star-labels.json` fixture + `src/static/curated/network-topology-star.svg` added. Resolves PUPIL_FEEDBACK row 6 as `triaged` — the teacher upload route (`POST /admin/uploads/diagram-image`) and `admin.upload.created` audit event are deferred to chunk 2.5j (wizard) where the only caller exists, with no further migration since `imageUrl` is the contract.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2026-04-18 | TD     | Chunk 2.5h shipped (MVP scope, scoped down from the original chunk plan). New `flowchart` widget via `src/lib/flowchart.ts`: config validator (`variant: 'image'` only, canvas dimensions clamped 100–2000), raw-answer parser/serialiser for the `image=<dataURL>` line — the same contract as `logic_diagram`. Added to `EXPECTED_RESPONSE_TYPES`; registered in the widget registry with `marker='teacher_pending'` and a JSON Schema; deterministic marker treats it as an open response. Template renders a `<canvas>` plus pen/eraser/clear toolbar and a hidden `part_<id>__image` input that the route aggregator stores as `image=…`. `src/static/flowchart.js` mirrors `logic_diagram.js` (mouse + touch drawing, PNG dataURL export on every stroke, ≤600 KB data URLs). Migration `0023_flowchart.sql` (documentation-only). Curated `2.1_flowchart-larger-of-two.json` fixture added. Structured shape palette (terminator/process/decision/io/arrow) + prefilled-shape "complete this flowchart" variant from the original chunk plan are deferred to Phase 3 and will live alongside the MVP under the same `expected_response_type` via a `variant: 'shapes'` tag, with no further migration. `canvas_core.js` extraction shared with `logic_diagram` is deferred with the shape palette — extracting now would be a premature abstraction over two ~15-line event loops.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2026-04-18 | TD     | Chunk 2.5i shipped (Option B MVP). Per-pupil widget-tip first-encounter panel via new `src/lib/widget-tips.ts` (tip catalogue keyed by widget type, dismissal validator) + `src/templates/_widget_help.eta` partial + `src/static/widget_tips.js` (progressive enhancement: noscript posts to `/me/widget-tips/dismiss` and reloads, JS hides in place). Migration `0024_widget_tips_dismissed.sql` adds `users.widget_tips_dismissed JSONB NOT NULL DEFAULT '{}'::jsonb`; `UserRepo.dismissWidgetTip` writes via `jsonb_build_object` so concurrent dismissals are safe. New `POST /me/widget-tips/dismiss` route on the existing attempts router (CSRF-required, key validated against `WIDGET_TIPS`). New audit event `user.widget_tip.dismissed`. Tips render at most once per widget type per page in `_attempt_edit_body.eta` (server filters by the dismissed JSONB; template tracks first-seen-this-render). Trace-grid Ctrl/Cmd-Z last-cell undo via new `src/static/trace_grid.js` (single-slot baseline captured on focus, restored on Ctrl/Cmd-Z). New `tests/http/widget-tips.test.ts` covers first-render, persistence in JSONB, second-render-omits, audit event written, CSRF-required, and shared-session guard. Final: 81 files / 658 tests passing. Option-A remainder (keyboard/mobile browser walker sweeps, canvas undo for logic_diagram + flowchart, ARIA review one-liners, autosave audit doc, per-widget axe coverage) deferred per the new "MVP scope vs deferred follow-up" subsection in §Chunk 2.5i — those each need a Playwright fixture or a live-Chromebook session and remain the Phase 2+2.5 sign-off bar.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2026-04-18 | TD     | Chunk 2.5j step 1 shipped: schema + repo + service + audit foundations for the teacher question-creation wizard. Migration `0025_question_drafts.sql` adds `question_drafts (id, author_user_id, current_step 1–9, payload JSONB, published_question_id, created_at, updated_at)` with `(author_user_id, created_at DESC)` index. New `src/repos/question_drafts.ts` (`create`, `findById`, `listByAuthor`, `update`, `markPublished`) treats payload as a partial `QuestionDraft` so there is no second canonical schema. New `src/services/question_drafts.ts` exposes `create` / `advance(step, patch)` / `publish` with monotonic `current_step`, owner-only authz (admins read all), and the four audit events `question.draft.created`, `.advanced`, `.published`, `.cloned` (cloned wired in step 6). `publish` hands the hardened payload to the existing `QuestionService.createDraft` so the wizard shares the seeder/admin-form insert path — no duplicate writes. Wired into `src/app.ts` decorators (`services.questionDrafts`, `repos.questionDrafts`). New `tests/integration/question-draft-flow.test.ts` covers happy-path 1→9 publish-equivalent rows, lock-after-publish, incomplete-publish guard, cross-author isolation, admin-read-all, step-range validation, and most-recently-updated ordering. No UI yet — that lands in step 2. Final: 82 files / 667 tests passing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2026-04-18 | TD     | Chunk 2.5j step 2 shipped: wizard scaffolding. New `src/routes/admin-question-wizard.ts` with `GET /admin/questions/wizard` ("My drafts" + recently published list), `POST /admin/questions/wizard/new` (creates a draft and redirects to step 1), `GET/POST /admin/questions/wizard/:draftId/step/:n` for steps 1–9, and `POST /admin/questions/wizard/:draftId/publish`. All routes guarded by `requireTeacherOrAdmin` (pupils → 403, anon → /login); all POSTs CSRF-required; cross-author access returns 403; unknown draft id returns 404; already-published or incomplete-publish errors round-trip through a flash message on step 9. New templates `admin_drafts_list.eta` + `_admin_drafts_list_body.eta` (in-progress and recently-published tables with payload summary line) and `admin_wizard_step.eta` + `_admin_wizard_step_body.eta` (per-step title + hint, 1-of-9 progress nav linking only to already-touched steps, Save/Continue placeholder form, separate Publish form on step 9). The step body renders only a placeholder editor — per-step editors land in step 3 of the sequencing plan. `/admin/questions` list now offers "New question (wizard)" alongside the existing single-page form. New `tests/http/wizard-steps.test.ts` covers anon→/login, pupil→403, empty drafts list, draft-create + step-1 redirect, CSRF on new + step POST, full 1→9 advance via repeated POST, cross-author 403 on GET and POST, 404 on unknown id, and the resume row appearing in the list. Final: 83 files / 677 tests passing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2026-04-19 | TD     | Chunk 2.5j step 4 shipped: per-widget editors for the 11 widgets that take a `part_config` payload. New `src/lib/wizard-widget-editors.ts` dispatches by `expected_response_type` to a parser per widget; flat form-field conventions (`options` newline-list for tick*box, `correct*<rowIdx>`per matrix row,`id\|alt1, alt2`per cloze gap,`row,col=value`per trace_table cell,`right*for*<i>`integer for matching,`id\|x\|y\|w\|h\|alt1, alt2`per diagram-labels hotspot,`canvas*width`/`canvas_height`for logic_diagram + flowchart) so teachers never see JSONB. Each parser hands its output back through the registry's`validatePartConfig`as a belt-and-braces check so cross-field invariants (correctByRow length ≠ rows length, gap id not referenced in`{{id}}`, hotspot id collisions, cells out of range) surface as field-level issues rather than 500s on publish. Six no-op widgets (multiple_choice, short_text, medium_text, extended_response, code, algorithm) get a no-op parser + a noop partial so the nine-step shape stays consistent. New per-widget templates `\_wizard_step_4*<type>.eta`(one per widget plus`\_wizard_step_4_noop.eta`); `\_wizard_step_4.eta`is now a thin dispatcher that includes the right partial.`parseStep4`in`src/lib/wizard-steps.ts`rewritten to call`parseWidgetConfig`, merge the result into `parts[0].part_config`, and surface field-level errors via the existing 400-with-issues flow. New `tests/http/wizard-widget-editors.test.ts`(12 cases) covers noop happy-path, tick_box round-trip + empty-options rejection, matrix_tick_single round-trip + bad-column rejection, cloze_free round-trip + unreferenced-gap rejection, cloze_with_bank empty-bank rejection, matching round-trip, trace_table round-trip + out-of-range-cell rejection, logic_diagram/flowchart canvas dimensions, and diagram_labels round-trip + bad-image-URL rejection. Eta gotcha: top-level`const options`collides with the compiled template's`options`parameter; renamed to`tickOpts` in the tick_box partial. Final: 85 files / 701 tests passing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2026-04-19 | TD     | Chunk 2.5j step 3 shipped: non-widget steps (1, 2, 3, 5, 6, 7, 8) plus review-and-publish (9). New `src/lib/wizard-steps.ts` hosts per-step parsers (`parseStep1`–`parseStep9`) returning `Partial<QuestionDraft>` patches, plus the `COMMAND_WORD_WIDGETS` compatibility map over all 29 OCR command words: "write*rewrite" recommends code / algorithm / medium_text / extended_response and hides matrix_tick_single and cloze_with_bank behind "Other widgets"; "complete" leads with trace_table; "tick" leads with tick_box + matrix_tick_single/multi. Parsers validate component→topic→subtopic chain, command_word and archetype against curriculum refs, widget against the registry, stem 4000-char ceiling, marks 1–60, model_answer 4000-char ceiling, mark_points one-per-line (each worth 1 mark, not-required), misconceptions one-per-line `label : description`, difficulty_band 1–9, difficulty_step 1–3, source_type clamped to a known value. Step 3 seeds `parts[0]` with the widget's `exampleConfig` and resets it on widget swap; step 5 mirrors `stem` into `parts[0].prompt` for the single-part wizard case. Per-step templates `_wizard_step_1.eta`–`_wizard_step_9.eta` replace the placeholder body; `_admin_wizard_step_body.eta` now renders per-field issues above the form and dispatches to the per-step partial via `include('\_wizard_step*' + stepN, …)`. Step 9 lists `missingFields`and surfaces a "Not ready to publish" alert when the payload is incomplete; the publish button still renders (the service enforces the real gate). Step 4 remains a placeholder — per-widget editors land in step 4 of the sequencing plan. New`tests/http/wizard-widget-filter.test.ts` proves the three widget-filter assertions against rendered HTML markers (`data-section="recommended"`/`admin-wizard\_\_more-widgets`). `tests/http/wizard-steps.test.ts` extended with per-step round-trip + missing-field validation (19 cases). Final: 84 files / 689 tests passing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2026-04-19 | TD     | Chunk 2.5j answer-recording UX pass: four fixes addressing how teachers record correct answers and how the curriculum chain narrows on step 1. (B1) `multiple_choice` editor on step 4 now collects the option list **and** a checkbox per option for "this option is correct"; new `parseMultipleChoice` writes `part_config.options` and emits `derivedMarkPoints` (1 mark per ticked option). (A) Step 1 component → topic → subtopic now narrows client-side: new `src/static/wizard_curriculum_chain.js` (loaded only when `wizardScriptsEnabled`) hides options whose `data-component`/`data-topic` no longer matches the parent select; server validation in `parseStep1` remains the safety net. Hint copy on `_wizard_step_1.eta` updated. (B2) `tick_box` parses the same `correct_<i>=on` checkbox convention, validates ≥1 ticked and matches `tickExactly` when set, and emits `derivedMarkPoints` per ticked option; `_wizard_step_4_tick_box.eta` mirrors the multiple*choice editor (textarea + checkbox column once options exist). (B3) Step 6 `mark_points` textarea now parses pipe-syntax (e.g. `primary \| alt1 \| alt2`) into `text` + `accepted_alternatives`; round-trips on revisit; rejects duplicate alternatives (case-insensitive) and over-length segments. New `derivedMarkPoints` plumbing on `WidgetConfigParseResult` lets `parseStep4` write directly to `parts[0].mark_points`; `parseStep6` reads `widgetAutoDerivesMarkPoints(widget)` (set: `multiple_choice`, `tick_box`) to skip its own textarea validation and preserve what step 4 wrote. Step 6 template renders an `mc-derived-mark-points` `<ul>` for these widgets with a "edit on step 4" hint instead of the textarea. Pupil-facing `_paper_part_widget.eta` for multiple_choice prefers `part_config.options` (wizard-authored) and falls back to mark_point texts (pre-2.5j questions). Widgets registry: new `MULTIPLE_CHOICE_SCHEMA` + `validateMultipleChoiceConfig` (≥2 unique non-empty options, no unknown keys); regenerated `docs/widgets.schema.json`; widgets unit tests removed `multiple_choice` from the no-config set. New tests: 2 in `wizard-widget-editors.test.ts` for multiple_choice (round-trip + step 6 derived list; rejects no-correct-ticked) plus 2 for tick_box (rejects no ticks; rejects ticked-count ≠ tickExactly); 2 in `wizard-steps.test.ts` for the pipe-syntax round-trip and duplicate-alternatives rejection; existing tick_box round-trip extended to post `correct*<i>`and assert the step-6 derived list.`wizard-steps.test.ts`step-1 test asserts the chain script +`data-component`/`data-topic` attributes load on step 1 only. Final: 85 files / 710 tests passing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2026-04-19 | TD     | Chunk 2.5j wizard UX pass: (A) live-update correct-answer pickers on every widget editor. New `src/static/wizard_answer_picker.js` binds per-widget-editor roots (marked with `data-widget-editor="<type>"`) and rebuilds the correct-answer UI on every `input` event in the source textareas — checkbox lists for `multiple_choice`/`tick_box`, radio columns for `matrix_tick_single`, checkbox grids for `matrix_tick_multi`, prompt-by-prompt selects for `matching`, and the per-cell grid for `trace_table`. State preservation is keyed by **value** (option text, row text, `row\|col` cell key, `left\|right` match key) not index, so reordering options in the source textarea keeps ticks attached to the right text. Empty-state hint (`[data-picker-empty]`) shows when the sources are blank and hides once there's content. Script only loads on the widget-editor step (via new `wizardAnswerPickerEnabled` chrome flag). All six affected templates gained `data-widget-editor` + `data-picker` + key-bearing `data-*` attributes on each input; all six now render their picker fieldset unconditionally, with the hint swapped in instead of hiding the whole block. (B) Step 4 ↔ step 5 swapped so the stem is entered **before** the widget editor: new `parseStep4` is the stem parser (mirrors into `parts[0].prompt`), new `parseStep5` is the widget-config dispatcher; thirteen `_wizard_step_4_<type>.eta` partials renamed to `_wizard_step_5_<type>.eta` (CSS-only class update `wizard-step--4` → `wizard-step--5`); step-body dispatcher include prefix updated; missing-fields message on step 9 updated to "Step 4: stem". New `_wizard_stem_banner.eta` renders a sticky `<aside>` with the stem text + an "Edit the stem" link above the form body on steps 5–9 once the stem is set; `.admin-wizard__stem-banner` styles (sticky positioning, brand-accent border-left, pre-wrapped text) live next to the existing progress styles in `site.css`. Copy updates: step-3 hint mentions "the next two steps will set up the question and its answer"; step-6 auto-derived-mark-points block now refers to step 5. Tests: `STEP_FIELDS[4]`/`STEP_FIELDS[5]` swapped in `wizard-steps.test.ts`; `wizard-widget-editors.test.ts` flipped `/step/4` → `/step/5` and the post-step redirect target to `/step/6`. Final: 85 files / 710 tests passing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2026-04-19 | TD     | Chunk 2.5j teacher walk-through polish (F1–F4 from the "first-time teacher" audit). **F1**: stale step-5 noop copy ("move on to writing the stem" — a regression from the step-4↔5 swap) corrected to "marks and the model answer". **F4**: each of the three cloze editor partials (`_wizard_step_5_cloze_free`, `_cloze_code`, `_cloze_with_bank`) gained a collapsed `<details class="form-hint admin-wizard__worked-example">` block with a fully worked passage + gaps + bank example, so a first-time teacher has something concrete to edit from instead of a blank textarea. **F3**: `diagram_labels` editor now mounts a click-and-drag hotspot picker. New `src/static/wizard_hotspot_picker.js` binds to `[data-widget-editor="diagram_labels"]`, renders the image with one absolutely-positioned rectangle per hotspot line, lets the teacher drag on the image to draw a new hotspot (auto-id `h1`, `h2`, …; minimum 80×30 if drag distance < 10 px) and Delete/Backspace to remove a selected one — the textarea remains the source of truth (picker re-renders on textarea `input`, picker writes back via `dispatchEvent('input')`). Picker loads alongside `wizard_answer_picker.js` under the existing `wizardAnswerPickerEnabled` chrome flag. New CSS for `.diagram-hotspot-editor` + `__stage`/`__overlay`/`__hotspot`/`__ghost` (translucent blue rectangles, orange when selected, label chip floating above each box). The diagram_labels partial also gained a worked example in the same `<details>` style, walking through CPU diagram coordinates. **F2**: step-9 review-and-publish now renders a live pupil preview pane via the existing `_paper_part_widget.eta` dispatcher. New `_wizard_preview.eta` constructs a stub `part` (`id: 'preview'`, `expected_response_type` + `part_config` from the draft) and includes the pupil widget below the stem inside an `<aside class="admin-wizard__preview">`, rendered **outside** both the review form and the publish form so there is no nested-form HTML. New `wizardPreviewEnabled` chrome flag (only `n === 9`) loads the runtime scripts the pupil widgets actually use — `widget_counters.js`, `cloze_bank.js`, `matching.js`, `logic_diagram.js`, `flowchart.js`, `trace_grid.js` — but **not** `autosave.js` or `widget_tips.js`, since the preview is throwaway and shouldn't POST. Preview pane has its own brand-bordered styling block in `site.css`. New tests: `wizard-steps.test.ts` step-9 happy-path now asserts "What the pupil will see" + `admin-wizard__preview-stage`; `wizard-widget-editors.test.ts` adds a diagram_labels case asserting `data-widget-editor="diagram_labels"` + `data-picker="hotspot-stage"` + `wizard_hotspot_picker.js` script tag. Final: 85 files / 711 tests passing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2026-04-19 | TD     | Chunk 2.5j wizard polish pass shipped between sequencing steps 4 and 5: large CSS pass on `src/static/site.css` (~400 lines) introducing the missing `.visually-hidden` utility, `.admin-card`, `.stacked-form` (styled inputs/textareas/selects/fieldsets, generous `--space-*` gap layout), `.form-hint` / `.form-error` / `.form-checkbox`, `.alert` family, `.admin-wizard__breadcrumbs`/`__header`/`__step-counter`/`__hint`/`__lede`/`__progress`/`__progress-item` (`.is-current` / `.is-done`)/`__form`/`__actions`/`__placeholder`/`__definitions`/`__more-widgets`/`__publish`, `.widget-tile-grid` + `.widget-tile` (selected and `--alt` recommended-vs-other styling), `.wizard-step` grid, `.matrix-correct`/`.matching-pairs`, `.trace-grid-editor` table + colour-coded swatches, `.matrix-multi-editor__table`, `.admin-drafts-list`, plus a 720px responsive breakpoint that drops the per-cell editors to single-column. Two answer-selection editors upgraded to match the rest of the wizard: `matrix_tick_multi` swapped from a `correct_<i>` newline-of-column-names textarea to a real HTML `<table>` checkbox grid (one `cell_<r>_<c>=on` checkbox per intersection, visually-hidden per-cell labels for screen readers, `partialCredit` toggle preserved); `trace_table` swapped from `prefill` / `expected` `r,c=value` textareas to a per-cell editable grid where each cell carries a `mode_<r>_<c>` select (decorative / pre-filled / expected) plus a `value_<r>_<c>` text input and the parser walks the rectangle defined by columns × rows. Parser updates in `src/lib/wizard-widget-editors.ts` (`parseMatrixMulti` rewritten around the checkbox convention; `parseTraceTable` rewritten around the per-cell mode/value rectangle, dropping the old `parseCellMap` helper; new validation surfaces "Mark at least one cell as Expected" instead of the now-impossible out-of-range error). Templates `_wizard_step_4_matrix_tick_multi.eta` and `_wizard_step_4_trace_table.eta` rewritten to render the new editable grids, including a colour-swatch legend on trace*table. Tests in `tests/http/wizard-widget-editors.test.ts` updated for the new field shapes (trace_table happy-path posts `mode*<r>_<c>`+`value_<r>\_<c>`and re-renders to populated text inputs and a`selected` `prefill` option; trace_table failure case asserts the new "no expected cells" guard); added a new matrix_tick_multi case asserting the checkbox grid round-trips (`cell_0_0`/`cell_0_2`/`cell_1_1` `checked` on re-render). Final: 85 files / 702 tests passing. The polish lands before sequencing step 5 (review + try-yourself) so the rest of the wizard work picks up on the upgraded foundation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2026-04-19 | TD     | Chunk 2.5k shipped: `flowchart` shapes variant (structured pre-drawn shapes + pupil-fill blanks). `src/lib/flowchart.ts` extended with `FlowchartShapesConfig` (terminator/process/decision/io shape types, arrows with optional labels), validator enforcing ID regex, canvas-fit, shape-size floors (40×30), and the `text` vs `accept` XOR per shape; new `parseFlowchartShapesRawAnswer` / `serialiseFlowchartShapesAnswer` + `markFlowchartShapes` (per-blank set-match, `caseSensitive`/`trimWhitespace` flags mirror diagram*labels). Registry `FLOWCHART_SCHEMA` rewritten as `oneOf: [imageSchema, shapesSchema]`; `docs/widgets.schema.json` regenerated. Deterministic marker dispatches on `part.part_config.variant` via a new `markFlowchartPart` — image / missing / malformed configs remain `teacher_pending/open_response`; valid shapes configs award one mark per hit blank. `_paper_part_widget.eta` renders the shapes variant as a responsive SVG (viewBox + max-width:100%) with decorative arrows and a percentage-positioned input overlay so `<input name="part*<id>\_\_<shapeId>">`boxes scale with the SVG; the route aggregator's existing suffix-field collapse produces the`id=value`line-encoded raw_answer. No dedicated pupil JS — autosave binds to`[data-autosave-part-id]` as for diagram_labels. Wizard step 5 gains a variant radio (image / shapes) + conditional shapes/arrows textareas (`id\|type\|x\|y\|w\|h\|TEXT\|content`or`id\|type\|x\|y\|w\|h\|EXPECTED\|a, b`for shapes;`from\|to[\|label]`for arrows) and a worked-example`<details>`block ("print the larger of A and B");`parseFlowchart`dispatches on`variant`, emits `derivedMarkPoints`per expected shape. Curated`content/curated/2.1_flowchart-shapes-larger-of-two.json`fixture demonstrates the variant end-to-end. New unit tests: validator happy-path + XOR + canvas-fit + duplicate-id + unknown-arrow-ref + shapes-round-trip + case-sensitive marking (9 cases); integration tests: wizard shapes round-trip + no-EXPECTED rejection (2 cases).`logic_diagram`+`flowchart`both remain in`OPEN_RESPONSE_TYPES`(the early flowchart return in`markAttemptPart`preempts the generic path);`VARIANT_DISPATCHED_TYPES`helper removed as redundant. Final: 86 files / 726 tests passing. Unblocks chunk 2.5l (logic_diagram`gate_in_box` variant) which will reuse the same variant-dispatched marker pattern.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2026-04-19 | TD     | Chunk 2.5l shipped: `logic_diagram` `gate_in_box` variant (structured pre-drawn gates + pupil-fill blank boxes). `src/lib/logic-diagram.ts` extended with `LogicDiagramGateInBoxConfig` (AND/OR/NOT gate types, labelled input/output terminals, decorative wires between ids), validator enforcing ID regex, canvas-fit, gate-size floors (40×30), `type` XOR `accept` per gate, unique ids across gates+terminals, wire refs existing id, and ≥1 blank gate; new `parseLogicDiagramGatesRawAnswer` / `serialiseLogicDiagramGatesAnswer` + `markLogicDiagramGates` (per-blank set-match, `caseSensitive`/`trimWhitespace` flags mirror flowchart shapes). Registry `LOGIC_DIAGRAM_SCHEMA` rewritten as `oneOf: [imageSchema, gateInBoxSchema]`; `docs/widgets.schema.json` regenerated. Deterministic marker dispatches on `part.part_config.variant` via a new `markLogicDiagramPart` — image / missing / malformed configs remain `teacher_pending/open_response`; valid gate*in_box configs award one mark per hit blank. `_paper_part_widget.eta` renders the gate_in_box variant as a responsive SVG (viewBox + max-width:100%) with SVG-path gate glyphs (AND D-shape, OR curved-back, NOT triangle + bubble), labelled terminal dots, decorative wires between centres, and a percentage-positioned input overlay so `<input name="part*<id>**<gateId>">` boxes scale with the SVG. Wizard step 5 gains a variant radio (image / gate_in_box) + conditional gates/terminals/wires textareas (`id\|x\|y\|w\|h\|GATE\|AND`or`id\|x\|y\|w\|h\|BLANK\|a, b`for gates;`id\|INPUT\|A\|x\|y`for terminals;`from\|to`for wires) and a worked-example`<details>`block ("P = (A AND B) OR NOT C");`parseLogicDiagram`dispatches on`variant`, emits `derivedMarkPoints`per blank. New`.logic-gates**\*`styles in`paper.css`mirror the flowchart-shapes pattern. Curated`content/curated/2.4_logic-diagram-gate-in-box.json`fixture demonstrates the variant end-to-end. New unit tests: validator happy-path + XOR + canvas-fit + duplicate-id + unknown-wire-ref + terminal kind/label + gates-round-trip + case-sensitive marking (11 cases); integration tests: wizard gate_in_box round-trip + no-BLANK rejection (2 cases). Dead`buildCanvasParser`helper removed from`wizard-widget-editors.ts`(unused after flowchart + logic_diagram both got their own variant-aware parsers). Final: 87 files / 742 tests passing. Unblocks chunk 2.5m (logic_diagram`structured_free`variant +`canvas_core.js` extraction once a second pupil-JS consumer exists).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2026-04-19 | TD     | Chunk 2.5n shipped (first of seven wizard-redesign chunks, documented in [WIZARD_REDESIGN_PLAN.md](WIZARD_REDESIGN_PLAN.md)): design-system foundation for the wizard redesign. `src/static/design-tokens.css` extended with a warm-amber secondary ramp (`--color-accent-warm-50/-100/-500/-600/-700/-ink`), a wider type scale (`--type-display: 2rem`, `--type-h1: 1.75rem`, `--type-h2: 1.25rem`, `--type-lede: 1.05rem`), line-height tokens (`--leading-tight/-body/-prose`), a system-serif `--font-display` stack (ui-serif → Source Serif 4 → Cambria → New York → Georgia, zero webfont bytes shipped), motion tokens (`--duration-fast/mid/slow`, `--ease-standard/entrance/exit`), elevation aliases (`--shadow-resting/-raised/-floating`), `--radius-xl`, and a full `[data-theme='dark']` override block (surfaces 14141c/1b1b24/242430/2e2e3c, inks f2f2f6/cacad6/9a9aac, shadow alpha bumped, brand 50/100 moved into the dark band). Auto mode (`[data-theme='auto']`) re-applies the same dark overrides inside `@media (prefers-color-scheme: dark)`; global `@media (prefers-reduced-motion: reduce)` resets animation/transition durations to 0.001ms. Dark mode is **token-only** — no component CSS changes, so every existing page dark-ifies by inheritance. New migration `0026_theme_preference.sql` adds `users.theme_preference TEXT NOT NULL DEFAULT 'auto' CHECK (theme_preference IN ('light','dark','auto'))`; `src/repos/users.ts` gained `ThemePreference` type, `THEME_PREFERENCES` const, `theme_preference` column across all three SELECT queries, and `setThemePreference()`; `src/services/attempts.ts` gained `setThemePreferenceForUser()` emitting a `user.theme_preference.set` audit event. New `POST /me/preferences/theme` route on the attempts router (CSRF-required, zod-validated, redirects to `/me/preferences?flash=…`); `_chrome.eta` reads the user's pref and renders `<html data-theme="auto                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | light | dark">`; `\_me_preferences_body.eta`grew an Appearance fieldset with auto/light/dark radios.`src/static/site.css`gained new shared primitives —`.chip`(+`.chip--success`/`--warn`/`--danger`/`--info`/`--accent`variants),`.kbd`, `.status-dot`(+ 4 variants),`.progress-ring` with CSS-mask ring fill (`-webkit-mask`before`mask`for stylelint),`.icon`(+`--sm`/`--lg`), and display-face heading rules scoped to `.admin-card\_\_header h1/h2`+`.admin-wizard h1/h2/h3`(so existing pupil pages keep their sans-serif headings until later chunks migrate them). New`tests/http/me-theme.test.ts`(7 cases): unauthenticated→/login, default`data-theme="auto"`on a fresh user, toggle-to-dark persists and re-renders, teacher can also toggle, invalid`theme`rejected with 400, design-tokens.css serves the`[data-theme='dark']`block + warm-amber +`--font-display`+`--duration-fast`+ both`@media`queries, and a`user.theme_preference.set`audit row is written on change.`tests/http/me-font.test.ts`assertions loosened from`<html lang="en" data-font="...">`to just`data-font="..."`since the new`data-theme`attribute breaks the exact string match. Chrome flag`WIZARD_V2_ENABLED` not wired yet (first v2 route branch lands in chunk 2.5o). Final: 86 files / 789 tests passing. Unblocks chunks 2.5o–2.5t (drafts list v2 → shell + preview pane → autosave + shortcuts → steps 1–3 upgrades → steps 4–9 upgrades → motion + copy + axe + flag-flip). |
| 2026-04-19 | TD     | Chunk 2.5o shipped (second of seven wizard-redesign chunks). Drafts list redesign v2 behind `WIZARD_V2_ENABLED`. New `src/config.ts` entry parses `WIZARD_V2_ENABLED` from the env (accepts `true`/`false`/`0`/`1`, defaults off); route helper `isWizardV2Enabled()` re-reads `process.env` at call time so tests can flip it per-case without a module reload. New templates `src/templates/v2/admin_drafts_list.eta` + `_admin_drafts_list_body.eta` render a card-grid redesign: hero CTA with `N` kbd hint, eyebrow + display-face H1 + lede, tab switcher (`In progress` / `Recently published` / `All drafts`, URL-driven via `?tab=…`, `aria-current="page"` on the active tab), filter row (search input with `F` kbd hint + chip-group radios for widget and freshness), card grid of drafts with progress-ring (step/9), three-line-clamped stem, topic chain, widget + command-word + staleness chips (fresh &lt;24h / aging &lt;7d / stale ≥7d, colour-coded with status-dot), hover-reveal "Resume →" action, and a two-state empty panel (no drafts yet vs. no matches). New static assets `src/static/v2/drafts_filter.js` (debounced client-side narrowing of `[data-draft-card]` cells by search / widget / stale, plus a dynamic "no matches" inline status) and `src/static/v2/drafts_shortcuts.js` (keyboard shortcuts: `N` starts a new draft, `F` focuses the filter, `J`/`K`/`↓`/`↑` move selection, `Enter` resumes the selected card; ignores keystrokes inside inputs unless Alt is held). `src/templates/_chrome.eta` loads the two v2 scripts only when `wizardV2DraftsEnabled` is set by the route. `src/static/site.css` gains ~300 lines of v2-only CSS (`.v2-drafts`, `.v2-tabs`, `.v2-filters`, `.v2-draft-card`, `.v2-empty`, `.chip--toggle`, `.btn--lg`, `.kbd--on-accent`/`--in-input`), all using the 2.5n design tokens so dark mode picks up by inheritance. `src/routes/admin-question-wizard.ts` branches the drafts-list GET on the flag: v2 pulls `filters` from the query (`parseDraftsListFilters` clamps `tab`/`stale` to their valid sets and caps free-text to 200 chars) and renders `v2/admin_drafts_list.eta`; v1 is byte-identical to before. New `tests/http/wizard-v2/drafts-list.test.ts` (10 cases): flag-off renders v1 (no `data-drafts-root`), flag-on renders v2 with hero + N-kbd + tab switcher, empty state with first-question CTA, card with progress ring + staleness chip + widget chip + "just now" label, `?q=…` server-side search narrows, `?widget=…` chip-filter narrows, `?tab=published` sets `aria-current` and hides in-progress cards, v2 scripts and CSS primitives are served, and the staleness bucket buckets match `fresh`/`aging`/`stale` (`2 weeks ago` label, backdated `updated_at`). Duplicate / Delete card actions deferred to chunk 2.5q alongside autosave, since those are also net-new endpoints. Final: 87 files / 799 tests passing. Unblocks chunk 2.5p (3-pane shell + rail + action bar + live preview lifted onto steps 5–8).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2026-04-19 | TD     | Chunk 2.5m shipped: three new `logic_diagram` variants as siblings of `image` and `gate_in_box`, expanding the widget's `oneOf` from 2 to 5 branches. **guided_slots** — pupil picks from dropdowns over a fixed option pool per slot; `src/lib/logic-diagram.ts` gains `LogicDiagramGuidedSlotsConfig` + `parseLogicDiagramSlotsRawAnswer` (alias for gates parser — `<id>=<value>` lines) + `markLogicDiagramSlots` (exact match against per-slot `accept`, one mark per slot). **boolean_expression** — pupil types an expression, marker tokenises and compares; `LogicDiagramBooleanExpressionConfig` (accept list, `allowedOperators`, `caseSensitive`, `normaliseSymbols` flags); new `tokeniseBooleanExpression` normalises `.`→AND, `+`→OR, `~`/`/`→NOT, `⊕`→XOR, collapses whitespace, handles parens, case-folds unless `caseSensitive`; marker token-matches against each `accept` entry — one mark on any match. **gate_palette** — pupil drags AND/OR/NOT gates from a palette and wires them between fixed input/output terminals, marker runs the truth table; `LogicDiagramGatePaletteConfig` (canvas, terminals, palette, `maxGates`, `expected.truthTable`); new `evaluatePupilCircuit` (topological DFS + memoisation, cycle-detection via resolving-set, NOT fan-in=1, AND/OR fan-in≥2) and `markLogicDiagramPalette` (all-or-nothing across every truth-table row). `exactOptionalPropertyTypes` gotcha handled with conditional property assignment onto a `{ caseSensitive?: boolean; normaliseSymbols?: boolean }` typed local. Widget registry `LOGIC_DIAGRAM_SCHEMA.oneOf` extended with three full branches (slot-array schema, boolean-expression schema, canvas+terminals+palette+truthTable schema); `docs/widgets.schema.json` regenerated. Deterministic marker `markLogicDiagramPart` rewritten to dispatch on `config.variant` — crucially preserves backward-compat so a logic_diagram part with no config still returns `teacher_pending/open_response` (keeping the pre-existing marking unit test green). `_paper_part_widget.eta` variant dispatch extended 2→5: guided_slots renders an `<ol class="logic-slots__list">` of `<label>` + `<select>` with a "— choose —" default; boolean_expression renders a `<textarea>` plus quick-insert operator buttons (`data-logic-boolean-op`); gate_palette renders an `<svg data-logic-palette-stage>` with terminals pre-rendered, a toolbar with per-palette gate buttons + Wire/Delete/Clear tools, a hidden `circuit` input, and a `<details>` showing the target truth table. `src/static/logic_diagram.js` gains `initBoolean(widget)` (cursor-aware token insertion padding with spaces) and `initPalette(widget)` (click-to-place gates via SVG CTM; click-twice wire tool; click-to-delete; clear; persists as JSON in `circuit=<json>`); `initAll()` dispatches by CSS class (`widget--logic-diagram-boolean`, `widget--logic-diagram-palette`). `src/static/paper.css` gains full style blocks for `.logic-slots__*`, `.logic-boolean__*`, `.logic-palette__*` using existing `--paper-accent` / `--paper-rule` / `--paper-mono` custom properties. Wizard step 5 extended with a 5-way variant radio and four variant-specific sections; new convention `data-visible-when-variant="image,gate_in_box,gate_palette"` (CSV list) for the shared canvas-only section; `parseLogicDiagramGuidedSlots` / `parseLogicDiagramBooleanExpression` / `parseLogicDiagramGatePalette` parsers join the existing variant-dispatched `parseLogicDiagram`. Three curated fixtures added: `content/curated/2.4_logic-diagram-guided-slots.json` (3-slot P = (A AND B) OR NOT C, 3 marks), `content/curated/2.4_logic-diagram-boolean-expression.json` (accept list with 3 phrasings, 1 mark), `content/curated/2.4_logic-diagram-gate-palette.json` (P = A AND B with full 4-row truth table, 1 mark). New unit tests: 32 cases across guided_slots / boolean_expression / gate_palette covering validator accept+reject, round-trip, marker correctness, cyclic-circuit rejection, dangling-output rejection, symbol-form matching; existing `structured_free` rejection test renamed to "rejects unknown variants". New HTTP tests: 3 pupil-widget integration cases (guided_slots dropdowns render + save `ab=AND\nnotc=OR`; boolean_expression symbol form `(A.B)+/C` round-trips as `expression=(A.B)+/C`; gate_palette palette/toolbar render + save `circuit=<JSON>`) and 5 wizard cases (happy paths + rejection for invalid accept / partial truth table). `canvas_core.js` extraction explicitly deferred to a later chunk since two of the three new variants are SVG-native and the third isn't the `<canvas>` freehand pattern. Final: 85 files / 782 tests passing (full `npm run check` green post-prettier auto-format). Closes the `logic_diagram` variant family for the MVP; only follow-up is the deferred `canvas_core.js` refactor if and when a second `<canvas>` freehand consumer lands.       |
| 2026-04-19 | TD     | Chunk 2.5p shipped (third of seven wizard-redesign chunks). Three-pane wizard shell behind `WIZARD_V2_ENABLED`. New templates `src/templates/v2/admin_wizard_step.eta` (wrapper) + `_admin_wizard_step_body.eta` (shell body) lay out `.wizard__rail` (200 px sidebar, sticky, scrolls independently) + `.wizard__main` (editor column, 720 px max-width) + `.wizard__preview` (sticky pane, 360 px at ≥1024 px) + `.wizard__actions` (sticky bottom bar). Below 1024 px the preview pane becomes a right-edge drawer behind a `data-wizard-preview-toggle` button (slides in with `wizardPreviewSlideIn` keyframes, dismissible with `Escape`); below 720 px the rail collapses to a horizontal status-dot strip and the action bar stacks. New partials: `_wizard_rail.eta` (replaces the v1 pill strip — `<nav aria-label="Wizard steps">` + `<ol>` with per-step status dot, number, title, 1-line payload preview; already-visited steps are `<a>` with `aria-current="step"` on the current, not-yet-started steps are non-interactive `<span aria-disabled="true">`), `_wizard_actions.eta` (ghost Back "← Back to step N: {title}" on the left, autosave chip `data-state="saved"` with `aria-live="polite"` in the centre, primary `btn--lg` "Save & continue → step N+1: {title}" on the right; step 9 swaps the primary for a warm-amber `.wizard__publish-btn` with the confirm-hold hooked up in chunk 2.5s), `_wizard_context_banner.eta` (sticky 5-chip strip above the editor on steps 5–9: topic chain · command word · widget · marks · stem snippet, each with an "Edit" link back to its owning step; collapses to flex-wrap below the breakpoint), and `_wizard_preview.eta` (lifted from step 9 to all of 5–9, same `_paper_part_widget` dispatcher as before — so widget behaviour is byte-identical; renders an empty-state card when the stem or widget isn't ready yet). New `src/static/v2/wizard_shell.js` handles the preview-drawer toggle, Escape-to-close, and `sessionStorage`-backed drawer-open persistence so the pane doesn't flap open between step navigations; rail collapse below 720 px is pure CSS. `src/routes/admin-question-wizard.ts` branches `renderStep` on `isWizardV2Enabled()`: v2 renders `v2/admin_wizard_step.eta` and the route sets `wizardPreviewEnabled` on steps 5–9 (so the pupil-widget runtime scripts — `widget_counters`, `cloze_bank`, `matching`, `logic_diagram`, `flowchart`, `trace_grid` — ship on every preview-bearing step, not just step 9 as on v1) plus a new `wizardV2ShellEnabled` flag loaded by `_chrome.eta`. Per-step partials `_wizard_step_<n>.eta` are **untouched** — they still render inside `#wizard-step-form` which lives in `.wizard__editor`; the sticky action bar's submit button uses `form="wizard-step-form"` so the button can sit outside the form DOM subtree while still submitting it. v1 template byte-identical when the flag is off. `src/static/site.css` gains ~440 lines of v2-only CSS (`.wizard__shell`, `.wizard__rail`, `.wizard__rail-link`, `.status-dot` + `--done`/`--current`/`--todo` variants with colour + shape cue, `.wizard__context`, `.wizard__context-chip`, `.wizard__autosave-chip` + `[data-state]` dot colouring, `.wizard__preview`, `.wizard__preview-toggle`, `.wizard__preview-pane`, `.wizard__actions`, `.wizard__publish-btn` warm-amber) all using the 2.5n tokens so dark mode picks up by inheritance. Media queries: ≥720 px promotes to two-column (rail + main); ≥1024 px with `.wizard__shell--with-preview` promotes to three-column and hides the toggle; &lt;1024 px hides the pane until `.is-open`; &lt;720 px collapses rail + actions; `prefers-reduced-motion: reduce` disables the slide-in. New `tests/http/wizard-v2/shell.test.ts` (10 cases): flag-off renders v1 pill strip (no `data-wizard-shell`), flag-on renders the 3-pane shell with rail + autosave chip + actions on step 1, rail marks visited steps as links and todo steps as `aria-disabled="true"`, steps 1–4 have no preview pane but steps 5+ include both pane and toggle, context banner renders five `data-chip` entries with edit links back to steps 1/2/3/6/4, action bar's Back + Save buttons spell out the neighbouring step titles (`"Back to step 2"`, `"step 4: Write the question"`), step 9 shows the publish CTA alongside "Save review notes", preview pane has `data-wizard-preview-toggle` + `aria-expanded="false"` + `aria-controls="wizard-preview-pane"`, `wizard_shell.js` loads when flag is on and not when off, and site.css ships `.wizard__rail`/`.wizard__actions`/`.wizard__preview`/`.wizard__context`/`.status-dot`. Final: 88 files / 809 tests passing (full `npm run check` green post-prettier auto-format). Unblocks chunk 2.5q (autosave endpoint + keyboard shortcuts + revert-last-change; the autosave chip DOM, `data-state` attribute, and `aria-live` region are already in the shell so 2.5q is purely JS + a new route). |
