import { describe, expect, it } from 'vitest';
import type {
  LlmClient,
  StructuredCallInput,
  StructuredCallResult,
} from '../../../src/services/llm/client.js';
import { LlmOpenResponseMarker, type LlmMarkingInput } from '../../../src/services/marking/llm.js';
import type { PromptVersionService } from '../../../src/services/prompts.js';
import type { PromptVersionRow } from '../../../src/repos/prompts.js';

// Chunk 3f: the marker must resolve which prompt to call via the
// routing map, not a hard-coded name. The two prompts share the
// Family B schema so switching them is a string swap, but the
// prompt_version row that lands on awarded_marks has to match the
// type that was marked — otherwise the cost dashboard and the
// review surface both lie.

const OPEN_PROMPT: PromptVersionRow = {
  id: '100',
  name: 'mark_open_response',
  version: 'v0.1.0',
  model_id: 'gpt-5-mini',
  system_prompt: 'open prompt body',
  output_schema: {},
  status: 'active',
  created_at: new Date(),
};

const CODE_PROMPT: PromptVersionRow = {
  id: '101',
  name: 'mark_code_response',
  version: 'v0.1.0',
  model_id: 'gpt-5-mini',
  system_prompt: 'code prompt body',
  output_schema: {},
  status: 'active',
  created_at: new Date(),
};

function makePrompts(active: Partial<Record<string, PromptVersionRow>>): PromptVersionService {
  return {
    getActive(name: string): PromptVersionRow | null {
      return active[name] ?? null;
    },
  } as unknown as PromptVersionService;
}

class RecordingClient {
  calls: StructuredCallInput[] = [];
  nextResult: StructuredCallResult = {
    kind: 'ok',
    payload: {
      marks_awarded: 1,
      mark_points_hit: [],
      mark_points_missed: [],
      contradiction_detected: false,
      over_answer_detected: false,
      confidence: 0.9,
      feedback_for_pupil: {
        what_went_well: 'ok',
        how_to_gain_more: 'ok',
        next_focus: 'ok',
      },
      feedback_for_teacher: { summary: 'ok' },
      refusal: false,
    },
    usage: { inputTokens: 10, outputTokens: 5 },
    latencyMs: 1,
    costPence: 0,
  };

  callResponses(input: StructuredCallInput): Promise<StructuredCallResult> {
    this.calls.push(input);
    return Promise.resolve(this.nextResult);
  }
}

function asClient(c: RecordingClient): LlmClient {
  return c as unknown as LlmClient;
}

function makeInput(type: string): LlmMarkingInput {
  return {
    part: {
      id: '1',
      marks: 4,
      expected_response_type: type,
      prompt: 'Explain.',
      raw_answer: 'Some answer.',
      part_label: '(a)',
    },
    markPoints: [],
    questionStem: 'Stem',
    modelAnswer: 'Model answer',
  };
}

describe('LlmOpenResponseMarker — chunk 3f routing', () => {
  it('calls mark_open_response for medium_text', async () => {
    const client = new RecordingClient();
    const marker = new LlmOpenResponseMarker(
      asClient(client),
      makePrompts({ mark_open_response: OPEN_PROMPT, mark_code_response: CODE_PROMPT }),
    );
    const outcome = await marker.mark(makeInput('medium_text'));
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.promptVersion.name).toBe('mark_open_response');
    if (outcome.kind === 'awarded') {
      expect(outcome.promptVersion.name).toBe('mark_open_response');
    } else {
      throw new Error(`expected awarded, got ${outcome.kind}`);
    }
  });

  it('calls mark_open_response for extended_response', async () => {
    const client = new RecordingClient();
    const marker = new LlmOpenResponseMarker(
      asClient(client),
      makePrompts({ mark_open_response: OPEN_PROMPT, mark_code_response: CODE_PROMPT }),
    );
    await marker.mark(makeInput('extended_response'));
    expect(client.calls[0]!.promptVersion.name).toBe('mark_open_response');
  });

  it('calls mark_code_response for code', async () => {
    const client = new RecordingClient();
    const marker = new LlmOpenResponseMarker(
      asClient(client),
      makePrompts({ mark_open_response: OPEN_PROMPT, mark_code_response: CODE_PROMPT }),
    );
    const outcome = await marker.mark(makeInput('code'));
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.promptVersion.name).toBe('mark_code_response');
    if (outcome.kind === 'awarded') {
      expect(outcome.promptVersion.name).toBe('mark_code_response');
    } else {
      throw new Error(`expected awarded, got ${outcome.kind}`);
    }
  });

  it('calls mark_code_response for algorithm', async () => {
    const client = new RecordingClient();
    const marker = new LlmOpenResponseMarker(
      asClient(client),
      makePrompts({ mark_open_response: OPEN_PROMPT, mark_code_response: CODE_PROMPT }),
    );
    await marker.mark(makeInput('algorithm'));
    expect(client.calls[0]!.promptVersion.name).toBe('mark_code_response');
  });

  it('skips with wrong_type when the response type has no prompt mapping', async () => {
    const client = new RecordingClient();
    const marker = new LlmOpenResponseMarker(
      asClient(client),
      makePrompts({ mark_open_response: OPEN_PROMPT, mark_code_response: CODE_PROMPT }),
    );
    const outcome = await marker.mark(makeInput('flowchart'));
    expect(client.calls).toHaveLength(0);
    expect(outcome).toEqual({ kind: 'skipped', reason: 'wrong_type' });
  });

  it('skips with no_active_prompt when the mapped prompt is not active', async () => {
    const client = new RecordingClient();
    const marker = new LlmOpenResponseMarker(
      asClient(client),
      // Only open prompt active: a `code` part has nowhere to go.
      makePrompts({ mark_open_response: OPEN_PROMPT }),
    );
    const outcome = await marker.mark(makeInput('code'));
    expect(client.calls).toHaveLength(0);
    expect(outcome).toEqual({ kind: 'skipped', reason: 'no_active_prompt' });
  });
});
