import { describe, it, expect } from 'vitest';
import type {
  AttemptPartMarkPointRow,
  AttemptPartRow,
  AttemptQuestionRow,
} from '../../../src/repos/attempts.js';
import type { PromptVersionRow } from '../../../src/repos/prompts.js';
import { MarkingDispatcher } from '../../../src/services/marking/dispatch.js';
import type {
  LlmMarkingInput,
  LlmMarkingOutcome,
  LlmOpenResponseMarker,
} from '../../../src/services/marking/llm.js';

// Exhaustive router check: the only response types that may hand off
// to the LLM are medium_text and extended_response. Objective types,
// code/algorithm, and canvas widgets must never reach the marker even
// when the kill switch is on. This test is the guardrail for the
// invariant in PHASE3_PLAN.md §5 chunk 3c.

const PROMPT: PromptVersionRow = {
  id: '99',
  name: 'mark_open_response',
  version: 'v0.1.0',
  model_id: 'gpt-5-mini',
  system_prompt: 'unused in dispatch test',
  output_schema: {},
  status: 'active',
  created_at: new Date(),
};

class RecordingLlmMarker {
  calls: LlmMarkingInput[] = [];
  nextOutcome: LlmMarkingOutcome = {
    kind: 'awarded',
    marksAwarded: 2,
    marksTotal: 4,
    hitMarkPointIds: [],
    missedMarkPointIds: [],
    evidenceQuotes: [],
    confidence: 0.8,
    contradictionDetected: false,
    overAnswerDetected: false,
    feedbackForPupil: {
      what_went_well: 'ok',
      how_to_gain_more: 'ok',
      next_focus: 'ok',
    },
    feedbackForTeacher: { summary: 'ok' },
    notes: null,
    promptVersion: PROMPT,
  };

  mark(input: LlmMarkingInput): Promise<LlmMarkingOutcome> {
    this.calls.push(input);
    return Promise.resolve(this.nextOutcome);
  }
}

function asMarker(m: RecordingLlmMarker): LlmOpenResponseMarker {
  return m as unknown as LlmOpenResponseMarker;
}

function makePart(overrides: Partial<AttemptPartRow>): AttemptPartRow {
  return {
    id: '1',
    attempt_question_id: '10',
    question_part_id: '100',
    part_label: '(a)',
    prompt: 'Explain.',
    marks: 4,
    expected_response_type: 'medium_text',
    part_config: null,
    display_order: 1,
    raw_answer: 'A long pupil answer.',
    last_saved_at: new Date(),
    submitted_at: null,
    pupil_self_marks: null,
    ...overrides,
  };
}

function makeQuestion(): AttemptQuestionRow {
  return {
    id: '10',
    attempt_id: '1000',
    question_id: '2000',
    display_order: 1,
    stem: 'Stem',
    model_answer: 'Model answer',
    topic_code: '1.2',
    subtopic_code: '1.2.1',
    command_word_code: 'explain',
    marks_total: 4,
    submitted_at: null,
  };
}

const NO_MARK_POINTS: AttemptPartMarkPointRow[] = [];

describe('MarkingDispatcher — LLM allowlist', () => {
  const objectiveTypes = [
    'multiple_choice',
    'tick_box',
    'short_text',
    'matrix_tick_single',
    'matrix_tick_multi',
    'cloze_free',
    'cloze_with_bank',
    'cloze_code',
    'trace_table',
    'matching',
    'diagram_labels',
  ];

  for (const type of objectiveTypes) {
    it(`never reaches the LLM for ${type} even with the flag on`, async () => {
      const marker = new RecordingLlmMarker();
      const dispatcher = new MarkingDispatcher({ llmEnabled: true, llmMarker: asMarker(marker) });
      const part = makePart({ expected_response_type: type, raw_answer: '' });
      await dispatcher.dispatch({ question: makeQuestion(), part, markPoints: NO_MARK_POINTS });
      expect(marker.calls).toHaveLength(0);
    });
  }

  for (const type of ['code', 'algorithm']) {
    it(`holds ${type} as pending (waiting on 3f) even with the flag on`, async () => {
      const marker = new RecordingLlmMarker();
      const dispatcher = new MarkingDispatcher({ llmEnabled: true, llmMarker: asMarker(marker) });
      const part = makePart({ expected_response_type: type });
      const outcome = await dispatcher.dispatch({
        question: makeQuestion(),
        part,
        markPoints: NO_MARK_POINTS,
      });
      expect(marker.calls).toHaveLength(0);
      expect(outcome.kind).toBe('pending');
    });
  }

  for (const type of ['flowchart', 'logic_diagram']) {
    it(`holds canvas widget ${type} as pending without calling the LLM`, async () => {
      const marker = new RecordingLlmMarker();
      const dispatcher = new MarkingDispatcher({ llmEnabled: true, llmMarker: asMarker(marker) });
      const part = makePart({ expected_response_type: type, part_config: null });
      const outcome = await dispatcher.dispatch({
        question: makeQuestion(),
        part,
        markPoints: NO_MARK_POINTS,
      });
      expect(marker.calls).toHaveLength(0);
      expect(outcome.kind).toBe('pending');
    });
  }

  it('routes medium_text to the LLM when the flag is on', async () => {
    const marker = new RecordingLlmMarker();
    const dispatcher = new MarkingDispatcher({ llmEnabled: true, llmMarker: asMarker(marker) });
    const part = makePart({ expected_response_type: 'medium_text' });
    const outcome = await dispatcher.dispatch({
      question: makeQuestion(),
      part,
      markPoints: NO_MARK_POINTS,
    });
    expect(marker.calls).toHaveLength(1);
    expect(outcome.kind).toBe('llm_awarded');
  });

  it('routes extended_response to the LLM when the flag is on', async () => {
    const marker = new RecordingLlmMarker();
    const dispatcher = new MarkingDispatcher({ llmEnabled: true, llmMarker: asMarker(marker) });
    const part = makePart({ expected_response_type: 'extended_response' });
    const outcome = await dispatcher.dispatch({
      question: makeQuestion(),
      part,
      markPoints: NO_MARK_POINTS,
    });
    expect(marker.calls).toHaveLength(1);
    expect(outcome.kind).toBe('llm_awarded');
  });

  it('returns pending (llm_disabled) for medium_text when the flag is off', async () => {
    const marker = new RecordingLlmMarker();
    const dispatcher = new MarkingDispatcher({ llmEnabled: false, llmMarker: null });
    const part = makePart({ expected_response_type: 'medium_text' });
    const outcome = await dispatcher.dispatch({
      question: makeQuestion(),
      part,
      markPoints: NO_MARK_POINTS,
    });
    expect(marker.calls).toHaveLength(0);
    expect(outcome.kind).toBe('pending');
    if (outcome.kind === 'pending') expect(outcome.reason).toBe('llm_disabled');
  });

  it('forwards transport errors as pending with the matching audit event', async () => {
    const marker = new RecordingLlmMarker();
    marker.nextOutcome = {
      kind: 'http_error',
      status: 502,
      message: 'bad gateway',
      promptVersion: PROMPT,
    };
    const dispatcher = new MarkingDispatcher({ llmEnabled: true, llmMarker: asMarker(marker) });
    const part = makePart({ expected_response_type: 'medium_text' });
    const outcome = await dispatcher.dispatch({
      question: makeQuestion(),
      part,
      markPoints: NO_MARK_POINTS,
    });
    expect(outcome.kind).toBe('pending');
    if (outcome.kind === 'pending') {
      expect(outcome.reason).toBe('llm_http_error');
      expect(outcome.auditEvent).toBe('marking.llm.http_error');
    }
  });

  it('runs the deterministic marker for objective types (awarded outcome)', async () => {
    const dispatcher = new MarkingDispatcher({ llmEnabled: false, llmMarker: null });
    const part = makePart({
      expected_response_type: 'multiple_choice',
      raw_answer: 'CPU',
      marks: 1,
    });
    const markPoints: AttemptPartMarkPointRow[] = [
      {
        id: '500',
        question_part_id: '100',
        text: 'CPU',
        accepted_alternatives: [],
        marks: 1,
        is_required: false,
        display_order: 1,
      },
    ];
    const outcome = await dispatcher.dispatch({
      question: makeQuestion(),
      part,
      markPoints,
    });
    expect(outcome.kind).toBe('deterministic_awarded');
    if (outcome.kind === 'deterministic_awarded') {
      expect(outcome.marksAwarded).toBe(1);
      expect(outcome.hitMarkPointIds).toEqual(['500']);
    }
  });
});
