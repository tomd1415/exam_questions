import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { readLatestReport } from '../services/eval/report.js';
import type { EvalReport } from '../services/eval/report.js';
import type { FixtureResult, PromptAggregate } from '../services/eval/scoring.js';

// Chunk 3h. Renders the most recent prompt-eval report as an admin
// page. The report is produced out-of-band by
// scripts/eval/run-prompt-evals.ts; this route only reads the
// newest JSON file on disk. That separation keeps the route honest:
// it can never accidentally drive LLM spend.

const DIRNAME = path.dirname(fileURLToPath(import.meta.url));
// Both dev (src/routes) and prod (dist/routes) reach ../../scripts/eval/out
// from their own directory, so the default resolves correctly either way.
const DEFAULT_OUT_DIR = path.resolve(DIRNAME, '..', '..', 'scripts', 'eval', 'out');

export interface RegisterAdminEvalsRoutesOptions {
  readonly outDir?: string;
}

function requireAdmin(
  req: FastifyRequest,
  reply: FastifyReply,
): { id: string; role: 'admin' } | null {
  if (!req.currentUser) {
    reply.redirect('/login');
    return null;
  }
  if (req.currentUser.role !== 'admin') {
    reply.code(403).send('Forbidden');
    return null;
  }
  return { id: req.currentUser.id, role: 'admin' };
}

interface AggregateView {
  promptName: string;
  promptVersion: string;
  fixtures: number;
  passed: number;
  failed: number;
  passRatePercent: number;
  passBand: 'green' | 'amber' | 'red';
  meanAbsoluteErrorFormatted: string;
  meanLatencyMsFormatted: string;
  totalCostFormatted: string;
  worstOffenders: readonly FixtureResultView[];
}

interface FixtureResultView {
  fixtureId: string;
  description: string;
  promptName: string;
  outcomeKind: string;
  marksAwarded: string;
  expectedRange: string;
  absoluteError: string;
  refused: boolean;
  refusalExpected: boolean;
  passed: boolean;
  failReasons: readonly string[];
}

function passBand(rate: number): 'green' | 'amber' | 'red' {
  if (rate >= 0.9) return 'green';
  if (rate >= 0.75) return 'amber';
  return 'red';
}

function toAggregateViews(aggs: readonly PromptAggregate[]): AggregateView[] {
  return aggs.map((a) => ({
    promptName: a.promptName,
    promptVersion: a.promptVersion ?? '(no active version)',
    fixtures: a.fixtures,
    passed: a.passed,
    failed: a.failed,
    passRatePercent: Math.round(a.passRate * 100),
    passBand: passBand(a.passRate),
    meanAbsoluteErrorFormatted: a.meanAbsoluteError === null ? '—' : a.meanAbsoluteError.toFixed(2),
    meanLatencyMsFormatted: a.meanLatencyMs === null ? '—' : `${a.meanLatencyMs.toFixed(0)} ms`,
    totalCostFormatted: `£${(a.totalCostPence / 100).toFixed(2)}`,
    worstOffenders: a.worstOffenders.map(toFixtureResultView),
  }));
}

function toFixtureResultView(r: FixtureResult): FixtureResultView {
  const [lo, hi] = r.expectedRange;
  return {
    fixtureId: r.fixtureId,
    description: r.description,
    promptName: r.promptName,
    outcomeKind: r.outcomeKind,
    marksAwarded: r.marksAwarded === null ? '—' : String(r.marksAwarded),
    expectedRange: lo === hi ? String(lo) : `${lo}–${hi}`,
    absoluteError: r.absoluteError === null ? '—' : String(r.absoluteError),
    refused: r.refused,
    refusalExpected: r.refusalExpected,
    passed: r.passed,
    failReasons: r.failReasons,
  };
}

interface LatestView {
  generatedAt: string;
  totals: EvalReport['totals'];
  totalsPassBand: 'green' | 'amber' | 'red';
  totalsPassRatePercent: number;
  totalCostFormatted: string;
  aggregates: readonly AggregateView[];
  failures: readonly FixtureResultView[];
}

function toLatestView(report: EvalReport): LatestView {
  const totalsPassBand = passBand(report.totals.passRate);
  return {
    generatedAt: report.generatedAt,
    totals: report.totals,
    totalsPassBand,
    totalsPassRatePercent: Math.round(report.totals.passRate * 100),
    totalCostFormatted: `£${(report.totals.totalCostPence / 100).toFixed(2)}`,
    aggregates: toAggregateViews(report.aggregates),
    failures: report.results.filter((r) => !r.passed).map(toFixtureResultView),
  };
}

export function registerAdminEvalsRoutes(
  app: FastifyInstance,
  opts: RegisterAdminEvalsRoutesOptions = {},
): void {
  app.get('/admin/evals/latest', async (req, reply) => {
    const actor = requireAdmin(req, reply);
    if (!actor) return reply;

    // Resolve lazily so tests can point the route at a temp dir via
    // EVAL_OUT_DIR without having to rebuild the app. Production reads
    // the default alongside the repo-root scripts/eval/out.
    const outDir = opts.outDir ?? process.env['EVAL_OUT_DIR'] ?? DEFAULT_OUT_DIR;

    const report = await readLatestReport(outDir);
    return reply.view('admin_evals_latest.eta', {
      title: 'Prompt eval — latest run',
      currentUser: req.currentUser,
      csrfToken: reply.generateCsrf(),
      report: report ? toLatestView(report) : null,
      outDir,
    });
  });
}
