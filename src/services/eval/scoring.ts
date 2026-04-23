import type { LlmMarkingOutcome } from '../marking/llm.js';
import type { EvalFixture } from './fixtures.js';

// Chunk 3h. Pure scoring for eval fixtures. Given a fixture's
// `expected` block and the marker's actual outcome, produce a verdict
// the reporter can aggregate. Isolated from IO and the marker so the
// unit tests are cheap and the CI job stays reproducible.

export type FixtureOutcomeKind =
  | 'awarded'
  | 'refusal'
  | 'schema_invalid'
  | 'http_error'
  | 'timeout'
  | 'skipped';

export interface FixtureResult {
  readonly fixtureId: string;
  readonly description: string;
  readonly promptName: string;
  readonly promptVersion: string | null;
  readonly outcomeKind: FixtureOutcomeKind;
  readonly marksAwarded: number | null;
  readonly expectedRange: readonly [number, number];
  readonly absoluteError: number | null;
  readonly hitIds: readonly string[];
  readonly missedIds: readonly string[];
  readonly missingRequiredHits: readonly string[];
  readonly unexpectedHits: readonly string[];
  readonly refused: boolean;
  readonly refusalExpected: boolean;
  readonly passed: boolean;
  readonly failReasons: readonly string[];
  readonly latencyMs: number | null;
  readonly costPence: number | null;
}

export interface ScoringContext {
  readonly fixtureId: string;
  readonly description: string;
  readonly promptName: string;
  readonly latencyMs: number | null;
  readonly costPence: number | null;
}

const DEFAULT_MAX_ABSOLUTE_ERROR = 1;

export function scoreFixture(
  fixture: EvalFixture,
  outcome: LlmMarkingOutcome,
  ctx: ScoringContext,
): FixtureResult {
  const [lo, hi] = fixture.expected.marksAwardedRange;
  const tolerance = fixture.expected.maxAbsoluteError ?? DEFAULT_MAX_ABSOLUTE_ERROR;

  if (outcome.kind === 'skipped') {
    return fail(fixture, ctx, 'skipped', null, [`marker skipped: ${outcome.reason}`]);
  }
  if (outcome.kind === 'timeout') {
    return fail(fixture, ctx, 'timeout', outcome.promptVersion.version, [
      `marker timed out: ${outcome.message}`,
    ]);
  }
  if (outcome.kind === 'http_error') {
    return fail(fixture, ctx, 'http_error', outcome.promptVersion.version, [
      `HTTP ${outcome.status}: ${outcome.message}`,
    ]);
  }
  if (outcome.kind === 'schema_invalid') {
    return fail(fixture, ctx, 'schema_invalid', outcome.promptVersion.version, [
      `schema invalid: ${outcome.errors.slice(0, 3).join('; ')}`,
    ]);
  }

  const refusalExpected = fixture.expected.shouldRefuse;

  if (outcome.kind === 'refusal') {
    const reasons: string[] = [];
    if (!refusalExpected) reasons.push(`unexpected refusal: ${outcome.message}`);
    return {
      fixtureId: ctx.fixtureId,
      description: ctx.description,
      promptName: ctx.promptName,
      promptVersion: outcome.promptVersion.version,
      outcomeKind: 'refusal',
      marksAwarded: null,
      expectedRange: [lo, hi],
      absoluteError: null,
      hitIds: [],
      missedIds: [],
      missingRequiredHits: [],
      unexpectedHits: [],
      refused: true,
      refusalExpected,
      passed: refusalExpected,
      failReasons: reasons,
      latencyMs: ctx.latencyMs,
      costPence: ctx.costPence,
    };
  }

  // outcome.kind === 'awarded'
  const marks = outcome.marksAwarded;
  const withinRange = marks >= lo && marks <= hi;
  const midpoint = Math.round((lo + hi) / 2);
  const absoluteError = Math.abs(marks - midpoint);

  const hitSet = new Set(outcome.hitMarkPointIds);
  const missingRequiredHits = fixture.expected.mustHitMarkPointIds.filter((id) => !hitSet.has(id));
  const unexpectedHits = fixture.expected.mustNotHitMarkPointIds.filter((id) => hitSet.has(id));

  const reasons: string[] = [];
  if (refusalExpected) {
    reasons.push('expected refusal but marker awarded');
  }
  if (!withinRange) {
    reasons.push(`marks ${marks} outside expected range [${lo}, ${hi}]`);
  }
  if (absoluteError > tolerance) {
    reasons.push(`absolute error ${absoluteError} exceeds tolerance ${tolerance}`);
  }
  if (missingRequiredHits.length > 0) {
    reasons.push(`missing required mark points: ${missingRequiredHits.join(', ')}`);
  }
  if (unexpectedHits.length > 0) {
    reasons.push(`awarded forbidden mark points: ${unexpectedHits.join(', ')}`);
  }

  return {
    fixtureId: ctx.fixtureId,
    description: ctx.description,
    promptName: ctx.promptName,
    promptVersion: outcome.promptVersion.version,
    outcomeKind: 'awarded',
    marksAwarded: marks,
    expectedRange: [lo, hi],
    absoluteError,
    hitIds: outcome.hitMarkPointIds,
    missedIds: outcome.missedMarkPointIds,
    missingRequiredHits,
    unexpectedHits,
    refused: false,
    refusalExpected,
    passed: reasons.length === 0,
    failReasons: reasons,
    latencyMs: ctx.latencyMs,
    costPence: ctx.costPence,
  };
}

function fail(
  fixture: EvalFixture,
  ctx: ScoringContext,
  kind: FixtureOutcomeKind,
  promptVersion: string | null,
  reasons: string[],
): FixtureResult {
  return {
    fixtureId: ctx.fixtureId,
    description: ctx.description,
    promptName: ctx.promptName,
    promptVersion,
    outcomeKind: kind,
    marksAwarded: null,
    expectedRange: fixture.expected.marksAwardedRange,
    absoluteError: null,
    hitIds: [],
    missedIds: [],
    missingRequiredHits: [],
    unexpectedHits: [],
    refused: kind === 'refusal',
    refusalExpected: fixture.expected.shouldRefuse,
    passed: false,
    failReasons: reasons,
    latencyMs: ctx.latencyMs,
    costPence: ctx.costPence,
  };
}

export interface PromptAggregate {
  readonly promptName: string;
  readonly promptVersion: string | null;
  readonly fixtures: number;
  readonly passed: number;
  readonly failed: number;
  readonly passRate: number;
  readonly meanAbsoluteError: number | null;
  readonly totalCostPence: number;
  readonly meanLatencyMs: number | null;
  readonly worstOffenders: readonly FixtureResult[];
}

export function aggregateByPrompt(
  results: readonly FixtureResult[],
  worstCount = 3,
): PromptAggregate[] {
  const grouped = new Map<string, FixtureResult[]>();
  for (const r of results) {
    const list = grouped.get(r.promptName) ?? [];
    list.push(r);
    grouped.set(r.promptName, list);
  }
  const aggregates: PromptAggregate[] = [];
  for (const [promptName, list] of grouped) {
    const passed = list.filter((r) => r.passed).length;
    const errors = list
      .map((r) => r.absoluteError)
      .filter((v): v is number => typeof v === 'number');
    const meanAbsoluteError =
      errors.length === 0 ? null : errors.reduce((a, b) => a + b, 0) / errors.length;
    const latencies = list
      .map((r) => r.latencyMs)
      .filter((v): v is number => typeof v === 'number');
    const meanLatencyMs =
      latencies.length === 0 ? null : latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const totalCostPence = list.reduce((a, r) => a + (r.costPence ?? 0), 0);
    const worstOffenders = [...list]
      .filter((r) => !r.passed)
      .sort((a, b) => (b.absoluteError ?? 0) - (a.absoluteError ?? 0))
      .slice(0, worstCount);
    const promptVersion = list.find((r) => r.promptVersion)?.promptVersion ?? null;
    aggregates.push({
      promptName,
      promptVersion,
      fixtures: list.length,
      passed,
      failed: list.length - passed,
      passRate: list.length === 0 ? 0 : passed / list.length,
      meanAbsoluteError,
      totalCostPence,
      meanLatencyMs,
      worstOffenders,
    });
  }
  aggregates.sort((a, b) => a.promptName.localeCompare(b.promptName));
  return aggregates;
}
