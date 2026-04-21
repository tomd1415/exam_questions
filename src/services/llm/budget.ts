// Chunk 3g. Projection and banding for the cost dashboard. The
// dashboard never renders the budget as a single number — it shows a
// red/amber/green band so a glance conveys the verdict. The band
// thresholds live here so the template stays dumb.
//
// Projection is a naive linear scale from a windowed spend to the
// calendar month. Good enough for the pilot: we just need to know
// whether the current rate is trending past the cap. The nightly
// eval harness (chunk 3h) is where we get model-by-model detail; the
// dashboard is a health-check surface.

export type BudgetBand = 'green' | 'amber' | 'red';

export interface BudgetVerdict {
  readonly projectedPence: number;
  readonly budgetPence: number;
  readonly percentOfBudget: number;
  readonly band: BudgetBand;
}

// Project a window's spend onto a calendar month (30 days), proportional
// to the window's duration. Returns 0 if the window is empty or the
// spend is zero — a zero-budget deploy would be a config error caught
// by Zod in config.ts, so we don't defend against that here.
export function projectMonthlyPence(
  windowPence: number,
  windowStart: Date,
  windowEnd: Date,
): number {
  const windowMs = windowEnd.getTime() - windowStart.getTime();
  if (windowMs <= 0 || windowPence <= 0) return 0;
  const monthMs = 30 * 24 * 60 * 60 * 1000;
  return Math.round((windowPence / windowMs) * monthMs);
}

// Red/amber/green bands from the plan: projected × 1.0 / 1.2 / 1.5.
// Read as: under budget → green; up to 20% over → amber; anything
// worse → red. The plan phrases the bands around `projected` but the
// comparison only makes sense against the budget cap, so:
//   projected ≤ budget            → green
//   budget < projected ≤ 1.2×     → amber
//   projected > 1.2×              → red
// The 1.5× factor in the plan is a hold-out for the alerting
// threshold (Phase 3.1) not a third visual band.
export function bandFor(projectedPence: number, budgetPence: number): BudgetBand {
  if (projectedPence <= budgetPence) return 'green';
  if (projectedPence <= Math.round(budgetPence * 1.2)) return 'amber';
  return 'red';
}

export function budgetVerdict(
  windowPence: number,
  windowStart: Date,
  windowEnd: Date,
  budgetPence: number,
): BudgetVerdict {
  const projectedPence = projectMonthlyPence(windowPence, windowStart, windowEnd);
  const percentOfBudget = budgetPence > 0 ? Math.round((projectedPence / budgetPence) * 100) : 0;
  return {
    projectedPence,
    budgetPence,
    percentOfBudget,
    band: bandFor(projectedPence, budgetPence),
  };
}

export function formatPence(pence: number): string {
  const pounds = (pence / 100).toFixed(2);
  return `£${pounds}`;
}
