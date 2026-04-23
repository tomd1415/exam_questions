import type { LlmMarkingInput, LlmMarkingOutcome } from '../marking/llm.js';
import type { LoadedFixture } from './fixtures.js';
import { promptNameForResponseType } from '../prompts.js';
import {
  aggregateByPrompt,
  scoreFixture,
  type FixtureResult,
  type PromptAggregate,
} from './scoring.js';
import { buildReport, type EvalReport } from './report.js';

// Chunk 3h. Pure runner — takes a marker interface and a list of
// loaded fixtures, returns a structured report. The CLI wrapper in
// scripts/eval/run-prompt-evals.ts handles DB, LLM client, and
// filesystem; the runner knows nothing about any of that. This split
// is what lets the integration test drive the harness end-to-end with
// a fake marker in-process.

export interface EvalMarker {
  mark(input: LlmMarkingInput): Promise<LlmMarkingOutcome>;
}

export interface RunnerOptions {
  readonly activePromptNames: ReadonlySet<string>;
  readonly now?: () => Date;
}

export interface RunnerOutcome {
  readonly report: EvalReport;
  readonly aggregates: readonly PromptAggregate[];
  readonly results: readonly FixtureResult[];
}

// Run each fixture through the marker and score the outcome. Fixtures
// whose prompt has no active version are recorded as skipped; the
// report then shows a clear "0/N, no active prompt" line rather than
// pretending the prompt passed.
export async function runEvals(
  fixtures: readonly LoadedFixture[],
  marker: EvalMarker,
  opts: RunnerOptions,
): Promise<RunnerOutcome> {
  const now = opts.now ?? (() => new Date());
  const results: FixtureResult[] = [];

  for (const { promptName, fixture } of fixtures) {
    const expectedPrompt = promptNameForResponseType(fixture.part.expected_response_type);
    if (expectedPrompt !== promptName) {
      // Fixture sits under a prompt directory whose routing map doesn't
      // match its expected_response_type — author error in the fixture
      // file, surface as a fail rather than silently run.
      results.push({
        fixtureId: fixture.id,
        description: fixture.description,
        promptName,
        promptVersion: null,
        outcomeKind: 'skipped',
        marksAwarded: null,
        expectedRange: fixture.expected.marksAwardedRange,
        absoluteError: null,
        hitIds: [],
        missedIds: [],
        missingRequiredHits: [],
        unexpectedHits: [],
        refused: false,
        refusalExpected: fixture.expected.shouldRefuse,
        passed: false,
        failReasons: [
          `fixture response_type ${fixture.part.expected_response_type} routes to ${expectedPrompt ?? 'no prompt'}, not ${promptName}`,
        ],
        latencyMs: null,
        costPence: null,
      });
      continue;
    }

    if (!opts.activePromptNames.has(promptName)) {
      results.push({
        fixtureId: fixture.id,
        description: fixture.description,
        promptName,
        promptVersion: null,
        outcomeKind: 'skipped',
        marksAwarded: null,
        expectedRange: fixture.expected.marksAwardedRange,
        absoluteError: null,
        hitIds: [],
        missedIds: [],
        missingRequiredHits: [],
        unexpectedHits: [],
        refused: false,
        refusalExpected: fixture.expected.shouldRefuse,
        passed: false,
        failReasons: [`no active prompt version for ${promptName}`],
        latencyMs: null,
        costPence: null,
      });
      continue;
    }

    const input: LlmMarkingInput = {
      part: fixture.part,
      markPoints: fixture.markPoints,
      questionStem: fixture.questionStem,
      modelAnswer: fixture.modelAnswer,
    };
    const start = Date.now();
    const outcome = await marker.mark(input);
    const latencyMs = Date.now() - start;

    results.push(
      scoreFixture(fixture, outcome, {
        fixtureId: fixture.id,
        description: fixture.description,
        promptName,
        latencyMs,
        costPence: null,
      }),
    );
  }

  const aggregates = aggregateByPrompt(results);
  const report = buildReport(aggregates, results, now());
  return { report, aggregates, results };
}
