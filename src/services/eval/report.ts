import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FixtureResult, PromptAggregate } from './scoring.js';

// Chunk 3h. Report writer and reader. The runner writes one pair of
// files per invocation: a JSON source-of-truth (consumed by the
// admin page) and a markdown sibling (consumed by humans at the CLI
// and by CI job summaries). Both encode the same data; the JSON is
// authoritative.

export interface EvalReport {
  readonly generatedAt: string;
  readonly aggregates: readonly PromptAggregate[];
  readonly results: readonly FixtureResult[];
  readonly totals: {
    readonly fixtures: number;
    readonly passed: number;
    readonly failed: number;
    readonly passRate: number;
    readonly totalCostPence: number;
  };
}

export function buildReport(
  aggregates: readonly PromptAggregate[],
  results: readonly FixtureResult[],
  generatedAt: Date = new Date(),
): EvalReport {
  const passed = results.filter((r) => r.passed).length;
  const totalCostPence = results.reduce((a, r) => a + (r.costPence ?? 0), 0);
  return {
    generatedAt: generatedAt.toISOString(),
    aggregates,
    results,
    totals: {
      fixtures: results.length,
      passed,
      failed: results.length - passed,
      passRate: results.length === 0 ? 0 : passed / results.length,
      totalCostPence,
    },
  };
}

export function renderMarkdown(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`# Prompt eval report — ${report.generatedAt}`);
  lines.push('');
  lines.push(
    `**Totals:** ${report.totals.passed}/${report.totals.fixtures} passed (${pct(report.totals.passRate)}), cost £${pounds(report.totals.totalCostPence)}.`,
  );
  lines.push('');
  for (const agg of report.aggregates) {
    lines.push(`## ${agg.promptName} (${agg.promptVersion ?? 'no active version'})`);
    lines.push('');
    lines.push(
      `- Fixtures: ${agg.fixtures} · Passed: ${agg.passed} · Failed: ${agg.failed} · Pass rate: ${pct(agg.passRate)}`,
    );
    const mae = agg.meanAbsoluteError === null ? 'n/a' : agg.meanAbsoluteError.toFixed(2);
    const mlat = agg.meanLatencyMs === null ? 'n/a' : `${agg.meanLatencyMs.toFixed(0)} ms`;
    lines.push(
      `- Mean abs. error: ${mae} · Mean latency: ${mlat} · Spend: £${pounds(agg.totalCostPence)}`,
    );
    if (agg.worstOffenders.length > 0) {
      lines.push('');
      lines.push('### Worst offenders');
      lines.push('');
      for (const r of agg.worstOffenders) {
        lines.push(`- **${r.fixtureId}** — ${r.description}`);
        lines.push(
          `  - outcome: ${r.outcomeKind}${r.marksAwarded === null ? '' : ` · marks: ${r.marksAwarded}/${r.expectedRange[1]}`}${r.absoluteError === null ? '' : ` · |err|: ${r.absoluteError}`}`,
        );
        for (const reason of r.failReasons) {
          lines.push(`  - ${reason}`);
        }
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function pounds(pence: number): string {
  return (pence / 100).toFixed(2);
}

export interface WrittenReport {
  readonly jsonPath: string;
  readonly markdownPath: string;
}

export async function writeReport(outDir: string, report: EvalReport): Promise<WrittenReport> {
  await fs.mkdir(outDir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:]/g, '-').replace(/\..+$/, '');
  const jsonPath = path.join(outDir, `${stamp}.json`);
  const markdownPath = path.join(outDir, `${stamp}.md`);
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  await fs.writeFile(markdownPath, renderMarkdown(report) + '\n', 'utf8');
  return { jsonPath, markdownPath };
}

export async function readLatestReport(outDir: string): Promise<EvalReport | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(outDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const jsonFiles = entries.filter((e) => e.endsWith('.json')).sort();
  const last = jsonFiles[jsonFiles.length - 1];
  if (!last) return null;
  const raw = await fs.readFile(path.join(outDir, last), 'utf8');
  return JSON.parse(raw) as EvalReport;
}
