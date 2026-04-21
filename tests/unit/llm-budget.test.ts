import { describe, expect, it } from 'vitest';
import {
  bandFor,
  budgetVerdict,
  formatPence,
  projectMonthlyPence,
} from '../../src/services/llm/budget.js';

// Chunk 3g. Projection and banding belong in a pure module so the
// cost dashboard is a lookup, not a compute. The band thresholds are
// specified in PHASE3_PLAN.md §5 chunk 3g — 1.0×/1.2×/1.5× — and this
// test is the one place the rule is normalised.

describe('projectMonthlyPence', () => {
  it('extrapolates proportionally to a 30-day month', () => {
    const start = new Date('2026-04-01T00:00:00Z');
    const end = new Date('2026-04-08T00:00:00Z'); // 7 days
    // £1.40 in 7 days → 30/7 × 140p ≈ 600p
    expect(projectMonthlyPence(140, start, end)).toBe(600);
  });

  it('returns 0 for an empty window or zero spend', () => {
    const t = new Date('2026-04-01T00:00:00Z');
    expect(projectMonthlyPence(0, t, new Date(t.getTime() + 1000))).toBe(0);
    expect(projectMonthlyPence(100, t, t)).toBe(0);
    expect(projectMonthlyPence(100, t, new Date(t.getTime() - 1000))).toBe(0);
  });
});

describe('bandFor', () => {
  const budget = 2000;

  it('returns green when projected ≤ budget', () => {
    expect(bandFor(0, budget)).toBe('green');
    expect(bandFor(budget - 1, budget)).toBe('green');
    expect(bandFor(budget, budget)).toBe('green');
  });

  it('returns amber when projected is up to 1.2× the budget', () => {
    expect(bandFor(budget + 1, budget)).toBe('amber');
    expect(bandFor(Math.round(budget * 1.2), budget)).toBe('amber');
  });

  it('returns red when projected exceeds 1.2× the budget', () => {
    expect(bandFor(Math.round(budget * 1.2) + 1, budget)).toBe('red');
    expect(bandFor(budget * 5, budget)).toBe('red');
  });
});

describe('budgetVerdict', () => {
  it('combines projection + band + percent-of-budget (amber case)', () => {
    const start = new Date('2026-04-01T00:00:00Z');
    const end = new Date('2026-04-08T00:00:00Z'); // 7 days
    // £6 in 7 days projects to ~£25.71 → amber against a £25 budget
    // (projection ≤ 1.2× = £30 but > budget).
    const verdict = budgetVerdict(600, start, end, 2500);
    expect(verdict.projectedPence).toBeGreaterThan(2500);
    expect(verdict.projectedPence).toBeLessThanOrEqual(Math.round(2500 * 1.2));
    expect(verdict.band).toBe('amber');
    expect(verdict.percentOfBudget).toBeGreaterThanOrEqual(100);
    expect(verdict.budgetPence).toBe(2500);
  });

  it('bands red when the window projects well above 1.2× budget', () => {
    const start = new Date('2026-04-01T00:00:00Z');
    const end = new Date('2026-04-08T00:00:00Z'); // 7 days
    // £6 in 7 days projects to ~£25.71 → red against a £20 budget
    // (1.2× = £24, projection > that).
    const verdict = budgetVerdict(600, start, end, 2000);
    expect(verdict.band).toBe('red');
  });

  it('handles a zero-spend window cleanly (green, 0%)', () => {
    const start = new Date('2026-04-01T00:00:00Z');
    const end = new Date('2026-04-08T00:00:00Z');
    const verdict = budgetVerdict(0, start, end, 2000);
    expect(verdict.projectedPence).toBe(0);
    expect(verdict.band).toBe('green');
    expect(verdict.percentOfBudget).toBe(0);
  });
});

describe('formatPence', () => {
  it('renders integer pence as two-decimal pounds', () => {
    expect(formatPence(0)).toBe('£0.00');
    expect(formatPence(5)).toBe('£0.05');
    expect(formatPence(100)).toBe('£1.00');
    expect(formatPence(2575)).toBe('£25.75');
  });
});
