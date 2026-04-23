import type { LlmClient, StructuredCallResult } from '../llm/client.js';
import { promptNameForResponseType, type PromptVersionService } from '../prompts.js';
import type { PromptVersionRow } from '../../repos/prompts.js';

// Family B dispatcher. Takes the same MarkingInputPart shape as the
// deterministic marker and returns a parallel outcome union so the
// call site in AttemptService can branch on one discriminant.
//
// Chunk 3f: the prompt name is resolved from `expected_response_type`
// via promptNameForResponseType — medium_text / extended_response map
// to `mark_open_response`, code / algorithm map to `mark_code_response`.
// Canvas widgets (logic_diagram/flowchart) have no entry in the map
// and stay teacher_pending; the allowlist in dispatch.ts is the first
// guard, this lookup is belt-and-braces.

export interface LlmMarkingInputPart {
  readonly id: string;
  readonly marks: number;
  readonly expected_response_type: string;
  readonly prompt: string;
  readonly raw_answer: string;
  readonly part_label: string;
}

export interface LlmMarkingInputMarkPoint {
  readonly id: string;
  readonly text: string;
  readonly accepted_alternatives: readonly string[];
  readonly marks: number;
  readonly is_required: boolean;
}

export interface LlmMarkingInput {
  readonly part: LlmMarkingInputPart;
  readonly markPoints: readonly LlmMarkingInputMarkPoint[];
  readonly questionStem: string;
  readonly modelAnswer: string;
}

export interface LlmFeedbackForPupil {
  readonly what_went_well: string;
  readonly how_to_gain_more: string;
  readonly next_focus: string;
}

export interface LlmFeedbackForTeacher {
  readonly summary: string;
  readonly suggested_misconception_label?: string | null;
  readonly suggested_next_question_type?: string | null;
}

export type LlmMarkingOutcome =
  | {
      kind: 'awarded';
      marksAwarded: number;
      marksAwardedRaw: number;
      marksTotal: number;
      hitMarkPointIds: string[];
      missedMarkPointIds: string[];
      evidenceQuotes: string[];
      confidence: number;
      contradictionDetected: boolean;
      overAnswerDetected: boolean;
      feedbackForPupil: LlmFeedbackForPupil;
      feedbackForTeacher: LlmFeedbackForTeacher;
      notes: string | null;
      promptVersion: PromptVersionRow;
    }
  | {
      kind: 'refusal';
      message: string;
      promptVersion: PromptVersionRow;
    }
  | {
      kind: 'schema_invalid';
      errors: string[];
      promptVersion: PromptVersionRow;
    }
  | {
      kind: 'http_error';
      status: number;
      message: string;
      promptVersion: PromptVersionRow;
    }
  | {
      kind: 'timeout';
      message: string;
      promptVersion: PromptVersionRow;
    }
  | { kind: 'skipped'; reason: 'wrong_type' | 'no_active_prompt' };

// Family B output schema. Shape mirrors
// src/services/prompts_bootstrap.ts FAMILY_B_OUTPUT_SCHEMA so this
// local type is in sync with what the LLM is contracted to return.
interface FamilyBOutput {
  marks_awarded: number;
  mark_points_hit: { mark_point_id: string; evidence_quote: string }[];
  mark_points_missed: string[];
  contradiction_detected: boolean;
  over_answer_detected: boolean;
  confidence: number;
  feedback_for_pupil: LlmFeedbackForPupil;
  feedback_for_teacher: LlmFeedbackForTeacher;
  refusal: boolean;
  notes?: string;
}

export class LlmOpenResponseMarker {
  constructor(
    private readonly client: LlmClient,
    private readonly prompts: PromptVersionService,
  ) {}

  async mark(input: LlmMarkingInput): Promise<LlmMarkingOutcome> {
    const promptName = promptNameForResponseType(input.part.expected_response_type);
    if (!promptName) {
      return { kind: 'skipped', reason: 'wrong_type' };
    }
    const promptVersion = this.prompts.getActive(promptName);
    if (!promptVersion) {
      return { kind: 'skipped', reason: 'no_active_prompt' };
    }

    const questionContext = buildQuestionContext(input);
    const result = await this.client.callResponses({
      promptVersion,
      pupilAnswer: input.part.raw_answer,
      questionContext,
      attemptPartId: input.part.id,
    });

    return this.toOutcome(result, promptVersion, input);
  }

  private toOutcome(
    result: StructuredCallResult,
    promptVersion: PromptVersionRow,
    input: LlmMarkingInput,
  ): LlmMarkingOutcome {
    if (result.kind === 'timeout') {
      return { kind: 'timeout', message: result.message, promptVersion };
    }
    if (result.kind === 'http_error') {
      return {
        kind: 'http_error',
        status: result.status,
        message: result.message,
        promptVersion,
      };
    }
    if (result.kind === 'refusal') {
      return { kind: 'refusal', message: result.message, promptVersion };
    }
    if (result.kind === 'schema_invalid') {
      return { kind: 'schema_invalid', errors: result.errors, promptVersion };
    }

    const payload = result.payload as FamilyBOutput;
    if (payload.refusal === true) {
      return {
        kind: 'refusal',
        message: payload.notes ?? 'model returned refusal=true',
        promptVersion,
      };
    }

    // Map mark_point_ids back to real rows and drop any that the model
    // hallucinated — the safety gate in 3d will flag this; for now we
    // just ignore the unknown ids so the row still writes.
    const validIds = new Set(input.markPoints.map((mp) => mp.id));
    const hitIds: string[] = [];
    const evidenceQuotes: string[] = [];
    for (const hit of payload.mark_points_hit) {
      if (validIds.has(hit.mark_point_id)) {
        hitIds.push(hit.mark_point_id);
        evidenceQuotes.push(hit.evidence_quote);
      }
    }
    const missedIds: string[] = [];
    for (const id of payload.mark_points_missed) {
      if (validIds.has(id) && !hitIds.includes(id)) missedIds.push(id);
    }
    // Any mark points the model said nothing about count as missed so
    // the stored row is complete.
    for (const mp of input.markPoints) {
      if (!hitIds.includes(mp.id) && !missedIds.includes(mp.id)) missedIds.push(mp.id);
    }

    const rawAwarded = Number.isFinite(payload.marks_awarded) ? payload.marks_awarded : 0;
    const marksAwarded = clampMarks(rawAwarded, input.part.marks);

    return {
      kind: 'awarded',
      marksAwarded,
      marksAwardedRaw: rawAwarded,
      marksTotal: input.part.marks,
      hitMarkPointIds: hitIds,
      missedMarkPointIds: missedIds,
      evidenceQuotes,
      confidence: clampConfidence(payload.confidence),
      contradictionDetected: payload.contradiction_detected === true,
      overAnswerDetected: payload.over_answer_detected === true,
      feedbackForPupil: payload.feedback_for_pupil,
      feedbackForTeacher: payload.feedback_for_teacher,
      notes: payload.notes ?? null,
      promptVersion,
    };
  }
}

function buildQuestionContext(input: LlmMarkingInput): string {
  const lines: string[] = [];
  lines.push(`Question stem: ${input.questionStem}`);
  lines.push('');
  lines.push(`Part ${input.part.part_label} (${input.part.marks} marks):`);
  lines.push(input.part.prompt);
  lines.push('');
  lines.push('Mark scheme:');
  for (const mp of input.markPoints) {
    const alts =
      mp.accepted_alternatives.length > 0
        ? ` (accepts: ${mp.accepted_alternatives.join('; ')})`
        : '';
    const required = mp.is_required ? ' [required]' : '';
    lines.push(`- mark_point_id ${mp.id} (${mp.marks} marks): ${mp.text}${alts}${required}`);
  }
  lines.push('');
  lines.push('Model answer (for calibration, do not surface verbatim):');
  lines.push(input.modelAnswer);
  return lines.join('\n');
}

function clampMarks(value: number, max: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  const intVal = Math.floor(value);
  return intVal > max ? max : intVal;
}

function clampConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
