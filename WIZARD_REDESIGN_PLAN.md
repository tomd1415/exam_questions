# Wizard UI/UX redesign plan

> Companion plan to PHASE2.5_PLAN.md, chunks **2.5n – 2.5t**. The existing
> wizard (chunks 2.5j.1 – 2.5j.polish) is fully functional; this plan is a
> presentation-layer overhaul. No schema migrations, no new `expected_response_type`
> values, no marking changes.

---

## 1. Why this exists

The current wizard works but reads as an internal admin form. For the "Thursday
3:15 p.m. teacher" (just finished a lesson, 20-minute window, tired, has a
past-paper printout) the wizard's ratio of chrome-to-content is wrong and the
feedback loop is too quiet:

- 250 px of breadcrumb / step-counter / pill-strip before any input is visible.
- Step pills are numbers only; step titles are `visually-hidden`.
- Validation surfaces only on submit, as an alert block at the top.
- Preview is locked to step 9, so steps 5–8 are authored blind.
- No autosave chip: the only "it was saved" signal is a page reload.
- No keyboard shortcuts, no command-K, no search across drafts.
- Drafts list is two plain tables with no at-a-glance "where was I?" cue.

The goal of this redesign is to make the teacher trust the wizard, move faster,
and enjoy using it — without changing what questions it can produce.

---

## 2. Personas (who we're optimising for)

### Thursday teacher (primary)

Just finished period 5. Has a past-paper printout. 20-minute window before a
departmental meeting. Wants to stamp out one question, stop partway, pick up
tomorrow morning in the car park. Needs: trust that work is saved, minimum
chrome, one-keystroke progression, clear "where was I?" on resume.

### Sunday-night teacher (secondary)

Quieter. Batch-authoring three questions for next week's topic. Cares about
previewing the pupil experience, tagging correctly, spotting typos. Needs:
always-on pupil preview, a publish-readiness checklist, a way to clone a
published question to remix it.

Both use the same UI. When the two personas conflict, **Thursday wins**.

---

## 3. Decisions recorded (from the 2026-04-19 discussion)

| #   | Decision                                                                                                                                                                                                                                                     | Rationale                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Warm serif display face.** Source Serif 4 for step titles / review headings / pupil-preview framing. Body stays `--font-sans`.                                                                                                                             | Gives the wizard character without making it less legible for a tired teacher; signals "this is a writing environment, not a CRUD form".                         |
| 2   | **Warm secondary accent: muted amber.** Specifically `--color-accent-warm-500: #c2892a` with 50/100/700 ramps. Used for "complete / published / this-just-saved" moments. Blue stays the primary brand; amber is reserved for celebratory and "done" states. | Amber reads as "school-paper warm" without being childish, holds up in dark mode, and is colour-blind-distinguishable from the brand blue and the success green. |
| 3   | **Dark mode in scope (chunk 2.5n).** `[data-theme="dark"]` token overrides only — no component rewrites. Toggle lives next to the OpenDyslexic font toggle.                                                                                                  | Staff-room fluorescents are hostile; several teachers have asked. Token-only keeps the cost small.                                                               |
| 4   | **Split-pane preview from step 5.** The live pupil preview pane (today lifted out of `_wizard_preview.eta` and mounted on step 9) moves to steps 5–8 too. On ≤1024 px it collapses to a slide-in panel.                                                      | Single biggest usability win — removes "authoring blind" across four steps. Teachers fiddling more is a feature, not a bug.                                      |
| 5   | **Loud autosave.** A chip in the sticky action bar: "Saved 3s ago" / "Saving…" / "Offline — will retry". Announced to screen readers via `aria-live="polite"`.                                                                                               | Thursday teacher has to trust state immediately. Noise is fine — invisibility is not.                                                                            |
| 6   | **7 chunks (2.5n – 2.5t). Not live until complete.** A new chrome flag `WIZARD_V2_ENABLED` gates every template and route path; while off, the existing wizard is untouched. Flag flips on after chunk 2.5t lands and PHASE2.5_PLAN.md gets a sign-off row.  | Each chunk can ship in isolation without disrupting teachers currently using the v1 wizard.                                                                      |

---

## 4. Design principles to apply

- **Hick's law** — ≤5 primary choices visible per step; everything else under
  a `<details>` or a "more" affordance.
- **Fitts's law** — primary action is a large, viewport-bottom-sticky button,
  reachable on a 13" laptop without scrolling.
- **Recognition over recall** — command word, mark tariff, widget example all
  visible next to the choice that depends on them.
- **Progressive disclosure** — misconceptions, review notes, source=AI live
  behind click-to-open.
- **Doherty threshold** — autosave + live preview + live correct-answer pickers
  respond <200 ms.
- **Jakob's law** — keep the 9-step IA; upgrade presentation only.
- **Aesthetic-usability effect** — treat the wizard as a product surface, not
  an admin form.

---

## 5. Design-system changes (chunk 2.5n)

### 5.1 Tokens (`src/static/design-tokens.css`)

Add, without removing:

```css
/* Warm secondary ramp (amber) */
--color-accent-warm-50: #fdf4e3;
--color-accent-warm-100: #f7e3b8;
--color-accent-warm-500: #c2892a;
--color-accent-warm-700: #7a5414;
--color-accent-warm-ink: #ffffff;

/* Display type */
--type-display: 2rem; /* drafts-list hero         */
--type-h1: 1.75rem; /* (was 1.4rem)             */
--type-h2: 1.25rem; /* (was 1.15rem)            */
--type-lede: 1.05rem; /* per-step lede copy       */

/* Writing-surface leading */
--leading-tight: 1.3;
--leading-body: 1.55;
--leading-prose: 1.7;

/* Elevation scale */
--shadow-resting: var(--shadow-sm);
--shadow-raised: var(--shadow-md);
--shadow-floating: var(--shadow-lg);

/* Motion */
--duration-fast: 120ms;
--duration-mid: 200ms;
--ease-standard: cubic-bezier(0.2, 0, 0, 1);

/* Dark-mode overrides (applied via [data-theme="dark"]) */
```

Dark-mode override block — full palette inversion with tuned contrast:

```css
[data-theme='dark'] {
  --color-surface-0: #14141c;
  --color-surface-1: #1b1b24;
  --color-surface-2: #242430;
  --color-surface-3: #2e2e3c;
  --color-ink-1: #f2f2f6;
  --color-ink-2: #cacad6;
  --color-ink-3: #9a9aac;
  --color-border: #2e2e3c;
  --color-border-strong: #45455a;
  --color-brand-50: #16224a;
  --color-brand-100: #1e2e68;
  /* brand-500/600/700 unchanged — they're anchors */
  --color-accent-warm-50: #3a2c10;
  --color-accent-warm-100: #553f16;
}
```

### 5.2 Font loading (`src/templates/_chrome.eta`)

Self-host Source Serif 4 Variable (`.woff2`, latin subset, 400 + 600 weights).
Same `@font-face` pattern as OpenDyslexic. Total added weight ≈ 50 KB.

### 5.3 Theme toggle

Extend the existing font-preference dropdown in `_chrome.eta` to a
"Appearance" block: font (system / OpenDyslexic) × theme (auto / light / dark).
Persist via existing user-preferences path. Auto = `prefers-color-scheme`.

### 5.4 New primitives (add to `site.css`)

- `.chip` / `.chip--accent` / `.chip--success` / `.chip--warn` / `.chip--muted`
- `.icon` (12×12, 16×16, 20×20 variants — `currentColor`)
- `.progress-ring` (SVG, used on draft cards)
- `.kbd` (inline keyboard key chip: `<kbd>⌘</kbd>`)
- `.status-dot` (current/done/todo, colour + shape cue)

---

## 6. Shell redesign (chunk 2.5p)

### 6.1 Layout

Three-pane at ≥1024 px, stackable below:

```
┌──────────────┬─────────────────────────────┬──────────────┐
│ .wizard__rail│ .wizard__editor             │ .wizard__preview
│ 200 px        │ 640–720 px content column   │ 320–420 px   │
│ sticky        │ scrollable                  │ sticky       │
└──────────────┴─────────────────────────────┴──────────────┘
                 ┌─────────────────────────────┐
                 │ .wizard__actions (sticky)   │
                 └─────────────────────────────┘
```

Below 1024 px: preview collapses to a slide-in panel behind a "Preview" toggle.
Below 720 px: rail collapses to a horizontal strip with just status dots; full
titles behind a "9 steps" chip.

### 6.2 Step rail (replaces the pill strip)

- `<nav aria-label="Wizard steps">` containing `<ol>` of steps.
- Each item: step number, icon, title, 1-line payload preview, status dot.
- Already-visited steps are links with `aria-current="step"` on the current
  one. Not-yet-visited steps are non-interactive.

### 6.3 Sticky action bar (always visible)

- Left: `← Back to step N: {title}` (ghost).
- Centre: autosave chip (live region).
- Right: `Save & continue to step N+1: {title} →` (primary, large).
- Step 9: right button becomes `Publish question` in warm-amber + 2-second
  confirm-hold before fire (Thursday-teacher safety).

### 6.4 Context banner (replaces the bare stem banner)

Sticky chip strip above the editor on steps 5–9 showing five chips:
`component › topic › subtopic` · `command word` · `widget` · `X marks` · `stem`.
Each chip has an "edit" link back to the owning step. Collapses to a single
summary chip on narrow viewports.

### 6.5 Shared drafts-list shell (chunk 2.5o)

- Hero CTA "Start a new question" with `<kbd>N</kbd>` shortcut hint.
- Tab switcher: `In progress` / `Recently published` / `All drafts`.
- In-progress grid = card grid (3 cols ≥1024, 2 cols ≥720, 1 col below):
  progress ring, stem snippet, topic chain, widget icon chip, relative-time
  staleness chip (green <24h, amber <7d, red >7d), hover-reveal
  Resume / Duplicate / Delete.
- Filter row above the grid: search input, widget chip-group, topic chip-group,
  status chip-group. Filter state stays in the URL query so it's shareable.
- Empty state: warm illustration + 60-second "what this is" explainer +
  "Start from an example" CTA seeded from curated fixtures.

---

## 7. Per-step redesigns

### Step 1 — Where does this question live?

- Replace stacked selects with a **cascading combobox**: one search input that
  narrows the whole component→topic→subtopic tree on type. Native selects remain
  as the no-JS baseline.
- Below: "Questions that already live here: **12**" (live count).
- Touch-points: `_wizard_step_1.eta`, new `wizard_curriculum_combobox.js`,
  existing `wizard_curriculum_chain.js` remains as fallback.

### Step 2 — What does the question ask the pupil to do?

- Command word **chip grid** (replaces `<select>`). Each chip: word + 4-word
  gloss.
- Hovering / focusing a chip reveals the recommended widgets for step 3 in the
  right pane — pre-teaches what comes next.
- Touch-points: `_wizard_step_2.eta`, new `wizard_command_word_grid.js`.

### Step 3 — How should the pupil answer?

- Each widget tile gains a **60×60 SVG thumbnail** of the pupil UI.
- Tile shows: thumbnail, display name, one-line description, typical marks
  (1 / 2–4 / 5+), typical authoring time (~2 min / ~5 min), marker chip.
- Promote the 2 most-used widgets from "other" based on this teacher's last 10
  publishes (read-only query on `questions` where `author_user_id = me`).
- Touch-points: `_wizard_step_3.eta`, new `src/static/widget_thumbs/*.svg`,
  registry `widget.thumbUrl` property, `wizard-widget-editors.ts` untouched.

### Step 4 — Write the question

- Full writing-canvas treatment: 800 px max width, `--leading-prose`, auto-expanding textarea, subtle lined-paper background (SVG data URL).
- Word / character counter in the action bar.
- Quick-insert row: "Paste from past paper" (opens dialog, strips paper
  numbering), "Insert code block" (wraps selection in triple-backtick),
  "Insert image reference".
- Below: a silent preview card showing the stem in pupil-paper type.
- Touch-points: `_wizard_step_4.eta`, new `wizard_stem_editor.js`.

### Step 5 — Set up the answer area

- Split-pane becomes canonical: live pupil preview on the right. Re-uses
  `_paper_part_widget.eta` (same dispatcher as step 9 today).
- Above the editor: a **"Change widget ▾"** slash-menu-style affordance.
  Snapshots the current step-5 payload to a Redis-less in-memory cache keyed by
  `draft_id + widget_type` so the teacher can swap back without losing work.
- Per-field errors sit **beneath their input**, not in the top alert. Alert
  still renders on the server-rendered path for no-JS.
- Every widget editor gains a **"Use this example"** button that populates
  fields from the curated fixture for that widget — builds on the existing
  worked-example `<details>` blocks.
- Press `.` to jump focus to the first erroring field.
- Touch-points: every `_wizard_step_5_<widget>.eta`, new `wizard_widget_swap.js`,
  new `wizard_inline_errors.js`, `admin-question-wizard.ts` route (new autosave
  - widget-swap endpoints).

### Step 6 — Marks and model answer

- Two-column layout ≥1024 px: left = marks + model answer; right = mark-point
  list.
- Mark-point list upgrades to a **chip list**: one row per mark point with a
  pipe-chip per accepted alternative. Drag-handle to reorder. Keyboard:
  `Enter` adds a mark point, `Tab` indents into an alternative.
- Auto-derived list (multiple_choice, tick_box) is visually read-only with an
  "Edit on step 5 →" link — today's copy is correct; this is a visual upgrade.
- Touch-points: `_wizard_step_6.eta`, new `wizard_mark_points.js`,
  `wizard-widget-editors.ts` pipe-parser unchanged.

### Step 7 — Common misconceptions

- Collapsed by default: "Skip for now — add later."
- When expanded: 3 AI-free example misconceptions derived deterministically
  from the chosen `command_word × widget` combination (lookup table in
  `src/lib/misconception-examples.ts`). Teacher can accept / edit / dismiss.
- Touch-points: `_wizard_step_7.eta`, new misconception-examples table.

### Step 8 — Difficulty and tags

- Difficulty band: horizontal 1–9 slider with coloured stops (green → amber →
  red). Step-within-band: 3-dot chooser next to it.
- Source: chip group, not radio list.
- New field: `expected_time_seconds`. Surfaces in the pupil paper (already
  plumbed on the pupil side via `part.expected_time_seconds`, unpopulated
  today).
- Touch-points: `_wizard_step_8.eta`, `wizard-steps.ts` `parseStep8`,
  `question_drafts` schema — **no migration needed** (`payload` is JSONB).

### Step 9 — Review and publish

- Kill the `<dl>`. Replace with **paper-preview card** (pupil view) + **answer-key card** (model answer + mark points + misconceptions) side by side.
- Below: **publish-readiness checklist** — green ticks for satisfied rows, red
  for missing, each linking back to its owning step.
- Publish button in the sticky action bar, 2-second confirm-hold.
- Confirm dialog summarises "what happens next": creates a draft-approval
  question, not visible to pupils until approved on the question page.
- Touch-points: `_wizard_step_9.eta`, `_wizard_preview.eta` extended to render
  answer-key card.

---

## 8. Cross-cutting behaviours (chunk 2.5q)

### 8.1 Autosave

- New route: `POST /admin/questions/wizard/:draftId/step/:n/autosave`. Same
  parser path as the advance POST, but returns `204 No Content` and does **not**
  advance `current_step`.
- Triggers: `blur` on any input; 5 s of idle typing; `input` on chip
  check/uncheck toggles.
- Client: `src/static/wizard_autosave.js`. Debounced. Queues on offline,
  retries with exponential backoff on `online` event.
- Chip states: `Saved Xs ago` (green dot) / `Saving…` (spinner) / `Offline — will retry` (amber) / `Save failed (click to retry)` (red).
- Audit: a new `question.draft.autosaved` event is **not** emitted (would
  spam the audit log). Advance events remain as they are.

### 8.2 Keyboard shortcuts

Global, wizard-scoped:

- `⌘/Ctrl + Enter` — save and continue
- `⌘/Ctrl + S` — save in place
- `[` / `]` — prev / next step
- `/` — focus nearest search / combobox
- `?` — open shortcut-help dialog
- `.` — focus first erroring field
- `Esc` — back to drafts list (with unsaved-changes guard)

Drafts list:

- `N` — start new draft
- `F` — focus filter search
- `J` / `K` — move selection down / up
- `Enter` — resume selected

Implementation: `src/static/wizard_shortcuts.js` + `src/static/drafts_shortcuts.js`. Shortcut-help dialog is a single `<dialog>` populated from a shared JSON table so the help and the bindings can't drift.

### 8.3 Undo

The step-advance JSONB patch is already stored in the draft's payload history.
Expose "Revert last change" in the action bar for 10 s after each save. Click
re-POSTs the prior payload. No schema change required (the data is there).

### 8.4 Focus management

- On step change: focus the first input.
- On validation error: focus the first erroring field, announce via
  `role="alert"` on the live region.
- On publish: focus the confirm dialog's primary button.

### 8.5 Motion

- 120 ms ease on step transitions.
- 200 ms cross-fade on live-preview updates.
- `@media (prefers-reduced-motion: reduce)` — all transitions 0 ms.

### 8.6 Copy

Pass through every template and replace functional strings with one human
voice. Representative changes:

- "Save review notes" → "Looks good — next step"
- "Not ready to publish" → "Almost there — 2 things to finish first"
- "Step 1 of 9" → "Step 1 of 9 · Home for the question"
- Add a small encouragement on step completion: "Nice. Step 5 of 9."

Full copy diff lives in chunk 2.5t.

---

## 9. Accessibility (non-negotiable — chunk 2.5t)

- Every chip / tile stays a real `<label>` wrapping a real
  `<input type="radio"/checkbox">`.
- Step rail: `<nav aria-label="Wizard steps">` + `<ol>` + `aria-current="step"`.
- Sticky action bar autosave chip: `aria-live="polite"`.
- Every colour use has a non-colour cue (icon + label + position).
- Full keyboard path end-to-end; tab order matches visual order.
- axe-core run over all 9 wizard steps + drafts list — extend the existing
  `npm run check` axe pass (today 7 pages; add 10).
- Contrast ratios verified at ≥ AA in both light and dark themes.

---

## 10. Feature flag & rollout strategy

- New chrome flag: `WIZARD_V2_ENABLED` (boolean). Defaults to **false**.
  Exposed via `process.env.WIZARD_V2_ENABLED === '1'` in dev; in production a
  row in `app_settings` (existing table).
- While flag is off:
  - The existing wizard at `/admin/questions/wizard/*` is unchanged.
  - New templates live under `src/templates/v2/` and `src/static/v2/` so
    they can be iterated without risk of accidental inclusion.
  - Tests for v2 live under `tests/http/wizard-v2/` and `tests/unit/wizard-v2/`.
- Route-level branch: in `src/routes/admin-question-wizard.ts`, the single
  entry handler checks the flag and renders either `admin_wizard_step.eta` or
  `v2/admin_wizard_step.eta`. Autosave and widget-swap endpoints are new and
  live behind the flag.
- Flag flips on **after** chunk 2.5t lands, the full axe pass is green, and
  the user has walked through the wizard end-to-end on the Gentoo dev box at
  least once. That's the formal sign-off moment; it gets its own revision row.

---

## 11. Chunk breakdown

Each chunk is self-contained: ships with tests, regenerates
`docs/widgets.schema.json` if relevant, and appends a revision row to
PHASE2.5_PLAN.md. The v1 wizard keeps working throughout.

### Chunk 2.5n — Visual tokens + dark mode

- Add warm-amber ramp, display type scale, motion tokens to `design-tokens.css`.
- Add `[data-theme="dark"]` override block.
- Self-host Source Serif 4 Variable; wire via `_chrome.eta`.
- Extend "Appearance" block: font × theme, persisted via existing user-prefs path.
- New primitives: `.chip`, `.icon`, `.progress-ring`, `.kbd`, `.status-dot`.
- **No HTML structural changes.** Existing pages should look subtly upgraded
  (new font for H1, slightly larger type), not reorganised.
- Tests: token-presence unit test, theme-toggle integration test, a11y
  contrast spot-check.

### Chunk 2.5o — Drafts list redesign (v2 only)

- `src/templates/v2/admin_drafts_list.eta` + body partial.
- Card grid, hero CTA with `<kbd>N</kbd>`, tab switcher, filter row, empty
  state, staleness chip.
- New `src/static/v2/drafts_filter.js` + `drafts_shortcuts.js`.
- Tests: render under flag = on vs off, filter query round-trip, empty state
  renders CTA, keyboard shortcuts fire the expected actions.

### Chunk 2.5p — 3-pane shell + rail + action bar + live preview on 5–8

- `src/templates/v2/admin_wizard_step.eta` + `_admin_wizard_step_body.eta`.
- Replace pill strip with `.wizard__rail`.
- `.wizard__actions` sticky bar component.
- Lift `_wizard_preview.eta` out of step 9 and mount on steps 5–8.
- New preview-pane slide-in behaviour below 1024 px.
- Tests: shell renders with rail + preview pane on steps 5–9, collapse
  behaviour at narrow viewports, keyboard tab order.

### Chunk 2.5q — Autosave + keyboard shortcuts + undo

- New route: `POST /admin/questions/wizard/:draftId/step/:n/autosave`
  (returns 204, reuses step parser, does not advance).
- `src/static/v2/wizard_autosave.js` with offline queue.
- `src/static/v2/wizard_shortcuts.js` + shortcut-help `<dialog>`.
- 10-second revert-last-change affordance in the action bar.
- Tests: autosave endpoint CSRF + owner auth + no-advance; autosave chip
  states; shortcut dispatch; revert restores prior payload.

### Chunk 2.5r — Steps 1–3 per-step upgrades

- Step 1 cascading combobox.
- Step 2 command-word chip grid with widget-preview link-through.
- Step 3 widget tiles with thumbnails, tariff, authoring-time, recent-widgets
  promotion.
- New `src/static/widget_thumbs/*.svg` (one per widget type).
- Registry: add `thumbUrl` property to `WidgetRegistration`; regenerate
  `docs/widgets.schema.json`.
- Tests: combobox narrows correctly; chip-grid selection round-trips through
  `parseStep2`; tile thumbnails are referenced; recent-widgets sort is stable.

### Chunk 2.5s — Steps 4–9 per-step upgrades

- Step 4 writing canvas + quick-insert row + silent preview card.
- Step 5 slash-menu widget-swap + per-field inline errors + "Use this example"
  buttons on every editor.
- Step 6 mark-point chip list with drag-reorder + alt pipe-chips.
- Step 7 misconception examples table.
- Step 8 difficulty slider + `expected_time_seconds` field.
- Step 9 paper-preview + answer-key cards + publish-readiness checklist +
  confirm dialog.
- Tests: widget-swap preserves payload snapshot; inline errors appear under
  the right field; drag-reorder persists through save; step-8 time field
  round-trips; step-9 confirm dialog blocks publish until fired.

### Chunk 2.5t — Motion, copy, a11y pass, flag flip

- Copy diff applied across all 9 step templates, drafts list, preview pane,
  action bar.
- Motion tokens wired into every transition.
- `prefers-reduced-motion` override verified.
- axe-core pass added for all 9 wizard steps + drafts list.
- Full manual keyboard walkthrough.
- **Flag flips on.** `WIZARD_V2_ENABLED` defaults true in dev; production flag
  row added.
- PHASE2.5_PLAN.md revision row: "Chunk 2.5t shipped — wizard v2 flag on."

---

## 12. File touch-point summary

Files expected to change or be added by chunk. Exhaustive list; tracking aid.

**2.5n**

- `src/static/design-tokens.css` (additions + dark block)
- `src/static/site.css` (new primitives only; no existing-class edits)
- `src/static/fonts/source-serif-4-*.woff2` (new)
- `src/templates/_chrome.eta` (font @face + theme toggle)
- `src/services/user_preferences.ts` (add theme to preferences)
- `tests/unit/design-tokens.test.ts` (new)
- `tests/http/chrome-theme.test.ts` (new)

**2.5o**

- `src/templates/v2/admin_drafts_list.eta` + body (new)
- `src/static/v2/drafts_filter.js` (new)
- `src/static/v2/drafts_shortcuts.js` (new)
- `src/routes/admin-question-wizard.ts` (v2 branch on drafts list route)
- `tests/http/wizard-v2/drafts-list.test.ts` (new)

**2.5p**

- `src/templates/v2/admin_wizard_step.eta` + body (new)
- `src/templates/v2/_wizard_rail.eta` (new)
- `src/templates/v2/_wizard_actions.eta` (new)
- `src/templates/v2/_wizard_context_banner.eta` (new)
- `src/templates/v2/_wizard_preview.eta` (lifted + extended)
- `src/static/v2/wizard_shell.js` (new — collapse behaviours)
- `src/routes/admin-question-wizard.ts` (v2 branch on step routes)
- `tests/http/wizard-v2/shell.test.ts` (new)

**2.5q**

- `src/routes/admin-question-wizard.ts` (new autosave endpoint)
- `src/services/question_drafts.ts` (new `autosave(step, patch)` method)
- `src/repos/question_drafts.ts` (reuse `update`)
- `src/static/v2/wizard_autosave.js` (new)
- `src/static/v2/wizard_shortcuts.js` (new)
- `src/static/v2/wizard_revert.js` (new)
- `src/templates/v2/_wizard_shortcut_help_dialog.eta` (new)
- `tests/http/wizard-v2/autosave.test.ts` (new)
- `tests/http/wizard-v2/shortcuts.test.ts` (new)

**2.5r**

- `src/templates/v2/_wizard_step_1.eta` (new)
- `src/templates/v2/_wizard_step_2.eta` (new)
- `src/templates/v2/_wizard_step_3.eta` (new)
- `src/static/v2/wizard_curriculum_combobox.js` (new)
- `src/static/v2/wizard_command_word_grid.js` (new)
- `src/static/widget_thumbs/*.svg` (one per widget, new)
- `src/lib/widgets.ts` (add `thumbUrl` to registration; regen schema)
- `docs/widgets.schema.json` (regen)
- `src/repos/questions.ts` (new `recentWidgetsByAuthor` read)
- `tests/http/wizard-v2/step-1-3.test.ts` (new)
- `tests/unit/widgets-thumbs.test.ts` (new)

**2.5s**

- `src/templates/v2/_wizard_step_4.eta` through `_wizard_step_9.eta` (new or
  updated)
- All `src/templates/v2/_wizard_step_5_<widget>.eta` partials (new)
- `src/static/v2/wizard_stem_editor.js` (new)
- `src/static/v2/wizard_widget_swap.js` (new)
- `src/static/v2/wizard_inline_errors.js` (new)
- `src/static/v2/wizard_mark_points.js` (new)
- `src/static/v2/wizard_difficulty_slider.js` (new)
- `src/static/v2/wizard_publish_confirm.js` (new)
- `src/lib/misconception-examples.ts` (new table)
- `src/lib/wizard-steps.ts` (extend `parseStep8` for `expected_time_seconds`)
- `src/lib/wizard-widget-editors.ts` (no change — parsers are shared)
- `tests/http/wizard-v2/step-4-9.test.ts` (new)

**2.5t**

- Copy diff across every `src/templates/v2/*.eta`
- Motion classes applied across CSS
- `src/static/v2/*` all respect `prefers-reduced-motion`
- `tests/http/wizard-v2/axe.test.ts` (new; covers 9 steps + drafts list)
- `src/config/feature-flags.ts` (flip `WIZARD_V2_ENABLED` default to true)
- PHASE2.5_PLAN.md revision row

---

## 13. Testing strategy

- **Unit tests** for every new parser, token presence, widget thumb path,
  misconception-example lookup.
- **HTTP integration tests** for every new route (autosave, shortcuts), every
  rendered template under both flag states until 2.5t, every wizard step's
  happy path + validation error path.
- **Contract tests**: v1 and v2 wizards must produce byte-identical
  `question_drafts.payload` JSONB for the same user inputs — the redesign is
  presentation-only. A shared fixtures table drives both.
- **axe-core**: 10 pages added to the existing check (9 steps + drafts list).
- **Manual walkthrough** at the end of 2.5t before the flag flip: Thursday
  persona scenario (20-minute stop-and-resume) + Sunday persona scenario
  (batch-author three questions, one with publish-ready checklist failures).

---

## 14. Risks and mitigations

| Risk                                        | Mitigation                                                                                                                                                                                                     |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v2 templates drift from v1 parsing contract | Contract tests (§13) ensure byte-identical payload JSONB.                                                                                                                                                      |
| Autosave clobbers concurrent tab edits      | `question_drafts.updated_at` used as optimistic-lock token; autosave POST fails with 409 on mismatch; client shows "Someone else edited this — reload". (Single-teacher-per-draft is the norm, but defensive.) |
| Dark-mode contrast regressions              | axe-core + manual 10-page spot check in both themes during 2.5t.                                                                                                                                               |
| New font face adds 50 KB                    | Subsetted to Latin; `font-display: swap`; loaded from same origin. One-off cost; cached after first visit.                                                                                                     |
| 7 chunks is too many                        | Each chunk is independently useful on v2 templates; worst case we stop at 2.5p (shell only) and still have a nicer wizard. Flag stays off until 2.5t signals done.                                             |
| "Old wizard still there" confusion          | The v2 trees (`templates/v2/`, `static/v2/`) are isolated; route-level flag makes which-is-which unambiguous in dev.                                                                                           |

---

## 15. Open questions (for you to sign off after reading)

1. Is **Source Serif 4** acceptable, or would you rather evaluate Literata or
   Fraunces before chunk 2.5n lands?
2. Is **amber** (`#c2892a`) the right warm-secondary hue, or would you like to
   see ochre (`#b08527`) or muted coral (`#c67a63`) mocked up first?
3. **expected_time_seconds** in step 8 — is today the right time to expose it,
   or should the field wait until the pupil paper actually renders it
   prominently?
4. **Concurrent-edit guard** — do we actually need it, or is single-teacher-per-draft a safe assumption to skip the 409 path?
5. **Production flag row** — happy to land it as a migration
   (`0026_app_settings_wizard_v2.sql`), or would you rather keep flags in code
   until there are more of them?

Once signed off, default next step is **chunk 2.5n** (visual tokens + dark
mode), which is the lowest-risk unblock for everything else.

---

## Appendix — Revision history

| Date       | Author | Change                                                                                                                                                                                                                                                                                                                                 |
| ---------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-04-19 | TD     | First draft. Six decisions captured (serif display face, amber secondary, dark mode in scope, split-pane preview from step 5, loud autosave, 7 chunks with flag gate). 7 chunks scoped 2.5n–2.5t, each independently shippable behind `WIZARD_V2_ENABLED`. No schema changes; `expected_time_seconds` lives in existing JSONB payload. |
