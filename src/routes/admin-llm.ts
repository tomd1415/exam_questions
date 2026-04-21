import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import type { LlmCostRollupRow } from '../repos/llm_calls.js';
import { budgetVerdict, formatPence, type BudgetVerdict } from '../services/llm/budget.js';

// Chunk 3g. Cost dashboard. Admin-only. Reads the last 7 days and
// month-to-date windows from llm_calls, projects each onto a full
// calendar month, and renders a band against the configured cap.
// No caching: the table is small (row per call, maybe a few hundred a
// week during the pilot) and the admin visits this page once a day.

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

interface CostCardView {
  label: string;
  windowStart: Date;
  windowEnd: Date;
  totalPence: number;
  totalPenceFormatted: string;
  totalCalls: number;
  totalOkCalls: number;
  perPrompt: readonly CostRowView[];
  verdict: BudgetVerdict;
  verdictFormatted: {
    projectedFormatted: string;
    budgetFormatted: string;
  };
}

interface CostRowView {
  prompt_name: string;
  prompt_version: string;
  model_id: string;
  calls: number;
  ok_calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_pence: number;
  cost_formatted: string;
}

function sumPence(rows: readonly LlmCostRollupRow[]): number {
  let total = 0;
  for (const r of rows) total += r.cost_pence;
  return total;
}

function sumCalls(rows: readonly LlmCostRollupRow[]): { calls: number; ok: number } {
  let calls = 0;
  let ok = 0;
  for (const r of rows) {
    calls += r.calls;
    ok += r.ok_calls;
  }
  return { calls, ok };
}

function toRowViews(rows: readonly LlmCostRollupRow[]): CostRowView[] {
  return rows.map((r) => ({
    prompt_name: r.prompt_name,
    prompt_version: r.prompt_version,
    model_id: r.model_id,
    calls: r.calls,
    ok_calls: r.ok_calls,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    cost_pence: r.cost_pence,
    cost_formatted: formatPence(r.cost_pence),
  }));
}

function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function registerAdminLlmRoutes(app: FastifyInstance): void {
  app.get('/admin/llm/costs', async (req, reply) => {
    const actor = requireAdmin(req, reply);
    if (!actor) return reply;

    const now = new Date();
    const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const mStart = monthStart(now);
    const budgetPence = config.MONTHLY_LLM_BUDGET_PENCE;

    const [weekRows, monthRows] = await Promise.all([
      app.repos.llmCalls.rollupBetween(weekStart, now),
      app.repos.llmCalls.rollupBetween(mStart, now),
    ]);

    const weekPence = sumPence(weekRows);
    const monthPence = sumPence(monthRows);
    const weekCalls = sumCalls(weekRows);
    const monthCalls = sumCalls(monthRows);

    const weekVerdict = budgetVerdict(weekPence, weekStart, now, budgetPence);
    const monthVerdict = budgetVerdict(monthPence, mStart, now, budgetPence);

    const cards: CostCardView[] = [
      {
        label: 'Last 7 days',
        windowStart: weekStart,
        windowEnd: now,
        totalPence: weekPence,
        totalPenceFormatted: formatPence(weekPence),
        totalCalls: weekCalls.calls,
        totalOkCalls: weekCalls.ok,
        perPrompt: toRowViews(weekRows),
        verdict: weekVerdict,
        verdictFormatted: {
          projectedFormatted: formatPence(weekVerdict.projectedPence),
          budgetFormatted: formatPence(weekVerdict.budgetPence),
        },
      },
      {
        label: 'Month to date',
        windowStart: mStart,
        windowEnd: now,
        totalPence: monthPence,
        totalPenceFormatted: formatPence(monthPence),
        totalCalls: monthCalls.calls,
        totalOkCalls: monthCalls.ok,
        perPrompt: toRowViews(monthRows),
        verdict: monthVerdict,
        verdictFormatted: {
          projectedFormatted: formatPence(monthVerdict.projectedPence),
          budgetFormatted: formatPence(monthVerdict.budgetPence),
        },
      },
    ];

    return reply.view('admin_llm_costs.eta', {
      title: 'LLM costs',
      currentUser: req.currentUser,
      csrfToken: reply.generateCsrf(),
      cards,
      budgetFormatted: formatPence(budgetPence),
      generatedAt: now,
    });
  });
}
