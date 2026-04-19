// Pure validation for a question draft. No DB access, no IO. Both the
// write routes (for rendering per-field errors before re-displaying the
// form) and the QuestionService (as the last gate before the transaction)
// call this. Keeping it pure is what makes
// `tests/unit/question-invariants.test.ts` fast and DB-free.

export type SourceType = 'teacher' | 'imported_pattern' | 'ai_generated';

export const SOURCE_TYPES: readonly SourceType[] = [
  'teacher',
  'imported_pattern',
  'ai_generated',
] as const;

// These are the response types the Phase 1 marking service (Chunk 4) will
// recognise. The DB column is free-form TEXT, but we only accept these at
// the application layer so the mark-time switch stays exhaustive.
export const EXPECTED_RESPONSE_TYPES: readonly string[] = [
  'multiple_choice',
  'tick_box',
  'short_text',
  'medium_text',
  'extended_response',
  'code',
  'algorithm',
  'trace_table',
  'matrix_tick_single',
  'matrix_tick_multi',
  'cloze_free',
  'cloze_with_bank',
  'cloze_code',
  'matching',
  'logic_diagram',
  'diagram_labels',
  'flowchart',
] as const;

export interface MarkPointDraft {
  text: string;
  accepted_alternatives: string[];
  marks: number;
  is_required: boolean;
}

export interface MisconceptionDraft {
  label: string;
  description: string;
}

export interface PartDraft {
  part_label: string;
  prompt: string;
  marks: number;
  expected_response_type: string;
  // Widget-specific configuration. NULL/undefined for widgets that need
  // none (true for every type as of Phase 2.5a-i). The widget registry
  // (src/lib/widgets.ts) owns shape validation; this interface only
  // carries the value through to the repos so it can be persisted on
  // question_parts.part_config (JSONB).
  part_config?: unknown;
  mark_points: MarkPointDraft[];
  misconceptions: MisconceptionDraft[];
}

export interface QuestionDraft {
  component_code: string;
  topic_code: string;
  subtopic_code: string;
  command_word_code: string;
  archetype_code: string;
  stem: string;
  expected_response_type: string;
  model_answer: string;
  feedback_template: string | null;
  difficulty_band: number;
  difficulty_step: number;
  source_type: SourceType;
  review_notes: string | null;
  parts: PartDraft[];
}

export interface QuestionDraftReferenceData {
  commandWords: ReadonlySet<string>;
  archetypes: ReadonlySet<string>;
  components: ReadonlySet<string>;
  topicComponent: ReadonlyMap<string, string>;
  subtopicTopic: ReadonlyMap<string, string>;
}

export interface InvariantIssue {
  path: string;
  message: string;
}

export interface NormalisedQuestionDraft extends QuestionDraft {
  marks_total: number;
}

export type ValidationResult =
  | { ok: true; value: NormalisedQuestionDraft }
  | { ok: false; issues: InvariantIssue[] };

const MAX_STEM_LENGTH = 4000;
const MAX_MODEL_ANSWER_LENGTH = 4000;
const MAX_PROMPT_LENGTH = 2000;
const MAX_MARK_POINT_TEXT = 1000;
const MAX_LABEL_LENGTH = 20;
const MAX_REVIEW_NOTES = 2000;

// ---------------------------------------------------------------------------
// Model-answer shape invariant (Chunk B1)
//
// Many widgets expect a structured pupil response — a matching pair, a
// cloze-gap map, a ticked row. When a teacher pastes prose into the model
// answer for one of those widgets, later pipeline steps (the paper-view
// dispatcher, the marking service, the teacher-review UI) have no way of
// comparing it to the pupil's submission. The result is the bug listed in
// my_notes.md §6 + §9.
//
// This invariant enforces the shape per response type. The deterministic
// widgets require the model answer to parse as JSON and to cover every
// slot defined by part_config; the teacher-review widgets accept any
// non-empty prose (since the teacher marks by eye). Shape checks are
// deliberately structural, not content — matching *which* pair is correct
// is a question-authoring concern, not an invariant.
// ---------------------------------------------------------------------------

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function asStringMap(v: unknown): Record<string, string> | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== 'string') return null;
    out[k] = val;
  }
  return out;
}

function readStringArray(cfg: unknown, key: string): string[] | null {
  if (cfg === null || typeof cfg !== 'object') return null;
  const v = (cfg as Record<string, unknown>)[key];
  if (!Array.isArray(v)) return null;
  if (!v.every((x): x is string => typeof x === 'string')) return null;
  return v;
}

function readGapIds(cfg: unknown): string[] | null {
  if (cfg === null || typeof cfg !== 'object') return null;
  const gaps = (cfg as Record<string, unknown>)['gaps'];
  if (!Array.isArray(gaps)) return null;
  const ids: string[] = [];
  for (const g of gaps) {
    if (g === null || typeof g !== 'object') return null;
    const id = (g as Record<string, unknown>)['id'];
    if (typeof id !== 'string') return null;
    ids.push(id);
  }
  return ids;
}

function readHotspotIds(cfg: unknown): string[] | null {
  if (cfg === null || typeof cfg !== 'object') return null;
  const hotspots = (cfg as Record<string, unknown>)['hotspots'];
  if (!Array.isArray(hotspots)) return null;
  const ids: string[] = [];
  for (const h of hotspots) {
    if (h === null || typeof h !== 'object') return null;
    const id = (h as Record<string, unknown>)['id'];
    if (typeof id !== 'string') return null;
    ids.push(id);
  }
  return ids;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  for (const x of b) if (!sa.has(x)) return false;
  return true;
}

export function validateModelAnswerShape(
  responseType: string,
  modelAnswer: string,
  partConfig: unknown,
): string[] {
  const text = modelAnswer.trim();
  if (text.length === 0) return [];

  switch (responseType) {
    case 'short_text':
    case 'medium_text':
    case 'extended_response':
    case 'code':
    case 'algorithm':
      return [];

    case 'multiple_choice': {
      const options = readStringArray(partConfig, 'options');
      if (options === null) return [];
      if (!options.includes(text)) {
        return [
          'Model answer for multiple_choice must equal one of part_config.options verbatim.',
        ];
      }
      return [];
    }

    case 'tick_box': {
      const parsed = tryParseJson(text);
      if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === 'string')) {
        return ['Model answer for tick_box must be a JSON array of option strings.'];
      }
      const options = readStringArray(partConfig, 'options');
      if (options !== null) {
        const bad = (parsed as string[]).filter((v) => !options.includes(v));
        if (bad.length > 0) {
          return [
            `Model answer for tick_box lists options not in part_config.options: ${bad.join(', ')}.`,
          ];
        }
      }
      return [];
    }

    case 'matching': {
      const parsed = tryParseJson(text);
      if (!Array.isArray(parsed)) {
        return ['Model answer for matching must be a JSON array of [leftIdx, rightIdx] pairs.'];
      }
      const ok = parsed.every(
        (p) =>
          Array.isArray(p) &&
          p.length === 2 &&
          typeof p[0] === 'number' &&
          typeof p[1] === 'number' &&
          Number.isInteger(p[0]) &&
          Number.isInteger(p[1]),
      );
      if (!ok) {
        return [
          'Model answer for matching: each entry must be a [leftIdx, rightIdx] pair of integers.',
        ];
      }
      return [];
    }

    case 'cloze_free':
    case 'cloze_with_bank':
    case 'cloze_code': {
      const parsed = tryParseJson(text);
      const map = asStringMap(parsed);
      if (map === null) {
        return ['Model answer for cloze must be a JSON object mapping gap id → string.'];
      }
      const gaps = readGapIds(partConfig);
      if (gaps !== null && !sameSet(Object.keys(map), gaps)) {
        return [
          `Model answer for cloze must have one entry per gap (ids: ${gaps.join(', ')}).`,
        ];
      }
      return [];
    }

    case 'matrix_tick_single': {
      const parsed = tryParseJson(text);
      const map = asStringMap(parsed);
      if (map === null) {
        return [
          'Model answer for matrix_tick_single must be a JSON object mapping row → column.',
        ];
      }
      const rows = readStringArray(partConfig, 'rows');
      if (rows !== null && !sameSet(Object.keys(map), rows)) {
        return [
          `Model answer for matrix_tick_single must have one entry per row (rows: ${rows.join(', ')}).`,
        ];
      }
      const columns = readStringArray(partConfig, 'columns');
      if (columns !== null) {
        const bad = Object.values(map).filter((v) => !columns.includes(v));
        if (bad.length > 0) {
          return [
            `Model answer for matrix_tick_single uses column(s) not in part_config.columns: ${bad.join(', ')}.`,
          ];
        }
      }
      return [];
    }

    case 'matrix_tick_multi': {
      const parsed = tryParseJson(text);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return [
          'Model answer for matrix_tick_multi must be a JSON object mapping row → [columns].',
        ];
      }
      const obj = parsed as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        if (!Array.isArray(v) || !v.every((c) => typeof c === 'string')) {
          return [
            `Model answer for matrix_tick_multi row '${k}' must be an array of column strings.`,
          ];
        }
      }
      const rows = readStringArray(partConfig, 'rows');
      if (rows !== null && !sameSet(Object.keys(obj), rows)) {
        return [
          `Model answer for matrix_tick_multi must have one entry per row (rows: ${rows.join(', ')}).`,
        ];
      }
      return [];
    }

    case 'trace_table': {
      const parsed = tryParseJson(text);
      const map = asStringMap(parsed);
      if (map === null) {
        return ['Model answer for trace_table must be a JSON object mapping "r,c" → value.'];
      }
      for (const k of Object.keys(map)) {
        if (!/^\d+,\d+$/.test(k)) {
          return [
            `Model answer for trace_table key '${k}' must match the "row,col" pattern.`,
          ];
        }
      }
      return [];
    }

    case 'diagram_labels': {
      const parsed = tryParseJson(text);
      const map = asStringMap(parsed);
      if (map === null) {
        return [
          'Model answer for diagram_labels must be a JSON object mapping hotspot id → label.',
        ];
      }
      const ids = readHotspotIds(partConfig);
      if (ids !== null && !sameSet(Object.keys(map), ids)) {
        return [
          `Model answer for diagram_labels must cover all hotspots (ids: ${ids.join(', ')}).`,
        ];
      }
      return [];
    }

    case 'logic_diagram':
    case 'flowchart':
      // Both widgets offer an image variant where the pupil's response is a
      // drawn PNG; and structured variants where per-blank answers could
      // live in a JSON map. For B1 we only require non-empty content — the
      // teacher-review queue marks by eye in either case. A variant-aware
      // shape check lives in the VISUAL_EDITORS_PLAN follow-up.
      return [];

    default:
      return [`Unknown response type '${responseType}' — cannot validate model answer shape.`];
  }
}

export function validateQuestionDraft(
  input: QuestionDraft,
  refs: QuestionDraftReferenceData,
): ValidationResult {
  const issues: InvariantIssue[] = [];

  const stem = input.stem.trim();
  if (stem.length === 0) issues.push({ path: 'stem', message: 'Stem is required.' });
  else if (stem.length > MAX_STEM_LENGTH)
    issues.push({ path: 'stem', message: `Stem must be ≤${MAX_STEM_LENGTH} characters.` });

  const modelAnswer = input.model_answer.trim();
  if (modelAnswer.length === 0)
    issues.push({ path: 'model_answer', message: 'Model answer is required.' });
  else if (modelAnswer.length > MAX_MODEL_ANSWER_LENGTH)
    issues.push({
      path: 'model_answer',
      message: `Model answer must be ≤${MAX_MODEL_ANSWER_LENGTH} characters.`,
    });
  else if (input.parts.length === 1 && input.parts[0]!.expected_response_type === input.expected_response_type) {
    // Only apply the shape invariant to single-part questions whose
    // part response type matches the question's. Multi-part or mixed-type
    // questions store one prose blob covering all parts, so a per-type
    // structural check would misfire.
    for (const m of validateModelAnswerShape(
      input.expected_response_type,
      modelAnswer,
      input.parts[0]!.part_config,
    )) {
      issues.push({ path: 'model_answer', message: m });
    }
  }

  if (!EXPECTED_RESPONSE_TYPES.includes(input.expected_response_type))
    issues.push({
      path: 'expected_response_type',
      message: `Unknown expected response type '${input.expected_response_type}'.`,
    });

  if (!refs.components.has(input.component_code))
    issues.push({
      path: 'component_code',
      message: `Unknown component '${input.component_code}'.`,
    });

  const topicComponent = refs.topicComponent.get(input.topic_code);
  if (topicComponent === undefined)
    issues.push({ path: 'topic_code', message: `Unknown topic '${input.topic_code}'.` });
  else if (topicComponent !== input.component_code)
    issues.push({
      path: 'topic_code',
      message: `Topic '${input.topic_code}' belongs to component '${topicComponent}', not '${input.component_code}'.`,
    });

  const subtopicTopic = refs.subtopicTopic.get(input.subtopic_code);
  if (subtopicTopic === undefined)
    issues.push({
      path: 'subtopic_code',
      message: `Unknown subtopic '${input.subtopic_code}'.`,
    });
  else if (subtopicTopic !== input.topic_code)
    issues.push({
      path: 'subtopic_code',
      message: `Subtopic '${input.subtopic_code}' belongs to topic '${subtopicTopic}', not '${input.topic_code}'.`,
    });

  if (!refs.commandWords.has(input.command_word_code))
    issues.push({
      path: 'command_word_code',
      message: `Unknown command word '${input.command_word_code}'.`,
    });

  if (!refs.archetypes.has(input.archetype_code))
    issues.push({
      path: 'archetype_code',
      message: `Unknown archetype '${input.archetype_code}'.`,
    });

  if (
    !Number.isInteger(input.difficulty_band) ||
    input.difficulty_band < 1 ||
    input.difficulty_band > 9
  )
    issues.push({
      path: 'difficulty_band',
      message: 'Difficulty band must be an integer in 1..9.',
    });

  if (
    !Number.isInteger(input.difficulty_step) ||
    input.difficulty_step < 1 ||
    input.difficulty_step > 3
  )
    issues.push({
      path: 'difficulty_step',
      message: 'Difficulty step must be an integer in 1..3.',
    });

  if (!SOURCE_TYPES.includes(input.source_type))
    issues.push({ path: 'source_type', message: `Unknown source type '${input.source_type}'.` });

  const reviewNotes = input.review_notes === null ? null : input.review_notes.trim();
  if (reviewNotes !== null && reviewNotes.length > MAX_REVIEW_NOTES)
    issues.push({
      path: 'review_notes',
      message: `Review notes must be ≤${MAX_REVIEW_NOTES} characters.`,
    });

  if (input.parts.length === 0) {
    issues.push({ path: 'parts', message: 'A question must have at least one part.' });
  }

  const seenLabels = new Map<string, number>();
  const normalisedParts: PartDraft[] = [];
  let marksTotal = 0;

  for (let i = 0; i < input.parts.length; i++) {
    const p = input.parts[i]!;
    const pathPrefix = `parts.${i}`;

    const label = p.part_label.trim();
    if (label.length === 0)
      issues.push({ path: `${pathPrefix}.part_label`, message: 'Part label is required.' });
    else if (label.length > MAX_LABEL_LENGTH)
      issues.push({
        path: `${pathPrefix}.part_label`,
        message: `Part label must be ≤${MAX_LABEL_LENGTH} characters.`,
      });
    else if (seenLabels.has(label))
      issues.push({
        path: `${pathPrefix}.part_label`,
        message: `Duplicate part label '${label}' (also used by part ${seenLabels.get(label)! + 1}).`,
      });
    else seenLabels.set(label, i);

    const prompt = p.prompt.trim();
    if (prompt.length === 0)
      issues.push({ path: `${pathPrefix}.prompt`, message: 'Prompt is required.' });
    else if (prompt.length > MAX_PROMPT_LENGTH)
      issues.push({
        path: `${pathPrefix}.prompt`,
        message: `Prompt must be ≤${MAX_PROMPT_LENGTH} characters.`,
      });

    if (!Number.isInteger(p.marks) || p.marks < 0)
      issues.push({
        path: `${pathPrefix}.marks`,
        message: 'Marks must be a non-negative integer.',
      });
    else marksTotal += p.marks;

    if (!EXPECTED_RESPONSE_TYPES.includes(p.expected_response_type))
      issues.push({
        path: `${pathPrefix}.expected_response_type`,
        message: `Unknown expected response type '${p.expected_response_type}'.`,
      });

    if (p.mark_points.length === 0)
      issues.push({
        path: `${pathPrefix}.mark_points`,
        message: 'Every part needs at least one mark point.',
      });

    const normalisedMarkPoints: MarkPointDraft[] = [];
    for (let j = 0; j < p.mark_points.length; j++) {
      const mp = p.mark_points[j]!;
      const mpPath = `${pathPrefix}.mark_points.${j}`;

      const text = mp.text.trim();
      if (text.length === 0)
        issues.push({ path: `${mpPath}.text`, message: 'Mark point text is required.' });
      else if (text.length > MAX_MARK_POINT_TEXT)
        issues.push({
          path: `${mpPath}.text`,
          message: `Mark point text must be ≤${MAX_MARK_POINT_TEXT} characters.`,
        });

      if (!Number.isInteger(mp.marks) || mp.marks < 0)
        issues.push({
          path: `${mpPath}.marks`,
          message: 'Mark point marks must be a non-negative integer.',
        });

      const alternatives: string[] = [];
      for (const alt of mp.accepted_alternatives) {
        const a = alt.trim();
        if (a.length > 0) alternatives.push(a);
      }

      normalisedMarkPoints.push({
        text,
        accepted_alternatives: alternatives,
        marks: Number.isInteger(mp.marks) ? mp.marks : 0,
        is_required: mp.is_required === true,
      });
    }

    const normalisedMisconceptions: MisconceptionDraft[] = [];
    for (let j = 0; j < p.misconceptions.length; j++) {
      const m = p.misconceptions[j]!;
      const mPath = `${pathPrefix}.misconceptions.${j}`;
      const label2 = m.label.trim();
      const description = m.description.trim();
      if (label2.length === 0 && description.length === 0) continue;
      if (label2.length === 0)
        issues.push({ path: `${mPath}.label`, message: 'Misconception label is required.' });
      if (description.length === 0)
        issues.push({
          path: `${mPath}.description`,
          message: 'Misconception description is required.',
        });
      normalisedMisconceptions.push({ label: label2, description });
    }

    normalisedParts.push({
      part_label: label,
      prompt,
      marks: Number.isInteger(p.marks) ? p.marks : 0,
      expected_response_type: p.expected_response_type,
      part_config: p.part_config ?? null,
      mark_points: normalisedMarkPoints,
      misconceptions: normalisedMisconceptions,
    });
  }

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    value: {
      component_code: input.component_code,
      topic_code: input.topic_code,
      subtopic_code: input.subtopic_code,
      command_word_code: input.command_word_code,
      archetype_code: input.archetype_code,
      stem,
      expected_response_type: input.expected_response_type,
      model_answer: modelAnswer,
      feedback_template:
        input.feedback_template === null || input.feedback_template.trim().length === 0
          ? null
          : input.feedback_template.trim(),
      difficulty_band: input.difficulty_band,
      difficulty_step: input.difficulty_step,
      source_type: input.source_type,
      review_notes: reviewNotes && reviewNotes.length > 0 ? reviewNotes : null,
      parts: normalisedParts,
      marks_total: marksTotal,
    },
  };
}

// The approval state machine. Keep allowed transitions here so the
// service and any future admin-override paths agree.
export const APPROVAL_TRANSITIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['draft', new Set(['pending_review', 'approved', 'archived'])],
  ['pending_review', new Set(['approved', 'rejected', 'draft'])],
  ['approved', new Set(['archived'])],
  ['rejected', new Set(['draft', 'archived'])],
  ['archived', new Set(['draft'])],
]);

export function canTransition(from: string, to: string): boolean {
  return APPROVAL_TRANSITIONS.get(from)?.has(to) ?? false;
}
