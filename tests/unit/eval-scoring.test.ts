import { describe, expect, it } from 'vitest';
import type { LlmMarkingOutcome } from '../../src/services/marking/llm.js';
import type { PromptVersionRow } from '../../src/repos/prompts.js';
import type { EvalFixture } from '../../src/services/eval/fixtures.js';
import {
  aggregateByPrompt,
  scoreFixture,
  type FixtureResult,
} from '../../src/services/eval/scoring.js';

// Chunk 3h. Pure scoring unit tests. The harness's single job is to
// turn (fixture, outcome) → pass/fail with a defensible reason, so
// every path below is one that the admin eval page depends on.

const PROMPT_VERSION: PromptVersionRow = {
  id: '1',
  name: 'mark_open_response',
  version: 'v0.1.0-test',
  model_id: 'gpt-5-mini',
  system_prompt: 'test',
  output_schema: {},
  status: 'active',
  created_at: new Date(),
};

function baseFixture(overrides: Partial<EvalFixture> = {}): EvalFixture {
  return {
    id: 'fx_001',
    description: 'baseline fixture',
    part: {
      id: 'part-1',
      marks: 2,
      expected_response_type: 'medium_text',
      prompt: 'Describe RAM.',
      raw_answer: 'RAM is volatile and stores data in use.',
      part_label: '1a',
    },
    markPoints: [
      {
        id: 'mp_1',
        text: 'Volatile',
        accepted_alternatives: [],
        marks: 1,
        is_required: false,
      },
      {
        id: 'mp_2',
        text: 'In-use data',
        accepted_alternatives: [],
        marks: 1,
        is_required: false,
      },
    ],
    questionStem: 'stem',
    modelAnswer: 'model answer',
    expected: {
      marksAwardedRange: [2, 2],
      mustHitMarkPointIds: ['mp_1', 'mp_2'],
      mustNotHitMarkPointIds: [],
      shouldRefuse: false,
    },
    ...overrides,
  };
}

function awardedOutcome(overrides: {
  marks?: number;
  hits?: string[];
  missed?: string[];
}): LlmMarkingOutcome {
  const marks = overrides.marks ?? 2;
  const hits = overrides.hits ?? ['mp_1', 'mp_2'];
  const missed = overrides.missed ?? [];
  return {
    kind: 'awarded',
    marksAwarded: marks,
    marksAwardedRaw: marks,
    marksTotal: 2,
    hitMarkPointIds: hits,
    missedMarkPointIds: missed,
    evidenceQuotes: hits.map(() => 'quote'),
    confidence: 0.9,
    contradictionDetected: false,
    overAnswerDetected: false,
    feedbackForPupil: { what_went_well: 'a', how_to_gain_more: 'b', next_focus: 'c' },
    feedbackForTeacher: { summary: 's' },
    notes: null,
    promptVersion: PROMPT_VERSION,
  };
}

const CTX = {
  fixtureId: 'fx_001',
  description: 'baseline fixture',
  promptName: 'mark_open_response',
  latencyMs: 123,
  costPence: 4,
};

describe('scoreFixture — awarded outcomes', () => {
  it('passes when marks, required hits, and forbidden hits all align', () => {
    const result = scoreFixture(baseFixture(), awardedOutcome({}), CTX);
    expect(result.passed).toBe(true);
    expect(result.failReasons).toEqual([]);
    expect(result.outcomeKind).toBe('awarded');
    expect(result.absoluteError).toBe(0);
    expect(result.latencyMs).toBe(123);
    expect(result.costPence).toBe(4);
  });

  it('fails when marks fall outside the expected range', () => {
    const fx = baseFixture({
      expected: {
        marksAwardedRange: [2, 2],
        mustHitMarkPointIds: [],
        mustNotHitMarkPointIds: [],
        shouldRefuse: false,
      },
    });
    const result = scoreFixture(fx, awardedOutcome({ marks: 0, hits: [] }), CTX);
    expect(result.passed).toBe(false);
    expect(result.failReasons.join(' ')).toMatch(/outside expected range/);
    expect(result.absoluteError).toBe(2);
  });

  it('fails when absolute error exceeds the tolerance', () => {
    const fx = baseFixture({
      part: {
        id: 'part-1',
        marks: 4,
        expected_response_type: 'medium_text',
        prompt: 'q',
        raw_answer: 'a',
        part_label: '1',
      },
      markPoints: [
        {
          id: 'mp_1',
          text: 'x',
          accepted_alternatives: [],
          marks: 1,
          is_required: false,
        },
      ],
      expected: {
        marksAwardedRange: [2, 4],
        mustHitMarkPointIds: [],
        mustNotHitMarkPointIds: [],
        shouldRefuse: false,
        maxAbsoluteError: 0,
      },
    });
    const base = awardedOutcome({ marks: 2, hits: ['mp_1'] });
    if (base.kind !== 'awarded') throw new Error('unreachable');
    const outcome: LlmMarkingOutcome = { ...base, marksTotal: 4 };
    const result = scoreFixture(fx, outcome, CTX);
    // Mark is within [2,4] but absolute error from midpoint (3) is 1 > tolerance 0.
    expect(result.passed).toBe(false);
    expect(result.failReasons.join(' ')).toMatch(/tolerance/);
  });

  it('fails when a required mark point is missed', () => {
    const result = scoreFixture(baseFixture(), awardedOutcome({ hits: ['mp_1'], marks: 1 }), CTX);
    expect(result.passed).toBe(false);
    expect(result.missingRequiredHits).toEqual(['mp_2']);
    expect(result.failReasons.join(' ')).toMatch(/missing required/);
  });

  it('fails when a forbidden mark point is awarded', () => {
    const fx = baseFixture({
      expected: {
        marksAwardedRange: [1, 1],
        mustHitMarkPointIds: ['mp_1'],
        mustNotHitMarkPointIds: ['mp_2'],
        shouldRefuse: false,
      },
    });
    const outcome = awardedOutcome({ marks: 1, hits: ['mp_1', 'mp_2'] });
    const result = scoreFixture(fx, outcome, CTX);
    expect(result.passed).toBe(false);
    expect(result.unexpectedHits).toEqual(['mp_2']);
    expect(result.failReasons.join(' ')).toMatch(/forbidden mark points/);
  });

  it('fails when a refusal was expected but the marker awarded', () => {
    const fx = baseFixture({
      expected: {
        marksAwardedRange: [0, 0],
        mustHitMarkPointIds: [],
        mustNotHitMarkPointIds: [],
        shouldRefuse: true,
      },
    });
    const result = scoreFixture(fx, awardedOutcome({ marks: 0, hits: [] }), CTX);
    expect(result.passed).toBe(false);
    expect(result.failReasons.join(' ')).toMatch(/expected refusal/);
  });
});

describe('scoreFixture — non-awarded outcomes', () => {
  it('passes a refusal when one was expected', () => {
    const fx = baseFixture({
      expected: {
        marksAwardedRange: [0, 0],
        mustHitMarkPointIds: [],
        mustNotHitMarkPointIds: [],
        shouldRefuse: true,
      },
    });
    const outcome: LlmMarkingOutcome = {
      kind: 'refusal',
      message: 'empty answer',
      promptVersion: PROMPT_VERSION,
    };
    const result = scoreFixture(fx, outcome, CTX);
    expect(result.passed).toBe(true);
    expect(result.refused).toBe(true);
    expect(result.refusalExpected).toBe(true);
  });

  it('fails a refusal when one was not expected', () => {
    const outcome: LlmMarkingOutcome = {
      kind: 'refusal',
      message: 'model bailed',
      promptVersion: PROMPT_VERSION,
    };
    const result = scoreFixture(baseFixture(), outcome, CTX);
    expect(result.passed).toBe(false);
    expect(result.failReasons[0]).toMatch(/unexpected refusal/);
  });

  it('fails with schema_invalid and surfaces the first few errors', () => {
    const outcome: LlmMarkingOutcome = {
      kind: 'schema_invalid',
      errors: ['one', 'two', 'three', 'four'],
      promptVersion: PROMPT_VERSION,
    };
    const result = scoreFixture(baseFixture(), outcome, CTX);
    expect(result.passed).toBe(false);
    expect(result.outcomeKind).toBe('schema_invalid');
    expect(result.failReasons[0]).toMatch(/one; two; three/);
    expect(result.failReasons[0]).not.toMatch(/four/);
  });

  it('fails http_error and timeout', () => {
    const http: LlmMarkingOutcome = {
      kind: 'http_error',
      status: 502,
      message: 'bad gateway',
      promptVersion: PROMPT_VERSION,
    };
    expect(scoreFixture(baseFixture(), http, CTX).passed).toBe(false);
    const timeout: LlmMarkingOutcome = {
      kind: 'timeout',
      message: 'slow',
      promptVersion: PROMPT_VERSION,
    };
    expect(scoreFixture(baseFixture(), timeout, CTX).passed).toBe(false);
  });

  it('fails skipped with reason', () => {
    const outcome: LlmMarkingOutcome = { kind: 'skipped', reason: 'no_active_prompt' };
    const result = scoreFixture(baseFixture(), outcome, CTX);
    expect(result.passed).toBe(false);
    expect(result.outcomeKind).toBe('skipped');
    expect(result.failReasons[0]).toMatch(/no_active_prompt/);
  });
});

describe('aggregateByPrompt', () => {
  function res(overrides: Partial<FixtureResult>): FixtureResult {
    return {
      fixtureId: 'x',
      description: 'x',
      promptName: 'mark_open_response',
      promptVersion: 'v0.1.0-test',
      outcomeKind: 'awarded',
      marksAwarded: 2,
      expectedRange: [2, 2],
      absoluteError: 0,
      hitIds: [],
      missedIds: [],
      missingRequiredHits: [],
      unexpectedHits: [],
      refused: false,
      refusalExpected: false,
      passed: true,
      failReasons: [],
      latencyMs: 100,
      costPence: 5,
      ...overrides,
    };
  }

  it('groups by prompt, orders worst offenders by error desc, totals cost', () => {
    const results: FixtureResult[] = [
      res({ fixtureId: 'a1', passed: true }),
      res({
        fixtureId: 'a2',
        passed: false,
        absoluteError: 2,
        failReasons: ['r1'],
      }),
      res({
        fixtureId: 'a3',
        passed: false,
        absoluteError: 1,
        failReasons: ['r2'],
      }),
      res({
        fixtureId: 'b1',
        promptName: 'mark_code_response',
        promptVersion: 'v0.2.0',
        passed: true,
        costPence: 10,
      }),
    ];
    const aggs = aggregateByPrompt(results, 2);
    expect(aggs).toHaveLength(2);
    const open = aggs.find((a) => a.promptName === 'mark_open_response')!;
    expect(open.fixtures).toBe(3);
    expect(open.passed).toBe(1);
    expect(open.failed).toBe(2);
    expect(open.passRate).toBeCloseTo(1 / 3, 5);
    expect(open.worstOffenders.map((r) => r.fixtureId)).toEqual(['a2', 'a3']);
    expect(open.totalCostPence).toBe(15);
    const code = aggs.find((a) => a.promptName === 'mark_code_response')!;
    expect(code.passRate).toBe(1);
    expect(code.worstOffenders).toEqual([]);
    expect(code.totalCostPence).toBe(10);
  });

  it('returns null mean error / latency when no awarded outcomes are present', () => {
    const results: FixtureResult[] = [
      res({
        outcomeKind: 'refusal',
        marksAwarded: null,
        absoluteError: null,
        latencyMs: null,
        refused: true,
        passed: false,
      }),
    ];
    const aggs = aggregateByPrompt(results);
    expect(aggs[0]!.meanAbsoluteError).toBeNull();
    expect(aggs[0]!.meanLatencyMs).toBeNull();
  });
});
