# Pupil feedback tracker

A curated log of pupil feedback across every phase of the project. One row
per comment. This is the **planning view** — the raw DB table
`pupil_feedback` is the authoritative record of what pupils submitted
through `/feedback` on the site. Transcribe each new entry into the table
below as part of triage.

## How this works

- **Pupils submit** free-text feedback at `/feedback` while signed in
  (any role can submit — pupils, teachers, admins).
- **Teachers and admins triage** each entry at `/admin/feedback`: set a
  status, pick a category, and add triage notes. The DB records the
  triage actor and timestamp, and fills `resolved_at` when status is
  `resolved` or `wontfix`.
- **This file** is the project-planning view. Add one row per comment.
  If a DB entry turns into a code change, link the commit or PR in the
  Resolved column so future-you can see the paper trail without digging
  through `audit_events`.

## Columns

| Column            | Meaning                                                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Date              | When the feedback arrived (`YYYY-MM-DD`). Use the DB `submitted_at` date for on-site submissions; use the conversation date for verbal ones. |
| Source            | Pupil username/display name, or `verbal`, `classroom`, `email`, etc. Keep it short.                                                          |
| Phase             | Which project phase the comment relates to (`Phase 0`, `Phase 1`, `Phase 2`, …).                                                             |
| Comment           | Paste the comment verbatim. Trim only leading/trailing whitespace.                                                                           |
| Category          | `UI`, `UX`, `docs`, `new feature`, `change feature`, `bug`, `other`.                                                                         |
| Needs addressing? | `yes` / `no` / `maybe`. A `no` usually pairs with a `wontfix` status.                                                                        |
| How to address    | Short plan — one sentence is fine. Link to a chunk/milestone if scheduled.                                                                   |
| Status            | `new`, `triaged`, `in_progress`, `resolved`, `wontfix`. Mirrors the DB status column.                                                        |
| Resolved (commit) | Commit SHA, PR, or migration number when the change lands. Leave blank while open.                                                           |

## Status vocabulary

- **new** — submitted but not yet triaged. Keep time here short.
- **triaged** — read and understood; not yet being worked on.
- **in_progress** — actively being worked on this phase/chunk.
- **resolved** — a change has landed that addresses the feedback.
- **wontfix** — considered and deliberately declined. Record _why_ in the
  triage notes on the site so the pupil can be given a clear answer.

## Category guidance

- **UI** — visual appearance, layout, colour, typography.
- **UX** — flow, wording, empty states, affordances, keyboard behaviour.
- **docs** — anything that would be fixed by better help text, tooltips,
  or a guide rather than code changes.
- **new feature** — genuinely new capability.
- **change feature** — an existing capability should behave differently.
- **bug** — something is broken against the obvious intended behaviour.
- **other** — doesn't fit the above (e.g. general thanks, off-topic).

## Feedback log

Originating verbal feedback (2026-04-18, pupils, phase 2):

> There are answer styles that are not covered in the answer boxes, for
> example trace tables and matching answers are all structured in the
> exam papers but are just text boxes here.

Split into per-widget rows so each can be scheduled and closed independently.
`trace_table` already exists as an `expected_response_type` but currently
renders as a plain textarea with a `|`-separator hint
([src/templates/\_paper_part_widget.eta](src/templates/_paper_part_widget.eta));
the underlying column is free-text TEXT, so moving to a structured widget
is additive on the storage side.

| Date       | Source | Phase   | Comment                                                                                              | Category     | Needs addressing? | How to address                                                                                                                                                           | Status | Resolved (commit) |
| ---------- | ------ | ------- | ---------------------------------------------------------------------------------------------------- | ------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | ----------------- |
| 2026-04-18 | pupils | phase 2 | Trace tables render as a textarea with a `\|` hint; should be a fixed-size grid with per-cell inputs | change feat. | yes               | New widget for `trace_table`: header row from the question_part config, one input per cell, serialise to the existing `raw_answer` on autosave so marker logic unchanged | new    |                   |
| 2026-04-18 | pupils | phase 2 | Matching answers (draw lines / pair items) render as a textarea                                      | new feature  | yes               | Add `matching` expected_response_type: left column prompts, right column drop targets; serialise to `left_label=right_label` lines                                       | new    |                   |
| 2026-04-18 | pupils | phase 2 | Fill-in-the-missing-word questions with a word bank are not supported                                | new feature  | yes               | Add `cloze_with_bank` widget: prompt contains `___` placeholders, a shared list of distractors is shown, pupil drags/clicks to fill                                      | new    |                   |
| 2026-04-18 | pupils | phase 2 | Fill-in-the-missing-word questions without a word bank are not supported                             | new feature  | yes               | Add `cloze_free` widget: prompt contains `___` placeholders rendered as inline inputs; autosave serialises to `1=foo\n2=bar`                                             | new    |                   |
| 2026-04-18 | pupils | phase 2 | Drawing logic diagrams is not supported                                                              | new feature  | maybe             | Scope is big — start by exporting a blank gate-drawing canvas, defer marking. Or accept an uploaded image/SVG. Decide in Phase 3 planning                                | new    |                   |
| 2026-04-18 | pupils | phase 2 | Filling in blank labels on diagrams is not supported                                                 | new feature  | yes               | Add `diagram_labels` widget: question_part carries an image + label hotspot coords; each hotspot becomes a short_text input                                              | new    |                   |
| 2026-04-18 | you    | phase 2 | Past OCR J277 papers have not been systematically audited for answer types we don't yet cover        | docs         | yes               | Review specimen + released J277 papers, add any new response types to `EXPECTED_RESPONSE_TYPES` and open a row here per type                                             | new    |                   |

<!--
Copy this blank row when you add a new entry:

| YYYY-MM-DD |        |       |         |          |                   |                | new    |                   |
-->
