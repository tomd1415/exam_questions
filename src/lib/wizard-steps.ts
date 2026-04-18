// Per-step form parsers for the teacher question-creation wizard. Each
// `parseStepN(body, currentPayload)` returns a `StepParseResult` — either a
// `patch` the service should merge into the draft payload, or a list of
// issues the template can re-display against individual fields.
//
// Parsers take the current payload because some steps build on earlier ones:
// step 3 needs to seed `parts[0]` with the right widget shell (and reset
// part_config if the teacher swapped widgets), step 5 mirrors `stem` into
// `parts[0].prompt` for the single-part case, step 6 rewrites marks and
// mark_points on `parts[0]`.
//
// Validation here is deliberately lenient compared to QuestionService: the
// wizard *accepts* an incomplete draft at each step, and the publish gate
// (src/services/question_drafts.ts payloadToDraft + QuestionService.createDraft)
// is the authoritative final check. What we do reject here is garbage that
// cannot survive later steps at all — an unknown topic_code on step 1, a
// command word not in the seed, a widget type outside the registry.
//
// The COMMAND_WORD_WIDGETS map is what keeps the widget picker helpful: when
// a teacher picks "complete" on step 2, step 3 nudges them toward trace_table,
// cloze_free/code, algorithm — not matrix_tick_multi or multiple_choice. The
// map is a recommendation, not a hard constraint: "Other widgets" remains
// selectable from a <details> for the edge cases OCR has not envisaged.

import type { QuestionDraftPayload } from '../repos/question_drafts.js';
import type { PartDraft, MarkPointDraft, MisconceptionDraft } from './question-invariants.js';
import { SOURCE_TYPES, type SourceType } from './question-invariants.js';
import { getWidget, registeredWidgetTypes } from './widgets.js';

export interface StepIssue {
  path: string;
  message: string;
}

export type StepParseResult =
  | { ok: true; patch: QuestionDraftPayload }
  | { ok: false; issues: StepIssue[] };

export interface StepParseContext {
  currentPayload: QuestionDraftPayload;
  // Curriculum reference used by step 1 + 2. Passed in so the parser
  // stays pure and unit-testable without a DB pool.
  components: readonly string[];
  topicComponent: ReadonlyMap<string, string>;
  subtopicTopic: ReadonlyMap<string, string>;
  commandWords: ReadonlySet<string>;
  archetypes: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Command-word → recommended widgets
// ---------------------------------------------------------------------------

// Built from the OCR command-word table (§3d of the J277 spec) plus the
// widget roster in src/lib/widgets.ts. The rule of thumb: widgets that
// naturally fit the command word's expected_response_shape go in the
// recommended list. Widgets a teacher *could* still reach for are
// available under "Other widgets" on the picker.
//
// Tests guard the two shapes that matter most to day-one UX:
//   * "write" / "write_rewrite" must not surface matrix_tick_single or
//     cloze_with_bank (those would invite multiple-choice-style answers
//     for an open-ended write-an-algorithm question).
//   * "complete" must recommend trace_table (completing a trace table is
//     the commonest use of this command word in J277/02).
export const COMMAND_WORD_WIDGETS: Readonly<Record<string, readonly string[]>> = {
  add: ['short_text'],
  analyse: ['medium_text', 'extended_response'],
  annotate: ['diagram_labels'],
  calculate: ['short_text'],
  compare: ['medium_text', 'extended_response', 'matrix_tick_single'],
  complete: ['trace_table', 'cloze_free', 'cloze_code', 'cloze_with_bank', 'algorithm'],
  convert: ['short_text'],
  define: ['short_text', 'medium_text'],
  describe: ['medium_text', 'extended_response'],
  design: ['code', 'algorithm', 'flowchart', 'extended_response'],
  discuss: ['extended_response', 'medium_text'],
  draw: ['logic_diagram', 'flowchart', 'diagram_labels'],
  evaluate: ['extended_response', 'medium_text'],
  explain: ['medium_text', 'extended_response'],
  give: ['short_text', 'multiple_choice', 'tick_box'],
  how: ['medium_text', 'extended_response'],
  identify: ['multiple_choice', 'tick_box', 'short_text', 'matching'],
  justify: ['medium_text', 'extended_response'],
  label: ['diagram_labels', 'matching'],
  list: ['short_text', 'medium_text', 'tick_box'],
  order: ['matching', 'short_text'],
  outline: ['medium_text'],
  refine: ['code', 'algorithm'],
  show: ['short_text', 'algorithm'],
  solve: ['short_text', 'algorithm'],
  state: ['short_text', 'multiple_choice'],
  tick: ['tick_box', 'matrix_tick_single', 'matrix_tick_multi'],
  what: ['short_text'],
  write_rewrite: ['code', 'algorithm', 'medium_text', 'extended_response'],
};

export interface WidgetChoiceGroups {
  recommended: readonly string[];
  other: readonly string[];
}

export function widgetChoicesFor(commandWordCode: string | null | undefined): WidgetChoiceGroups {
  const all = registeredWidgetTypes();
  const recommended = commandWordCode ? (COMMAND_WORD_WIDGETS[commandWordCode] ?? []) : [];
  const recSet = new Set(recommended);
  const other = all.filter((t) => !recSet.has(t));
  return { recommended, other };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function trimmed(v: unknown): string {
  return str(v).trim();
}

function parseIntInRange(v: unknown, min: number, max: number): number | null {
  const raw = typeof v === 'string' ? Number.parseInt(v, 10) : typeof v === 'number' ? v : NaN;
  if (!Number.isInteger(raw)) return null;
  if (raw < min || raw > max) return null;
  return raw;
}

function ensurePart(currentPayload: QuestionDraftPayload): PartDraft {
  const existing = currentPayload.parts?.[0];
  if (existing) return existing;
  return {
    part_label: '(a)',
    prompt: '',
    marks: 1,
    expected_response_type: 'short_text',
    part_config: null,
    mark_points: [],
    misconceptions: [],
  };
}

// ---------------------------------------------------------------------------
// Step 1 — where the question lives (component / topic / subtopic)
// ---------------------------------------------------------------------------

export function parseStep1(body: unknown, ctx: StepParseContext): StepParseResult {
  const record = (body ?? {}) as Record<string, unknown>;
  const component_code = trimmed(record['component_code']);
  const topic_code = trimmed(record['topic_code']);
  const subtopic_code = trimmed(record['subtopic_code']);
  const issues: StepIssue[] = [];

  if (component_code.length === 0)
    issues.push({ path: 'component_code', message: 'Pick a component.' });
  else if (!ctx.components.includes(component_code))
    issues.push({ path: 'component_code', message: `Unknown component '${component_code}'.` });

  if (topic_code.length === 0) issues.push({ path: 'topic_code', message: 'Pick a topic.' });
  else {
    const tc = ctx.topicComponent.get(topic_code);
    if (tc === undefined)
      issues.push({ path: 'topic_code', message: `Unknown topic '${topic_code}'.` });
    else if (tc !== component_code)
      issues.push({
        path: 'topic_code',
        message: `Topic '${topic_code}' belongs to component '${tc}', not '${component_code}'.`,
      });
  }

  if (subtopic_code.length === 0)
    issues.push({ path: 'subtopic_code', message: 'Pick a subtopic.' });
  else {
    const st = ctx.subtopicTopic.get(subtopic_code);
    if (st === undefined)
      issues.push({ path: 'subtopic_code', message: `Unknown subtopic '${subtopic_code}'.` });
    else if (st !== topic_code)
      issues.push({
        path: 'subtopic_code',
        message: `Subtopic '${subtopic_code}' belongs to topic '${st}', not '${topic_code}'.`,
      });
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    patch: { component_code, topic_code, subtopic_code },
  };
}

// ---------------------------------------------------------------------------
// Step 2 — command word + archetype
// ---------------------------------------------------------------------------

export function parseStep2(body: unknown, ctx: StepParseContext): StepParseResult {
  const record = (body ?? {}) as Record<string, unknown>;
  const command_word_code = trimmed(record['command_word_code']);
  const archetype_code = trimmed(record['archetype_code']);
  const issues: StepIssue[] = [];

  if (command_word_code.length === 0)
    issues.push({ path: 'command_word_code', message: 'Pick a command word.' });
  else if (!ctx.commandWords.has(command_word_code))
    issues.push({
      path: 'command_word_code',
      message: `Unknown command word '${command_word_code}'.`,
    });

  if (archetype_code.length === 0)
    issues.push({ path: 'archetype_code', message: 'Pick a question archetype.' });
  else if (!ctx.archetypes.has(archetype_code))
    issues.push({ path: 'archetype_code', message: `Unknown archetype '${archetype_code}'.` });

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, patch: { command_word_code, archetype_code } };
}

// ---------------------------------------------------------------------------
// Step 3 — widget picker
// ---------------------------------------------------------------------------

export function parseStep3(body: unknown, ctx: StepParseContext): StepParseResult {
  const record = (body ?? {}) as Record<string, unknown>;
  const widget = trimmed(record['expected_response_type']);
  const issues: StepIssue[] = [];

  if (widget.length === 0)
    issues.push({ path: 'expected_response_type', message: 'Pick a widget.' });
  else {
    const reg = getWidget(widget);
    if (!reg)
      issues.push({
        path: 'expected_response_type',
        message: `Unknown widget type '${widget}'.`,
      });
  }

  if (issues.length > 0) return { ok: false, issues };

  const reg = getWidget(widget)!;
  const existingPart = ctx.currentPayload.parts?.[0];
  // If the teacher swapped widgets, we reset part_config to the new widget's
  // example — holding on to the old config would leave the draft in a shape
  // that won't validate under the new widget.
  const widgetChanged = existingPart?.expected_response_type !== widget;
  const base = ensurePart(ctx.currentPayload);
  const part: PartDraft = {
    ...base,
    expected_response_type: widget,
    part_config: widgetChanged ? (reg.exampleConfig ?? null) : (base.part_config ?? null),
  };
  return {
    ok: true,
    patch: {
      expected_response_type: widget,
      parts: [part],
    },
  };
}

// ---------------------------------------------------------------------------
// Step 4 — widget-specific editor (placeholder; per-widget editors land next)
// ---------------------------------------------------------------------------

export function parseStep4(_body: unknown, _ctx: StepParseContext): StepParseResult {
  // Per-widget editors ship in the next sequencing chunk. Until then the
  // page just advances; part_config was seeded on step 3 from the widget
  // registry's exampleConfig, so the draft stays publishable for widgets
  // where the example is a reasonable starting point.
  return { ok: true, patch: {} };
}

// ---------------------------------------------------------------------------
// Step 5 — stem
// ---------------------------------------------------------------------------

const MAX_STEM_LENGTH = 4000;

export function parseStep5(body: unknown, ctx: StepParseContext): StepParseResult {
  const record = (body ?? {}) as Record<string, unknown>;
  const stem = trimmed(record['stem']);
  const issues: StepIssue[] = [];

  if (stem.length === 0) issues.push({ path: 'stem', message: 'The stem is required.' });
  else if (stem.length > MAX_STEM_LENGTH)
    issues.push({ path: 'stem', message: `The stem must be ≤${MAX_STEM_LENGTH} characters.` });

  if (issues.length > 0) return { ok: false, issues };

  const base = ensurePart(ctx.currentPayload);
  // Single-part wizard: mirror the stem into parts[0].prompt so the invariant
  // validator (which requires a non-empty prompt per part) is satisfied.
  const part: PartDraft = { ...base, prompt: stem };
  return { ok: true, patch: { stem, parts: [part] } };
}

// ---------------------------------------------------------------------------
// Step 6 — marks, model answer, mark points
// ---------------------------------------------------------------------------

const MAX_MODEL_ANSWER_LENGTH = 4000;
const MAX_MARK_POINT_TEXT = 1000;

export function parseStep6(body: unknown, ctx: StepParseContext): StepParseResult {
  const record = (body ?? {}) as Record<string, unknown>;
  const marks = parseIntInRange(record['marks'], 1, 60);
  const model_answer = trimmed(record['model_answer']);
  const markPointsBlock = str(record['mark_points']);
  const issues: StepIssue[] = [];

  if (marks === null)
    issues.push({ path: 'marks', message: 'Marks must be an integer between 1 and 60.' });

  if (model_answer.length === 0)
    issues.push({ path: 'model_answer', message: 'The model answer is required.' });
  else if (model_answer.length > MAX_MODEL_ANSWER_LENGTH)
    issues.push({
      path: 'model_answer',
      message: `The model answer must be ≤${MAX_MODEL_ANSWER_LENGTH} characters.`,
    });

  const mark_points: MarkPointDraft[] = [];
  const lines = markPointsBlock
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0)
    issues.push({
      path: 'mark_points',
      message: 'List at least one mark point, one per line.',
    });
  for (const line of lines) {
    if (line.length > MAX_MARK_POINT_TEXT) {
      issues.push({
        path: 'mark_points',
        message: `Each mark point must be ≤${MAX_MARK_POINT_TEXT} characters.`,
      });
      continue;
    }
    mark_points.push({
      text: line,
      accepted_alternatives: [],
      marks: 1,
      is_required: false,
    });
  }

  if (issues.length > 0) return { ok: false, issues };

  const base = ensurePart(ctx.currentPayload);
  const part: PartDraft = {
    ...base,
    marks: marks!,
    mark_points,
  };
  return { ok: true, patch: { model_answer, parts: [part] } };
}

// ---------------------------------------------------------------------------
// Step 7 — misconceptions (optional)
// ---------------------------------------------------------------------------

const MISCONCEPTION_LINE = /^([^:]+):\s*(.+)$/;

export function parseStep7(body: unknown, ctx: StepParseContext): StepParseResult {
  const record = (body ?? {}) as Record<string, unknown>;
  const block = str(record['misconceptions']);
  const issues: StepIssue[] = [];
  const misconceptions: MisconceptionDraft[] = [];

  const lines = block
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = MISCONCEPTION_LINE.exec(line);
    if (!m) {
      issues.push({
        path: `misconceptions.${i}`,
        message: `Line ${i + 1}: use the format "label : description".`,
      });
      continue;
    }
    misconceptions.push({ label: m[1]!.trim(), description: m[2]!.trim() });
  }

  if (issues.length > 0) return { ok: false, issues };

  const base = ensurePart(ctx.currentPayload);
  const part: PartDraft = { ...base, misconceptions };
  return { ok: true, patch: { parts: [part] } };
}

// ---------------------------------------------------------------------------
// Step 8 — difficulty and source
// ---------------------------------------------------------------------------

export function parseStep8(body: unknown, _ctx: StepParseContext): StepParseResult {
  const record = (body ?? {}) as Record<string, unknown>;
  const difficulty_band = parseIntInRange(record['difficulty_band'], 1, 9);
  const difficulty_step = parseIntInRange(record['difficulty_step'], 1, 3);
  const sourceTypeRaw = trimmed(record['source_type']);
  const issues: StepIssue[] = [];

  if (difficulty_band === null)
    issues.push({
      path: 'difficulty_band',
      message: 'Pick a difficulty band between 1 and 9.',
    });
  if (difficulty_step === null)
    issues.push({
      path: 'difficulty_step',
      message: 'Pick a difficulty step between 1 and 3.',
    });

  const source_type: SourceType = (SOURCE_TYPES as readonly string[]).includes(sourceTypeRaw)
    ? (sourceTypeRaw as SourceType)
    : 'teacher';

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    patch: {
      difficulty_band: difficulty_band!,
      difficulty_step: difficulty_step!,
      source_type,
    },
  };
}

// ---------------------------------------------------------------------------
// Step 9 — review (no form fields; the POST is the publish call)
// ---------------------------------------------------------------------------

const MAX_REVIEW_NOTES = 2000;

export function parseStep9(body: unknown, _ctx: StepParseContext): StepParseResult {
  const record = (body ?? {}) as Record<string, unknown>;
  const raw = trimmed(record['review_notes']);
  if (raw.length > MAX_REVIEW_NOTES) {
    return {
      ok: false,
      issues: [
        {
          path: 'review_notes',
          message: `Review notes must be ≤${MAX_REVIEW_NOTES} characters.`,
        },
      ],
    };
  }
  return { ok: true, patch: { review_notes: raw.length > 0 ? raw : null } };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const PARSERS = [
  parseStep1,
  parseStep2,
  parseStep3,
  parseStep4,
  parseStep5,
  parseStep6,
  parseStep7,
  parseStep8,
  parseStep9,
] as const;

export function parseWizardStep(
  step: number,
  body: unknown,
  ctx: StepParseContext,
): StepParseResult {
  if (!Number.isInteger(step) || step < 1 || step > 9) {
    return { ok: false, issues: [{ path: '_', message: `Unknown wizard step '${step}'.` }] };
  }
  return PARSERS[step - 1]!(body, ctx);
}
