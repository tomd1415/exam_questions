import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FixtureResult, PromptAggregate } from '../../src/services/eval/scoring.js';
import {
  buildReport,
  readLatestReport,
  renderMarkdown,
  writeReport,
  type EvalReport,
} from '../../src/services/eval/report.js';

// Chunk 3h. The JSON is authoritative; the MD is a human-readable
// sibling. Both must be written on every run, and readLatestReport
// must pick the newest JSON on disk so the admin page always renders
// the last run.

function result(overrides: Partial<FixtureResult>): FixtureResult {
  return {
    fixtureId: 'x',
    description: 'x',
    promptName: 'mark_open_response',
    promptVersion: 'v0.1.0',
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
    latencyMs: 200,
    costPence: 4,
    ...overrides,
  };
}

function agg(overrides: Partial<PromptAggregate> = {}): PromptAggregate {
  return {
    promptName: 'mark_open_response',
    promptVersion: 'v0.1.0',
    fixtures: 2,
    passed: 1,
    failed: 1,
    passRate: 0.5,
    meanAbsoluteError: 0.5,
    totalCostPence: 8,
    meanLatencyMs: 200,
    worstOffenders: [
      result({ fixtureId: 'fail_1', passed: false, absoluteError: 1, failReasons: ['bad'] }),
    ],
    ...overrides,
  };
}

describe('buildReport', () => {
  it('computes totals from results', () => {
    const results = [
      result({ passed: true, costPence: 3 }),
      result({ passed: false, costPence: 5 }),
    ];
    const report = buildReport([agg()], results, new Date('2026-04-21T12:00:00Z'));
    expect(report.totals.fixtures).toBe(2);
    expect(report.totals.passed).toBe(1);
    expect(report.totals.failed).toBe(1);
    expect(report.totals.totalCostPence).toBe(8);
    expect(report.totals.passRate).toBe(0.5);
    expect(report.generatedAt).toBe('2026-04-21T12:00:00.000Z');
  });

  it('handles empty results without dividing by zero', () => {
    const report = buildReport([], [], new Date('2026-04-21T12:00:00Z'));
    expect(report.totals.fixtures).toBe(0);
    expect(report.totals.passRate).toBe(0);
  });
});

describe('renderMarkdown', () => {
  it('includes totals, per-prompt sections, and worst offenders', () => {
    const report = buildReport(
      [agg()],
      [result({ passed: true }), result({ passed: false, absoluteError: 1 })],
      new Date('2026-04-21T12:00:00Z'),
    );
    const md = renderMarkdown(report);
    expect(md).toMatch(/# Prompt eval report/);
    expect(md).toMatch(/Totals:\*\* 1\/2 passed/);
    expect(md).toMatch(/mark_open_response \(v0\.1\.0\)/);
    expect(md).toMatch(/Worst offenders/);
    expect(md).toMatch(/fail_1/);
  });
});

describe('writeReport + readLatestReport', () => {
  let outDir: string;
  beforeEach(() => {
    outDir = mkdtempSync(path.join(tmpdir(), 'eval-out-'));
  });
  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it('writes both JSON and MD, and the JSON round-trips exactly', async () => {
    const report = buildReport([agg()], [result({})], new Date('2026-04-21T12:00:00Z'));
    const { jsonPath, markdownPath } = await writeReport(outDir, report);
    expect(jsonPath.endsWith('.json')).toBe(true);
    expect(markdownPath.endsWith('.md')).toBe(true);

    const roundTripped = JSON.parse(readFileSync(jsonPath, 'utf8')) as EvalReport;
    expect(roundTripped.generatedAt).toBe(report.generatedAt);
    expect(roundTripped.totals).toEqual(report.totals);

    const md = readFileSync(markdownPath, 'utf8');
    expect(md).toMatch(/# Prompt eval report/);
  });

  it('readLatestReport returns null when the directory is empty or missing', async () => {
    expect(await readLatestReport(outDir)).toBeNull();
    rmSync(outDir, { recursive: true, force: true });
    expect(await readLatestReport(outDir)).toBeNull();
  });

  it('readLatestReport returns the newest JSON by filename', async () => {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      path.join(outDir, '2026-04-20T12-00-00.json'),
      JSON.stringify(buildReport([], [], new Date('2026-04-20T12:00:00Z'))),
    );
    writeFileSync(
      path.join(outDir, '2026-04-21T12-00-00.json'),
      JSON.stringify(buildReport([], [], new Date('2026-04-21T12:00:00Z'))),
    );
    const latest = await readLatestReport(outDir);
    expect(latest?.generatedAt).toBe('2026-04-21T12:00:00.000Z');
  });
});
