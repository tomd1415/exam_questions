import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PromptVersionRow } from '../../src/repos/prompts.js';
import type { LlmMarkingInput, LlmMarkingOutcome } from '../../src/services/marking/llm.js';
import { loadFixturesFromDisk } from '../../src/services/eval/fixtures.js';
import { runEvals, type EvalMarker } from '../../src/services/eval/runner.js';

// Chunk 3h. Runner end-to-end with a fake marker. The point here is
// that the runner correctly wires the fixture into the marker, tags
// skipped-because-no-active-prompt, and aggregates per prompt.

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

function makeFixturesDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'eval-runner-'));
  const openDir = path.join(root, 'mark_open_response');
  mkdirSync(openDir, { recursive: true });

  const pass = {
    id: 'open_pass',
    description: 'marker matches expected',
    part: {
      id: 'p1',
      marks: 2,
      expected_response_type: 'medium_text',
      prompt: 'q',
      raw_answer: 'RAM is volatile.',
      part_label: '1a',
    },
    markPoints: [
      { id: 'mp_1', text: 'Volatile', accepted_alternatives: [], marks: 1, is_required: false },
      { id: 'mp_2', text: 'In-use', accepted_alternatives: [], marks: 1, is_required: false },
    ],
    questionStem: 'stem',
    modelAnswer: 'answer',
    expected: {
      marksAwardedRange: [2, 2],
      mustHitMarkPointIds: ['mp_1', 'mp_2'],
      mustNotHitMarkPointIds: [],
      shouldRefuse: false,
    },
  };
  const fail = {
    ...pass,
    id: 'open_fail',
    description: 'marker under-awards',
    expected: { ...pass.expected },
  };
  writeFileSync(path.join(openDir, '01_pass.json'), JSON.stringify(pass));
  writeFileSync(path.join(openDir, '02_fail.json'), JSON.stringify(fail));
  return root;
}

class ScriptedMarker implements EvalMarker {
  private calls = 0;
  constructor(private readonly outcomes: LlmMarkingOutcome[]) {}
  mark(_input: LlmMarkingInput): Promise<LlmMarkingOutcome> {
    const out = this.outcomes[this.calls++];
    if (!out) return Promise.reject(new Error('scripted marker ran out of outcomes'));
    return Promise.resolve(out);
  }
}

function awarded(marks: number, hits: string[]): LlmMarkingOutcome {
  return {
    kind: 'awarded',
    marksAwarded: marks,
    marksAwardedRaw: marks,
    marksTotal: 2,
    hitMarkPointIds: hits,
    missedMarkPointIds: [],
    evidenceQuotes: hits.map(() => 'q'),
    confidence: 0.9,
    contradictionDetected: false,
    overAnswerDetected: false,
    feedbackForPupil: { what_went_well: 'a', how_to_gain_more: 'b', next_focus: 'c' },
    feedbackForTeacher: { summary: 's' },
    notes: null,
    promptVersion: PROMPT_VERSION,
  };
}

describe('runEvals — end-to-end against a fake marker', () => {
  let root: string;
  beforeEach(() => {
    root = makeFixturesDir();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('marks pass/fail per fixture and aggregates per prompt', async () => {
    const fixtures = await loadFixturesFromDisk(root);
    expect(fixtures).toHaveLength(2);

    const marker = new ScriptedMarker([
      awarded(2, ['mp_1', 'mp_2']), // → pass
      awarded(1, ['mp_1']), // → fail: missing mp_2 + marks out of range
    ]);

    const { report, results, aggregates } = await runEvals(fixtures, marker, {
      activePromptNames: new Set(['mark_open_response']),
      now: () => new Date('2026-04-21T12:00:00Z'),
    });
    expect(results).toHaveLength(2);
    const pass = results.find((r) => r.fixtureId === 'open_pass')!;
    const fail = results.find((r) => r.fixtureId === 'open_fail')!;
    expect(pass.passed).toBe(true);
    expect(fail.passed).toBe(false);
    expect(fail.missingRequiredHits).toEqual(['mp_2']);

    expect(aggregates).toHaveLength(1);
    expect(aggregates[0]!.passed).toBe(1);
    expect(aggregates[0]!.failed).toBe(1);
    expect(aggregates[0]!.passRate).toBe(0.5);

    expect(report.generatedAt).toBe('2026-04-21T12:00:00.000Z');
    expect(report.totals.passed).toBe(1);
  });

  it('records skipped when the prompt has no active version, without calling the marker', async () => {
    const fixtures = await loadFixturesFromDisk(root);
    let called = 0;
    const marker: EvalMarker = {
      mark: () => {
        called++;
        return Promise.resolve(awarded(2, ['mp_1', 'mp_2']));
      },
    };

    const { results } = await runEvals(fixtures, marker, {
      activePromptNames: new Set(), // nothing active
    });
    expect(called).toBe(0);
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.outcomeKind).toBe('skipped');
      expect(r.passed).toBe(false);
      expect(r.failReasons[0]).toMatch(/no active prompt/);
    }
  });
});
