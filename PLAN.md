# Development Plan

A phased plan to build the OCR J277 revision platform. Each phase ends with a usable artefact, a test with real pupils or against real teacher workflows, and an explicit go/no-go decision before the next phase begins.

## Plan-level principles

- **Ship something usable to one class at the end of every phase from Phase 1 onward.** Even if the only AI in the system is none, pupils must be able to log in and revise.
- **No phase finishes until it has been tested with real users.** Either pupils, the teacher, or both, depending on phase.
- **The LLM is added late and added carefully.** Phases 1 and 2 contain zero LLM dependency. The system must remain useful if the OpenAI API is down.
- **Data protection is a Phase 0 deliverable, not an afterthought.** A DPIA exists before any pupil enters their first piece of personal data.
- **Each phase has a "do not build" list.** This is at least as important as what is built.

## Phase 0 — Foundations, governance, and the smallest possible loop

**Duration estimate:** 2–3 weeks of evening work.
**Hard prerequisite for all other phases.**

### Goal

Have a deployable skeleton, a written DPIA, a copy of the OCR specification mapped to a database, and a single end-to-end happy path from pupil login to a static "hello world" question.

### Build

- Repository, TypeScript project, lint/format, basic CI.
- Production VM live on the school's Proxmox hypervisor, with documented firewall rules (pupils → :443, VM → `api.openai.com`:443) captured in `RUNBOOK.md`. Pupil-facing access is LAN-only for the MVP. The school's existing backup regime is confirmed to capture the application VM; a DB-level `pg_dump` / `pg_restore` drill is performed and recorded.
- PostgreSQL set up with migrations tooling.
- Auth scaffold: local accounts, Argon2 hashes, session cookies. No "register yourself"; teacher creates accounts.
- Curriculum seed data: J277/01 and J277/02 components, all topics and subtopics, all command words. Hand-keyed from the spec, reviewed twice.
- One handcrafted question in the database, displayed at `/q/1`.
- A signed-off Data Protection Impact Assessment (DPIA), privacy notice, and acceptable-use statement. See [SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md).
- Backup and restore tested at least once.

### Do not build

- AI of any kind.
- Adaptive logic.
- Question authoring UI (use SQL or a seed file for now).
- Any analytics.

### User test

- The teacher logs in, opens `/q/1`, types an answer, submits. The submission appears in the database. The pupil account also works. The system is then deliberately rebooted and the data survives.

### Success criteria

- DPIA is signed off (by the user, in their teacher capacity, and shared with their DPO/SLT if required by the school).
- Login works. A pupil cannot see another pupil's data.
- Backup restore demonstrably works.

### Go/no-go before Phase 1

- DPIA is approved by the relevant person at school, or there is an explicit decision to keep the project on a personal device with no real pupil data until that approval lands.
- Firewall rules and TLS approach are documented in `RUNBOOK.md`.
- DB-level restore drill has succeeded at least once.

---

## Phase 1 — Curated content model and a real revision loop

**Duration estimate:** 3–4 weeks.

### Goal

A pupil can log in, choose a topic, answer a small set of curated questions, see their own raw score, and resume later. The teacher can author questions through a basic UI.

### Build

- Full question schema (see [DATA_MODEL.md](DATA_MODEL.md)).
- Teacher question authoring UI: stem, parts, marks, command word, model answer, mark points, common misconceptions, difficulty.
- 60–100 curated questions across both components, weighted toward whatever the user is teaching this term.
- Pupil flows: pick a topic → answer set of 5–10 questions → save and resume → submit.
- Deterministic marking only: multiple choice, exact match, tick-box.
- Open-response questions are stored but show "your teacher will mark this" for now.
- Class membership: the teacher creates a class, adds pupils, assigns a topic set.

### Do not build

- LLM marking.
- Adaptive selection (questions are presented in a fixed teacher-defined order).
- Cross-class analytics.
- Parent / SLT views.

### User test

- One real lesson with the teacher's class. The teacher assigns a topic. Pupils complete it. The teacher reviews submissions in the admin UI.

### Success criteria

- Zero data loss across the lesson.
- Pupils can use the app without teacher support after a 2-minute demo.
- The teacher can author a new question in under 5 minutes.

### Risks specific to this phase

- Schema churn. Mitigation: agree the schema in writing in [DATA_MODEL.md](DATA_MODEL.md) before writing migrations.
- Over-investing in author UX before knowing the workflow. Mitigation: text-area-heavy authoring is fine in Phase 1.

---

## Phase 2 — OCR-style presentation and objective marking polish

**Duration estimate:** 2–3 weeks.

### Goal

The pupil-facing experience looks and feels like serious exam practice without being intimidating. Objective marking gives instant, well-formatted feedback.

### Build

- OCR-style paper layout for question sets (header, marks-in-margin, line-ruled answer space sized to mark tariff). The prototype HTML is the visual seed.
- Question types fully supported in the renderer: tick-box, short text, medium text, extended response, code/algorithm response (monospace input + light syntax styling).
- Optional countdown timer per set.
- Autosave every N seconds and on blur.
- "Submit and review" page showing per-question objective marks and the model answer for objective items.
- Print-to-PDF mode for paper-style sets.
- Accessibility pass: keyboard navigation, focus states, contrast, dyslexia-friendly font option, screen reader labels on every input.

### Do not build

- Anything LLM-driven.
- Adaptive routing.
- Pupil-visible analytics.

### User test

- The teacher's class uses it for a full revision lesson. Collect feedback specifically on: does it feel like an exam? Are the answer boxes the right size? Is the feedback panel useful?
- **Deferred 2026-04-18 → combined with the Phase 2.5 user test.** The only feedback collected against Phase 2 so far (via the `pupil_feedback` channel) was about widget types (pupils) and authoring ergonomics (teacher), both of which Phase 2.5 addresses. The full revision lesson now runs at the end of Phase 2.5 with at least one question of every new widget type included, so the success criteria below are checked against the fuller widget set rather than against a build that is about to change.

### Success criteria

- Pupils describe the experience as "looks like the real paper" without being asked.
- No accessibility blocker discovered with a teacher-led screen-reader pass and a colour-blindness simulator.
- Print-to-PDF produces something a teacher would happily mark on paper.

(Checked at the combined Phase 2 + Phase 2.5 sign-off lesson; see PHASE2.5_PLAN.md §10.)

---

## Phase 2.5 — Extended answer widgets and authoring ergonomics

**Duration estimate:** 4–6 weeks.

### Why this phase exists

Phase 2 shipped the OCR-style layout but only against the answer types already in `EXPECTED_RESPONSE_TYPES`: multiple_choice, tick_box, short_text, medium_text, extended_response, code, algorithm, trace_table. A live-paper audit across the six 2022–2024 J277/01 and J277/02 question papers found several answer formats that appear on every paper and are not adequately represented by those widgets. Pupils have also flagged shortcomings in existing widgets (see [PUPIL_FEEDBACK.md](PUPIL_FEEDBACK.md)).

This phase closes the widget gap **before** Phase 3 begins, for two reasons:

1. **Phase 3 prompt design depends on the widget set.** The LLM marking prompt varies significantly between a plain text answer, a cloze inside code, and a matrix-tick grid. Fixing the widget set first means Phase 3 prompts are not written twice.
2. **Phase 5 generation must include these question types.** If Phase 5 is trained on a bank that only has text-shaped questions, the generator will never propose a trace table or a cloze-in-code item, which are exactly the high-mark questions that appear in Section B.

### Goal

Pupils can answer every question format that appears in the J277 live papers in a widget that fits the shape of the answer, not just a big text area. Teachers can author those questions without memorising a schema.

### Chunks

The phase splits into widget chunks followed by authoring-ergonomics chunks. Each chunk ends with a usable increment; the phase is not shipped to pupils until the authoring chunks land.

#### 2.5a — Matrix tick (single-select per row)

The single most common table format across all six audited papers (file sizes → binary units, statements → low/high-level, events → legislation, code → selection/iteration, data → data type). Pupil ticks exactly one box per row from a fixed column set.

- Widget: row headings, column headings, one exclusive radio group per row.
- Authoring: rows as free text, columns as labels, correct cell per row.
- Deterministic marking: one mark per correctly-ticked row by default, with the teacher able to set a different mark scheme.

#### 2.5b — Matrix tick (multi-select per row) and multi-select tick_box

Covers "tick one or more boxes on each row" (2022/01 Q6a(ii) sound-file effects, 2023/01 Q4a cybersecurity) and "tick **two** boxes" non-matrix variants (2023/01 Q1d).

- Extend 2.5a to allow per-row multi-select, and extend the existing single-select `tick_box` to support "tick exactly N".
- Marking is the correct set of ticks per row or per question; partial credit configurable per question.

#### 2.5c — Cloze widgets

Three variants, one shared data model with a rendering flag:

- **cloze_free** — gaps inside plain prose, no word list. Mark per gap.
- **cloze_with_bank** — gaps inside prose plus a bank of terms; terms are used zero, one, or many times (per the 2022/01 Q3b and 2023/01 Q3a patterns).
- **cloze_code** — gaps inside monospaced pseudocode. Distinct renderer because the gap sits inside a code block and must not reflow. Appears in 2023/02 Q1c arithmetic operators, 2024/02 Q3b missing operators, 2024/02 Q8b dotted-line function completion, 2024/02 Q9aii/d and Q9cii.

Authoring uses a shared editor: the teacher writes the text or code, wraps each gap in `{{ }}` or a click-to-blank UI, and each gap accepts a list of acceptable answers.

Addresses the cloze_with_bank and cloze_free rows in [PUPIL_FEEDBACK.md](PUPIL_FEEDBACK.md).

#### 2.5d — Trace table (proper grid) with optional pre-filled cells

Replaces the current text-box representation flagged in PUPIL_FEEDBACK.md. Columns are named (variables + Output + optional Line number). Rows are editable cells. Teacher can pre-fill any cell (as seen in 2022/02 Q2d(ii) where the first two rows ship partially populated).

- Marking: per-cell exact match, with configurable "ignore trailing whitespace" and "case-insensitive".
- Same widget renders truth tables (2023/02 Q4b, 2022/02 Q2a) since they share the grid shape.

#### 2.5e — Matching

Drag-line or paired-dropdown UI for "match term to definition" questions. Addresses the matching row in [PUPIL_FEEDBACK.md](PUPIL_FEEDBACK.md).

- Authoring: left-column items, right-column items, correct pairs. Right column can contain distractors.
- Deterministic marking.

#### 2.5f — Logic diagrams

Covers both papers' variants:

- **Free-draw canvas** with a palette of AND/OR/NOT/XOR gates, input/output pins, and wires. Pupil draws the circuit on a blank canvas (2023/02 Q4a floodlight).
- **Gate-in-box**: the canvas ships with dotted-outline target boxes pre-positioned and pre-wired; pupil drops a gate into each labelled box (2022/02 Q2a(i)).

Marking is **not** deterministic in Phase 2.5. Logic diagrams are stored as structured JSON (gate list + wire list) so a Phase 3 marker can parse them, and in Phase 2.5 they are flagged for teacher marking via the existing "your teacher will mark this" path. Addresses the logic_diagrams row in [PUPIL_FEEDBACK.md](PUPIL_FEEDBACK.md).

#### 2.5g — Diagram labels

Image with click-targets; pupil types a label into each target. Covers "label the parts of a star topology" (2024/01 Q2ci, simplified) and any future diagram-labelling content the teacher wants to author. Addresses the diagram_labels row in [PUPIL_FEEDBACK.md](PUPIL_FEEDBACK.md).

#### 2.5h — Flowchart drawing / completion

A shape-aware canvas (start/stop terminators, process rectangles, decision diamonds, arrows). Supports both "draw the whole flowchart" (2022/02 Q2b) and "complete this partially-drawn flowchart" (2024/02 Q2).

Like logic diagrams, stored as structured JSON, teacher-marked in this phase.

#### 2.5i — Pupil answer-entry polish

A cross-widget UX chunk that makes answering consistent across every widget type:

- Autosave behaves identically everywhere (debounced write, "saved Xs ago" indicator, no surprises).
- Keyboard-only navigation works end-to-end: Tab moves through gaps, arrows navigate grid cells, Enter submits, Esc cancels.
- Mobile ergonomics: tap targets ≥44px, grids scroll horizontally without losing row headers, cloze gaps do not trigger autocapitalise/autocorrect when they contain code.
- Clear "how to answer this" microcopy on the first encounter with each new widget type (dismissible, remembered per user).
- Screen-reader labels and ARIA patterns reviewed for each new widget; existing dyslexia-friendly font toggle extends to every new widget.
- Undo within a widget (one level) where destructive editing is possible (trace table, logic canvas, flowchart canvas).

#### 2.5j — Teacher question-creation wizard

Replace the one-long-form authoring page with a step-by-step wizard that asks one thing at a time and narrows choices based on prior answers. Teachers should never see a schema; they should see a series of questions about the question they are creating.

Wizard steps (each step is its own screen with Back/Next; progress is saved after each step so the teacher can resume):

1. **Where does this question live?** — Component (J277/01 or /02), topic, subtopic. Hides irrelevant command words in later steps.
2. **What is the command word?** — State, describe, explain, compare, write an algorithm, complete the table, etc. Each command word carries a hint about typical mark tariffs and typical response types.
3. **What shape is the answer?** — A picker of the widget types above, filtered by what is reasonable for the chosen command word. "Write an algorithm" does not offer matrix_tick. Each widget shows a miniature preview and a sentence on when to use it.
4. **Widget-specific editor** — the only step that differs per widget. Matrix tick asks for rows, columns, and the correct cell per row; cloze_code asks for the code block and click-to-blank gaps; trace table asks for the pseudocode, column names, and pre-filled cells. Inline validation flags obvious mistakes (e.g., a matrix tick with no correct answer marked).
5. **Stem and context** — the narrative above the answer widget, with a live preview.
6. **Marks and model answer** — mark tariff, model answer, mark points (bullets that the LLM will use in Phase 3), and accepted alternatives.
7. **Common misconceptions** — optional; each misconception is tagged so Phase 6 clustering works.
8. **Difficulty and tags** — 1–9 grade band, 1–3 challenge step, optional paper-section tag (Section A / Section B for /02).
9. **Review and publish** — full preview exactly as the pupil will see it, with a "try answering it yourself" button that actually submits against the deterministic marker so the teacher catches their own rubric errors before pupils do.

Authoring ergonomics beyond the wizard:

- "Clone this question" for authoring a near-duplicate at a different difficulty.
- "Save as draft" at every step.
- A question-bank view that filters by topic, command word, widget, and difficulty.
- Inline help text on every step, authored in plain language, not schema language.

### Do not build

- LLM-assisted authoring of any part of the wizard. That is Phase 5.
- Auto-marking of logic diagrams or flowcharts. They are teacher-marked in this phase; Phase 3 revisits.
- Pixel-grid (2023/01 Q3bii) and sort-step visualisation (2022/02 Q3a) widgets. One occurrence each across six papers; free-draw fallback via an image upload is acceptable until demand is proven.
- Cross-question templates or "question packs" — out of scope for this phase.
- Any change to the marking pipeline beyond adding per-widget deterministic markers.

### User test

Two rounds, in order:

1. **Teacher test first.** The teacher authors ten questions using the wizard, one per widget type. Target: under 5 minutes for simple widgets (matrix tick, tick_box multi, diagram labels), under 10 minutes for complex widgets (trace table, cloze_code, flowchart). Every widget must be reachable without help text beyond what the wizard itself shows.
2. **Pupil test after.** A real lesson in which the class answers a set containing at least one question of each new widget type. Collect feedback via the PUPIL_FEEDBACK.md channel introduced in chunk 9.

### Success criteria

- Every widget listed above renders correctly on the slowest device in the classroom and via the school's accessibility tooling.
- The teacher authors a full new question in under 10 minutes using only the wizard, for every widget type.
- A question written in the wizard round-trips through the deterministic marker (for widgets that support it) with zero schema errors.
- Pupils report (unprompted in the feedback channel) that at least three of the new widgets "feel like the real paper".
- No regression in Phase 2 accessibility pass.

### Risks specific to this phase

- **Scope creep on the canvas widgets.** Logic diagrams and flowcharts are tempting rabbit-holes. Mitigation: both are teacher-marked in 2.5; only the JSON representation needs to be correct. Rendering polish can slip into Phase 7.
- **Wizard becomes a wall of forms.** Mitigation: every step that has no information to ask about is skipped, not shown with a "nothing to do here" message. The wizard must feel shorter than the current single page, not longer.
- **Widget sprawl diluting Phase 3.** Mitigation: the widget set is frozen at the end of 2.5; Phase 3 marking prompts assume no new widget types.

### Forward-compatibility note

The widget set chosen here is tuned to OCR J277 Computer Science, but the platform is expected to be offered to other subjects in the school once CS is fully tested (see "Design decisions worth recording"). Implement each widget as an entry in an extensible registry, not a hardcoded enum branch, and keep subject-specific vocabulary (e.g., "pseudocode", "OCR Exam Reference Language") out of widget identifiers and generic UI copy. See the multi-subject entry in "Design decisions worth recording" for the full set of implications.

---

## Phase 3 — LLM-assisted marking with full audit trail

**Duration estimate:** 4–6 weeks. **This is the highest-risk phase.**

### Goal

Open-response questions are marked with LLM assistance. Every AI mark is auditable, has a confidence score, and is easy for the teacher to override. The teacher trusts the system enough to use it on a real homework.

### Build

- OpenAI Responses API client wrapper with structured outputs against a versioned JSON schema (see [PROMPTS.md](PROMPTS.md)).
- Marking pipeline:
  1. Deterministic pre-checks (empty? too short? contradiction obvious?).
  2. LLM marking call with rubric, mark points, accepted alternatives, misconceptions, OCR-style rules.
  3. Safety gate: low confidence, weak evidence, high marks on a thin answer → flag for moderation.
- Moderation queue UI for the teacher: side-by-side pupil answer, AI mark, evidence quotes, override controls.
- Pupil-facing feedback: "What went well / How to gain more marks / Next time…", capped to 3 short blocks, written at a Year 10 reading level.
- Audit table: prompt version, model id, raw response, latency, token cost, override status.
- Cost dashboard (teacher-only): cost-per-pupil-per-week, projected monthly cost.
- Kill switch: a single setting that disables all LLM calls and falls back to "your teacher will mark this".

### Do not build

- Generation of new questions.
- Adaptive sequencing.
- Misconception clustering across pupils.

### User test

- Pilot with one topic and one class. The teacher marks the same answers in parallel for the first week. Compare distributions. Investigate every disagreement.

### Success criteria

- On the pilot topic, AI marks fall within ±1 mark of the teacher mark on at least 85% of responses.
- The teacher can clear a 30-pupil moderation queue in under 15 minutes.
- The cost per pupil per week is within an explicit budget set in [RESOURCES_REQUIRED.md](RESOURCES_REQUIRED.md).
- Zero pupil-facing feedback contains hallucinated facts about the spec, verified by manual review of a 50-response sample.

### Hard rule

AI marks shown to pupils in this phase are explicitly labelled as "marked with AI assistance — your teacher will check". This label only comes off when Phase 6 analytics show consistent agreement.

---

## Phase 4 — Adaptive sequencing

**Duration estimate:** 3–4 weeks.

### Goal

The next question is chosen for each pupil based on their mastery profile rather than a fixed order. Strong pupils get stretched, weak pupils get scaffolded, no pupil is buried.

### Build

- Mastery model: per pupil × topic × command word × response-type, scored 0–100 with recency and confidence weighting.
- Difficulty model on questions: 1–9 grade band × 1–3 challenge step within band, separately tracked per response type.
- Question selector: 70% in target zone, 20% one band easier, 10% one band harder. Frustration protection: never serve three "fail" questions in a row.
- "Weakest areas" mode and "spaced retrieval" mode for pupils.
- Live calibration: difficulty estimates update from real attempt data once a question has ≥30 attempts.

### Do not build

- AI question generation.
- Cross-class trends.

### User test

- A/B test on the teacher's class: half the pupils on adaptive, half on fixed order, swapped halfway. Compare engagement, completion rate, and post-test scores.

### Success criteria

- Adaptive group reports the experience as "challenging but fair" at higher rates than fixed group.
- No pupil ends a session with mastery scores lower than they started in their target topic without an explanation in the audit log.
- The teacher can read and trust a single pupil's mastery profile in under 30 seconds.

---

## Phase 5 — AI question generation with teacher approval

**Duration estimate:** 4–6 weeks.

### Goal

The question bank grows without proportional teacher authoring time. Generated questions are spec-aligned, OCR-style, original, and only enter the live bank after teacher approval.

### Build

- Retrieval over: spec wording (chunked + embedded), curated past-question structures, mark scheme patterns, examiner-report misconceptions.
- Generation prompt producing a full question package per [PROMPTS.md](PROMPTS.md): stem, parts, marks, model answer, mark points, misconceptions, difficulty rationale, command word, topic mapping.
- Validator pass (separate prompt) that re-checks the generated question against the spec and against the originality rule.
- Duplicate detection via embedding similarity against existing bank and against any imported source-paper text.
- Teacher approval queue: read, edit, approve, reject. Bulk approval is not a feature.
- "Generated from" provenance on every question.

### Do not build

- Auto-publishing of any question.
- Generation of whole papers (Phase 7).

### User test

- The teacher generates a batch of 30 questions. Time how long approval/edit/reject takes. Sample 10 against the spec line-by-line for accuracy.

### Success criteria

- ≥70% of generated questions accepted with only light editing.
- Zero questions accepted that are near-duplicates of OCR source material (similarity threshold defined in [PROMPTS.md](PROMPTS.md)).
- Per-question generation cost within budget.

---

## Phase 6 — Teacher analytics and misconception intelligence

**Duration estimate:** 3–4 weeks.

### Goal

The dashboard tells the teacher something they did not already know, and saves them time planning the next lesson.

### Build

- Class heatmap: topic × pupil, coloured by mastery.
- Command-word weakness view.
- "Most missed mark points this week" list with example pupil responses.
- Misconception cluster view (embedding-based, with teacher-editable labels).
- Low-confidence AI marks queue persisted from Phase 3.
- Pupils-stalled-at-band list, pupils-ready-for-paper-mode list.
- Printable / exportable summaries (PDF and CSV) for parents' evening and for SLT.

### Do not build

- Cross-school benchmarking.
- Live notifications. (Email digest is fine; push is not.)

### User test

- Teacher uses only the dashboard to plan the next lesson. Compare the resulting plan to what they would have planned without the tool. Was anything new revealed?

### Success criteria

- Teacher reports at least one "I would not have spotted that" insight per week.
- Lesson planning time reduced or kept flat (tool must not add work).

---

## Phase 7 — Hardening, paper mode, and department rollout

**Duration estimate:** 4–6 weeks.

### Goal

Move from "the teacher's class uses it" to "the department uses it". Paper mode supports mock-exam practice. Operational cost and stability are well-understood.

### Build

- Paper builder: by component, by topic mix, by total marks, by duration.
- Mock exam mode with strict no-feedback-until-end behaviour.
- Multi-teacher support: classes per teacher, shared question bank, per-teacher dashboards.
- Bulk pupil import (CSV from school MIS).
- Account reset flows.
- Retention policy enforcement (auto-delete inactive pupil data per [SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md)).
- Cost controls: per-class API budget, alerts.
- Versioned prompt registry.
- Operational runbook (start, restart, restore from backup, rotate API key).

### User test

- Whole-cohort mock under classroom conditions across multiple devices and browsers.

### Success criteria

- Stable under simultaneous use by at least one full class on the slowest devices the school owns.
- A second teacher in the department can run a lesson with the platform after a 30-minute walkthrough.
- Monthly running cost is within the agreed budget with margin.

---

## Design decisions worth recording

Choices made during planning that are not obvious from the phase list and would be expensive to revisit:

- **Phase 0 exists explicitly.** Governance, hosting, and the DPIA are deliverables, not assumptions.
- **DPIA, privacy notice, and safeguarding flow are blockers before pupil data enters the system**, not "important". Working with under-16s in a UK school raises the threshold.
- **The Phase 3 kill switch is a first-class feature.** The system must remain usable when the LLM is unavailable, expensive, or wrong.
- **AI marking runs in parallel with teacher marking on the pilot topic** before any AI mark is shown to a pupil unlabelled. Moderation alone is not enough.
- **Originality controls in Phase 5 are mandatory.** Embedding similarity against source papers gates publication; teacher approval is the second gate.
- **Multi-teacher support is held back to Phase 7.** Designing for multiple teachers from day one is the fastest way to ship nothing.
- **No Redis until Phase 4.** No queues are needed for the early loop.
- **Multi-subject rollout is a planned future, not a promise for the first year.** Once the platform is fully tested with the user's own GCSE CS classes, the intention is to offer it to other subjects in the school. No subject-level work happens before Phase 7, and it is explicitly out of scope for Phases 0–6. However, to keep the option open cheaply, ongoing work should:
  - Treat response-type widgets as entries in an extensible registry (id, renderer, authoring editor, marker), not a hardcoded enum branch. Adding a sixth cloze variant or a subject-specific widget (e.g., a musical-notation input) should be a registry entry plus two files, not a schema migration plus changes across fifteen call sites.
  - Keep the curriculum schema general: "qualification → component → topic → subtopic → command word" happens to fit J277, but the column names and the authoring wizard's step 1 should not assume exactly that shape. Other subjects have texts + themes, skills + strands, eras + figures, etc. A qualification row that carries its own taxonomy labels is cheaper to add later than a rename across fifty files.
  - Avoid subject-specific vocabulary in generic identifiers, table names, and pupil-facing copy outside the question itself. "Pseudocode", "OCR Exam Reference Language", "J277", and "computer science" belong in question content and in subject-scoped config, not in route names (`/cs/...`), widget ids (`CsTraceTable`), or generic UI labels ("Write your algorithm").
  - Keep LLM prompts and mark-scheme templates parameterised by subject and qualification from Phase 3 onward. A prompt that hardcodes "GCSE Computer Science" in the system message is fine for now but must be trivially re-parameterisable when a second subject lands.
  - Revisit the DPIA, privacy notice, and retention policy whenever a new subject is added — scope of personal data processing changes even if the software does not.
    A concrete multi-subject rollout phase (Phase 8 or later) is not planned yet and is deliberately left unscheduled until CS is stable in production.
