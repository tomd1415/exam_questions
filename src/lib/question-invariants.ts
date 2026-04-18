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
