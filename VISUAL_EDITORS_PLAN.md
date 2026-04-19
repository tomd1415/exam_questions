# VISUAL_EDITORS_PLAN

Survey of every `expected_response_type` in the wizard step-5 editor, identifying where the teacher still has to hand-author pipe-encoded text and where a visual editor would materially improve authoring. Scope is *authoring* only — the pupil-facing widgets already render visually.

Motivation: `my_notes.md` §3 — for logic-gate questions the teacher needs to "select gates and move them around as well as then make the ones that the pupil can change and/or will be missing." The same argument applies, to varying degrees, to every widget whose part_config encodes spatial layout.

## Legend

- **Text only** — editor is a textarea of pipe-encoded lines.
- **Partial** — has a progressive enhancement (live preview / derived picker) but the source of truth is still a textarea.
- **Visual** — has a click-to-place / drag editor that writes back to the textarea.

| Type                  | Step-5 editor template                                   | Current authoring UX | Complexity | Priority |
| --------------------- | -------------------------------------------------------- | -------------------- | ---------- | -------- |
| `multiple_choice`     | `_wizard_step_5_multiple_choice.eta`                     | Partial (live tick picker via `wizard_answer_picker.js`) | Low        | Done-ish |
| `tick_box`            | `_wizard_step_5_tick_box.eta`                            | Partial (same picker) | Low       | Done-ish |
| `short_text`          | `_wizard_step_5_noop.eta` (no config — mark_points only) | Text only            | N/A        | None     |
| `medium_text`         | `_wizard_step_5_noop.eta`                                | Text only            | N/A        | None     |
| `extended_response`   | `_wizard_step_5_noop.eta`                                | Text only            | N/A        | None     |
| `code`                | `_wizard_step_5_noop.eta`                                | Text only            | N/A        | None     |
| `algorithm`           | `_wizard_step_5_noop.eta`                                | Text only            | N/A        | None     |
| `matching`            | `_wizard_step_5_matching.eta`                            | Partial (live pair picker) | Low   | Done-ish |
| `matrix_tick_single`  | `_wizard_step_5_matrix_tick_single.eta`                  | Partial (live grid picker) | Low   | Done-ish |
| `matrix_tick_multi`   | `_wizard_step_5_matrix_tick_multi.eta`                   | Partial (live grid picker) | Low   | Done-ish |
| `trace_table`         | `_wizard_step_5_trace_table.eta`                         | Partial (live prefill/expected grid) | Medium | Low |
| `cloze_free`          | `_wizard_step_5_cloze_free.eta`                          | Text only (passage + gaps) | Medium | Medium |
| `cloze_with_bank`     | `_wizard_step_5_cloze_with_bank.eta`                     | Partial (bank picker; passage still text) | Medium | Medium |
| `cloze_code`          | `_wizard_step_5_cloze_code.eta`                          | Text only (monospace passage + gaps) | Medium | Medium |
| `diagram_labels`      | `_wizard_step_5_diagram_labels.eta`                      | **Visual** (`wizard_hotspot_picker.js`) — click-and-drag hotspots | — | Done |
| `logic_diagram`       | `_wizard_step_5_logic_diagram.eta`                       | Text only (shapes/wires/slots as pipe-encoded lines) | High | **High** |
| `flowchart`           | `_wizard_step_5_flowchart.eta`                           | Text only (shapes/arrows as pipe-encoded lines) | High | **High** |

## Per-type notes

### logic_diagram (gate_in_box variant) — **highest priority**

Current UX: teacher types lines like `q1|decision|200|100|200|80|TEXT|Is A > B?` directly, guesses x/y in pixels, and has no preview until they save and view the pupil page. Adding a blank (`EXPECTED|AND`) requires knowing the exact keyword spelling.

Target UX: a canvas that reuses the pupil-facing gate-rendering code (`src/static/logic_diagram.js`). Teacher:

1. Picks a gate from a palette (AND/OR/NOT/blank) and drops it onto the canvas.
2. Drags to reposition; resize handles adjust width/height.
3. For blank gates, opens a side-panel to enter the `accept` list.
4. Click on a gate/terminal port, then click another to draw a wire.
5. Terminal labels edit inline.

Source of truth remains the pipe-encoded textareas — the canvas is a progressive enhancement that serialises back on every edit (same pattern as `wizard_hotspot_picker.js`).

### flowchart (shapes variant) — **high priority**

Same shape of problem as logic_diagram. Shape palette is 4 items (terminator / process / decision / io). Arrow drawing is simpler because there are no named ports — just from-shape → to-shape with an optional edge label.

Target UX: can directly reuse the renderer in `src/static/flowchart.js` (pupil-facing) as the editor canvas.

### cloze_free / cloze_with_bank / cloze_code — medium priority

Today the teacher types `The {{alu}} performs arithmetic.` and then re-types the ids in a separate gaps textarea; mismatches are only caught on save. A "select a word, click 'make this a gap'" affordance would eliminate the duplication:

- Wrap selection in `{{id}}` markers with an auto-generated id.
- Auto-append a matching line to the gaps textarea.
- Clicking an existing `{{id}}` in the preview jumps to its gaps-row.

Scope is smaller than logic_diagram because there is no canvas — the edit surface is an augmented textarea.

### trace_table — low priority

Already has the live grid picker (`wizard_answer_picker.js` handles it). The remaining authoring friction is minor: column renaming forces a full textarea re-type. A dedicated grid editor (like a spreadsheet) would be nice but isn't a major blocker.

### multiple_choice / tick_box / matching / matrix_tick_* — done-ish

These already have a live derived picker that rebuilds on input and preserves ticks by value. The source-of-truth textarea is small enough that a full drag-and-drop reorder isn't justified.

### diagram_labels — done

`wizard_hotspot_picker.js` already implements click-and-drag authoring. Treat it as the reference implementation for the logic_diagram and flowchart canvas work.

### short_text / medium_text / extended_response / code / algorithm — N/A

No part_config beyond the prompt; only the mark_points list matters, which is handled on step 6 of the wizard, not step 5.

## Suggested sequencing

1. **Chunk D1 — flowchart visual editor.** Smaller canvas, fewer shape types, closer to existing `wizard_hotspot_picker.js` pattern. Prove the interaction model here first.
2. **Chunk D2 — logic_diagram visual editor.** Reuses whatever primitives (palette, drag, wire-drawing) D1 lands.
3. **Chunk D3 — cloze "select-to-gap" affordance.** Independent of the canvas work; can slot in any time after C2 (form-echo on validation error, so mid-authoring edits survive errors).

Each chunk follows the existing progressive-enhancement contract: the textarea stays the source of truth and the server-side parser (`wizard-widget-editors.ts`) remains the one validator. No-JS fallback must still work.

## Non-goals

- A WYSIWYG preview of the pupil-facing rendering for *every* widget — cheap for some (matrix, matching) and expensive for others (logic_diagram). Decide per-chunk, not globally.
- Merging the pupil renderer and the editor canvas into one component. Coupling them makes both harder to change. The editor *reuses* the renderer by composition.
- Replacing the pipe-encoded textarea with a hidden-JSON field. Teachers without JS, and teachers copy-pasting from the "worked example" `<details>`, both benefit from the human-readable format.
