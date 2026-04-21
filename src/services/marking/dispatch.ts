import type {
  AttemptPartMarkPointRow,
  AttemptPartRow,
  AttemptQuestionRow,
} from '../../repos/attempts.js';
import {
  markAttemptPart,
  OBJECTIVE_RESPONSE_TYPES,
  type MarkingInputMarkPoint,
  type MarkingInputPart,
} from './deterministic.js';
import {
  type LlmFeedbackForPupil,
  type LlmFeedbackForTeacher,
  type LlmMarkingOutcome,
  type LlmOpenResponseMarker,
} from './llm.js';
import type { PromptVersionRow } from '../../repos/prompts.js';
import type { ContentGuardService } from '../content_guards.js';
import { evaluateSafetyGate, type SafetyGateReason } from './safety-gate.js';

// Marker router. Called once per attempt_part during submit. The
// deterministic path runs for every part; if it returns
// `teacher_pending` with reason `open_response`, and the part's
// response type is on the LLM allowlist, and the kill switch is on,
// the LLM path runs. Any other case returns a `pending` outcome that
// leaves the part in the teacher queue.
//
// The LLM allowlist is the single source of truth — the LlmMarker
// also guards it but dispatch must never hand an objective type
// (matrix_*, cloze_*, multiple_choice, etc.) to the LLM even if the
// flag is on. Test tests/unit/marking/dispatch.test.ts asserts that
// invariant.
//
// Chunk 3f widened the allowlist to include `code` and `algorithm`;
// the LLM marker's routing map (promptNameForResponseType) picks the
// right prompt per type.

const LLM_ALLOWED_TYPES = new Set<string>([
  'medium_text',
  'extended_response',
  'code',
  'algorithm',
]);

export type DispatchAuditEvent =
  | 'marking.llm.ok'
  | 'marking.llm.flagged'
  | 'marking.llm.refusal'
  | 'marking.llm.schema_invalid'
  | 'marking.llm.http_error'
  | 'marking.llm.timeout';

export type DispatchOutcome =
  | {
      kind: 'deterministic_awarded';
      marksAwarded: number;
      marksTotal: number;
      hitMarkPointIds: string[];
      missedMarkPointIds: string[];
    }
  | {
      kind: 'llm_awarded';
      marksAwarded: number;
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
      moderationRequired: boolean;
      moderationStatus: 'pending' | 'not_required';
      moderationNotes: readonly SafetyGateReason[] | null;
      auditEvent: 'marking.llm.ok' | 'marking.llm.flagged';
      auditDetails: {
        attempt_part_id: string;
        prompt_version: string;
        model_id: string;
        confidence: number;
        flagged_reasons?: string[];
      };
    }
  | {
      kind: 'pending';
      reason:
        | 'open_response'
        | 'unknown_type'
        | 'llm_disabled'
        | 'llm_skipped'
        | 'llm_refusal'
        | 'llm_schema_invalid'
        | 'llm_http_error'
        | 'llm_timeout';
      auditEvent?: DispatchAuditEvent;
      auditDetails?: Record<string, unknown>;
    };

export interface DispatchInput {
  readonly question: Pick<AttemptQuestionRow, 'stem' | 'model_answer'>;
  readonly part: AttemptPartRow;
  readonly markPoints: readonly AttemptPartMarkPointRow[];
}

export class MarkingDispatcher {
  constructor(
    private readonly opts: {
      llmEnabled: boolean;
      llmMarker: LlmOpenResponseMarker | null;
      contentGuards?: ContentGuardService | null;
    },
  ) {}

  async dispatch(input: DispatchInput): Promise<DispatchOutcome> {
    const det = this.runDeterministic(input);
    if (det.kind === 'deterministic_awarded') return det;

    const type = input.part.expected_response_type;
    if (!LLM_ALLOWED_TYPES.has(type)) {
      // Canvas widgets (logic_diagram/flowchart/trace_table) stay in
      // teacher_pending until Phase 7 gains their own markers.
      return { kind: 'pending', reason: det.reason };
    }
    // Hard guard: objective types must never reach the LLM path
    // regardless of flag state. In practice runDeterministic will
    // already have returned `awarded`, but the explicit check keeps
    // the test in dispatch.test.ts meaningful.
    if (OBJECTIVE_RESPONSE_TYPES.has(type)) {
      return { kind: 'pending', reason: 'unknown_type' };
    }
    if (!this.opts.llmEnabled || !this.opts.llmMarker) {
      return { kind: 'pending', reason: 'llm_disabled' };
    }

    const llm = await this.opts.llmMarker.mark({
      part: {
        id: input.part.id,
        marks: input.part.marks,
        expected_response_type: input.part.expected_response_type,
        prompt: input.part.prompt,
        raw_answer: input.part.raw_answer,
        part_label: input.part.part_label,
      },
      markPoints: input.markPoints.map((mp) => ({
        id: mp.id,
        text: mp.text,
        accepted_alternatives: mp.accepted_alternatives,
        marks: mp.marks,
        is_required: mp.is_required,
      })),
      questionStem: input.question.stem,
      modelAnswer: input.question.model_answer,
    });

    return llmOutcomeToDispatch(llm, input.part.id, input.part.raw_answer, this.opts.contentGuards);
  }

  private runDeterministic(input: DispatchInput):
    | {
        kind: 'deterministic_awarded';
        marksAwarded: number;
        marksTotal: number;
        hitMarkPointIds: string[];
        missedMarkPointIds: string[];
      }
    | { kind: 'pending'; reason: 'open_response' | 'unknown_type' } {
    const markingPart: MarkingInputPart = {
      marks: input.part.marks,
      expected_response_type: input.part.expected_response_type,
      part_config: input.part.part_config,
    };
    const mps: MarkingInputMarkPoint[] = input.markPoints.map((mp) => ({
      text: mp.text,
      accepted_alternatives: mp.accepted_alternatives,
      marks: mp.marks,
      is_required: mp.is_required,
    }));
    const result = markAttemptPart(markingPart, input.part.raw_answer, mps);
    if (result.kind === 'teacher_pending') {
      return { kind: 'pending', reason: result.reason };
    }
    const hit: string[] = [];
    const missed: string[] = [];
    for (let i = 0; i < result.mark_point_outcomes.length; i++) {
      const id = input.markPoints[i]!.id;
      if (result.mark_point_outcomes[i]!.hit) hit.push(id);
      else missed.push(id);
    }
    return {
      kind: 'deterministic_awarded',
      marksAwarded: result.marks_awarded,
      marksTotal: result.marks_possible,
      hitMarkPointIds: hit,
      missedMarkPointIds: missed,
    };
  }
}

function llmOutcomeToDispatch(
  outcome: LlmMarkingOutcome,
  attemptPartId: string,
  pupilAnswer: string,
  contentGuards: ContentGuardService | null | undefined,
): DispatchOutcome {
  if (outcome.kind === 'awarded') {
    // Content guards default to empty when no service is wired — this
    // keeps unit tests that don't need the DB working without a stub.
    // The gate's non-content rules (confidence, clipping, evidence)
    // still fire.
    const safeguardingPatterns = contentGuards?.getPatterns('safeguarding') ?? [];
    const promptInjectionPatterns = contentGuards?.getPatterns('prompt_injection') ?? [];
    const gate = evaluateSafetyGate({
      pupilAnswer,
      confidence: outcome.confidence,
      marksAwarded: outcome.marksAwarded,
      marksAwardedRaw: outcome.marksAwardedRaw,
      marksTotal: outcome.marksTotal,
      hitMarkPointCount: outcome.hitMarkPointIds.length,
      evidenceQuotes: outcome.evidenceQuotes,
      safeguardingPatterns,
      promptInjectionPatterns,
    });
    const auditEvent: 'marking.llm.ok' | 'marking.llm.flagged' = gate.flagged
      ? 'marking.llm.flagged'
      : 'marking.llm.ok';
    return {
      kind: 'llm_awarded',
      marksAwarded: outcome.marksAwarded,
      marksTotal: outcome.marksTotal,
      hitMarkPointIds: outcome.hitMarkPointIds,
      missedMarkPointIds: outcome.missedMarkPointIds,
      evidenceQuotes: outcome.evidenceQuotes,
      confidence: outcome.confidence,
      contradictionDetected: outcome.contradictionDetected,
      overAnswerDetected: outcome.overAnswerDetected,
      feedbackForPupil: outcome.feedbackForPupil,
      feedbackForTeacher: outcome.feedbackForTeacher,
      notes: outcome.notes,
      promptVersion: outcome.promptVersion,
      moderationRequired: gate.flagged,
      moderationStatus: gate.flagged ? 'pending' : 'not_required',
      moderationNotes: gate.flagged ? gate.reasons : null,
      auditEvent,
      auditDetails: {
        attempt_part_id: attemptPartId,
        prompt_version: `${outcome.promptVersion.name}@${outcome.promptVersion.version}`,
        model_id: outcome.promptVersion.model_id,
        confidence: outcome.confidence,
        ...(gate.flagged ? { flagged_reasons: gate.reasons.map((r) => r.kind) } : {}),
      },
    };
  }
  if (outcome.kind === 'skipped') {
    return { kind: 'pending', reason: 'llm_skipped' };
  }
  // Transport or app-level failure. The llm_calls row was already
  // written by the client; here we just translate into a dispatch
  // outcome and an audit event so the submission flow can continue.
  if (outcome.kind === 'refusal') {
    return {
      kind: 'pending',
      reason: 'llm_refusal',
      auditEvent: 'marking.llm.refusal',
      auditDetails: {
        attempt_part_id: attemptPartId,
        prompt_version: `${outcome.promptVersion.name}@${outcome.promptVersion.version}`,
        model_id: outcome.promptVersion.model_id,
        message: outcome.message,
      },
    };
  }
  if (outcome.kind === 'schema_invalid') {
    return {
      kind: 'pending',
      reason: 'llm_schema_invalid',
      auditEvent: 'marking.llm.schema_invalid',
      auditDetails: {
        attempt_part_id: attemptPartId,
        prompt_version: `${outcome.promptVersion.name}@${outcome.promptVersion.version}`,
        model_id: outcome.promptVersion.model_id,
        errors: outcome.errors,
      },
    };
  }
  if (outcome.kind === 'http_error') {
    return {
      kind: 'pending',
      reason: 'llm_http_error',
      auditEvent: 'marking.llm.http_error',
      auditDetails: {
        attempt_part_id: attemptPartId,
        prompt_version: `${outcome.promptVersion.name}@${outcome.promptVersion.version}`,
        model_id: outcome.promptVersion.model_id,
        status: outcome.status,
        message: outcome.message,
      },
    };
  }
  // timeout
  return {
    kind: 'pending',
    reason: 'llm_timeout',
    auditEvent: 'marking.llm.timeout',
    auditDetails: {
      attempt_part_id: attemptPartId,
      prompt_version: `${outcome.promptVersion.name}@${outcome.promptVersion.version}`,
      model_id: outcome.promptVersion.model_id,
      message: outcome.message,
    },
  };
}
