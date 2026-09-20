import { describe, expect, it } from 'vitest';
import { CostTracker, estimateCostUsd } from '@acr/ai';
import type { CostRates, CostRecord } from '@acr/ai';
import type { TokenUsage } from '@acr/ai';
import { BudgetExceededError, BudgetTracker } from '@acr/shared';
import type { BudgetLimits } from '@acr/shared';

const RATES: CostRates = { inputPer1kUsd: 0.01, outputPer1kUsd: 0.03 };

const usage = (inputTokens: number, outputTokens: number): TokenUsage => ({ inputTokens, outputTokens });

describe('estimateCostUsd arithmetic (USD per 1K tokens)', () => {
  it('computes round numbers exactly', () => {
    expect(estimateCostUsd(usage(1000, 2000), RATES)).toBe(0.07);
    expect(estimateCostUsd(usage(5000, 0), RATES)).toBe(0.05);
    expect(estimateCostUsd(usage(0, 1000), RATES)).toBe(0.03);
  });

  it('computes non-round numbers exactly to six decimals', () => {
    // 1234/1000 * 0.000123 = 0.000151782 -> round(151.782) = 152 -> 0.000152
    expect(estimateCostUsd(usage(1234, 0), { inputPer1kUsd: 0.000123, outputPer1kUsd: 0 })).toBe(0.000152);
    // 333/1000 * 0.067 = 0.022311 exactly at the sixth decimal
    expect(estimateCostUsd(usage(0, 333), { inputPer1kUsd: 0, outputPer1kUsd: 0.067 })).toBe(0.022311);
  });

  it('returns zero for zero tokens in either or both directions', () => {
    expect(estimateCostUsd(usage(0, 0), RATES)).toBe(0);
    expect(estimateCostUsd(usage(1234, 0), { inputPer1kUsd: 0, outputPer1kUsd: 0 })).toBe(0);
  });

  it('sums input and output sides independently', () => {
    // 250/1000 * 0.01 = 0.0025 and 750/1000 * 0.03 = 0.0225 -> total 0.025
    expect(estimateCostUsd(usage(250, 750), RATES)).toBe(0.025);
  });

  it('rounds to micro-dollars (6 decimals), half-up for positive totals', () => {
    // 15/1000 * 0.0001 = 0.0000015 -> half-up -> 0.000002
    expect(estimateCostUsd(usage(15, 0), { inputPer1kUsd: 0.0001, outputPer1kUsd: 0 })).toBe(0.000002);
    // 5/1000 * 0.0001 = 0.0000005 -> half-up -> 0.000001
    expect(estimateCostUsd(usage(5, 0), { inputPer1kUsd: 0.0001, outputPer1kUsd: 0 })).toBe(0.000001);
    // Anything below half a micro-dollar rounds down to exactly zero. As-coded,
    // tiny but real costs can therefore vanish at this precision.
    expect(estimateCostUsd(usage(1, 0), { inputPer1kUsd: 0.0001, outputPer1kUsd: 0 })).toBe(0);
  });

  it('treats missing or unusable pricing as zero, never NaN', () => {
    const hostile: CostRates[] = [
      { inputPer1kUsd: Number.NaN, outputPer1kUsd: Number.NaN },
      { inputPer1kUsd: Number.POSITIVE_INFINITY, outputPer1kUsd: -5 },
      { inputPer1kUsd: -0.01, outputPer1kUsd: Number.NaN },
    ];
    for (const rates of hostile) {
      const cost = estimateCostUsd(usage(1000, 1000), rates);
      expect(cost).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(cost)).toBe(true);
      expect(Number.isNaN(cost)).toBe(false);
    }
    // One bad side never poisons the good side:
    expect(estimateCostUsd(usage(100, 100), { inputPer1kUsd: Number.NaN, outputPer1kUsd: 1 })).toBe(0.1);
  });

  it('clamps negative or non-finite token counts to zero on that side', () => {
    expect(estimateCostUsd(usage(-50, 10), RATES)).toBe(0.0003);
    expect(estimateCostUsd(usage(Number.NaN, 0), RATES)).toBe(0);
    expect(estimateCostUsd(usage(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY), RATES)).toBe(0);
  });

  it('never returns NaN, negative or Infinity for absurd finite inputs', () => {
    const absurd = estimateCostUsd(usage(1e308, 0), { inputPer1kUsd: 1e300, outputPer1kUsd: 0 });
    expect(Number.isFinite(absurd)).toBe(true);
    expect(absurd).toBe(Number.MAX_VALUE); // overflow saturates to the largest finite number
    // Finite but huge totals where the micro-dollar rounding itself would
    // overflow: the unrounded total is returned instead of Infinity.
    // 1e303/1000 * 1e6 = 1e306 (finite, but *1e6 for rounding = 1e312).
    const huge = estimateCostUsd(usage(1e303, 0), { inputPer1kUsd: 1e6, outputPer1kUsd: 0 });
    expect(Number.isFinite(huge)).toBe(true);
    expect(huge).toBe(1e306);
    expect(estimateCostUsd(usage(1234, 5678), RATES)).toBeGreaterThanOrEqual(0);
  });
});

describe('CostTracker accumulation', () => {
  it('records a call and reports the exact per-record shape', () => {
    const tracker = new CostTracker(RATES);
    const record = tracker.record('ai_review:turn1', 'gpt-test', usage(1000, 500));
    expect(record).toEqual({
      usage: usage(1000, 500),
      estimatedCostUsd: 0.025,
      model: 'gpt-test',
      node: 'ai_review:turn1',
    });
    expect(record.estimatedCostUsd).toBe(estimateCostUsd(record.usage, RATES));
  });

  it('sums usage across multiple model calls exactly', () => {
    const tracker = new CostTracker(RATES);
    tracker.record('n1', 'm', usage(1000, 500)); // 0.025
    tracker.record('n2', 'm', usage(2000, 1000)); // 0.05
    tracker.record('n3', 'm', usage(0, 0)); // 0
    expect(tracker.totalTokensIn).toBe(3000);
    expect(tracker.totalTokensOut).toBe(1500);
    expect(tracker.totalTokens).toBe(4500);
    expect(tracker.totalCostUsd).toBeCloseTo(0.075, 12);
  });

  it('totals the sum of already-rounded per-record costs (float drift included)', () => {
    // As-coded: totalCostUsd does NOT re-round, so classic binary drift shows.
    const tracker = new CostTracker({ inputPer1kUsd: 0.01, outputPer1kUsd: 0 });
    tracker.record('a', 'm', usage(1000, 0)); // 0.01
    tracker.record('b', 'm', usage(20000, 0)); // 0.2
    expect(tracker.totalCostUsd).toBe(0.01 + 0.2);
    expect(tracker.totalCostUsd.toFixed(3)).toBe('0.210'); // consumers render to 3 decimals
  });

  it('never lets poisoned usage corrupt the running token totals', () => {
    const tracker = new CostTracker(RATES);
    tracker.record('bad', 'm', usage(Number.NaN, -10));
    expect(tracker.totalTokensIn).toBe(0);
    expect(tracker.totalTokensOut).toBe(0);
    expect(tracker.totalCostUsd).toBe(0);
    // The raw usage object is still stored verbatim on the record for auditing.
    const snapshot = tracker.snapshot();
    expect(snapshot).toHaveLength(1);
    const stored = snapshot[0];
    expect(stored).toBeDefined();
    expect(stored?.usage.inputTokens).toBeNaN();
    expect(stored?.usage.outputTokens).toBe(-10);
    tracker.record('good', 'm', usage(1000, 0));
    expect(tracker.totalTokensIn).toBe(1000);
  });

  it('saturates the ledger instead of returning Infinity', () => {
    const tracker = new CostTracker({ inputPer1kUsd: 1e300, outputPer1kUsd: 0 });
    tracker.record('a', 'm', usage(1e308, 0)); // each saturates to MAX_VALUE
    tracker.record('b', 'm', usage(1e308, 0));
    expect(tracker.totalCostUsd).toBe(Number.MAX_VALUE);
    expect(Number.isFinite(tracker.totalCostUsd)).toBe(true);
  });

  it('snapshot returns a copy that later records do not mutate', () => {
    const tracker = new CostTracker(RATES);
    tracker.record('a', 'm', usage(100, 100));
    const snap = tracker.snapshot();
    tracker.record('b', 'm', usage(200, 200));
    expect(snap).toHaveLength(1);
    expect(tracker.snapshot()).toHaveLength(2);
    expect(snap[1]?.node).toBeUndefined();
  });
});

describe('budget interaction', () => {
  const LIMITS: BudgetLimits = {
    maxDurationMs: 10_000,
    maxFiles: 5,
    maxTokens: 1_000,
    maxToolCalls: 8,
    maxAgentIterations: 3,
    maxDiffBytes: 50_000,
    maxFileBytes: 2_000,
  };

  function trackerWithBudget(clock: { t: number }): BudgetTracker {
    return new BudgetTracker(LIMITS, { now: () => clock.t });
  }

  it('cost totals feed the budget, which trips at > the cap, not at it', () => {
    const costs = new CostTracker(RATES);
    const clock = { t: 0 };
    const budget = trackerWithBudget(clock);
    costs.record('n', 'm', usage(600, 400));
    budget.addTokens(costs.totalTokens);
    expect(budget.isExhausted()).toBe(false); // exactly at maxTokens is still OK
    costs.record('n', 'm', usage(1, 0));
    budget.addTokens(1);
    expect(budget.isExhausted()).toBe(true); // boundary is strict `>`
  });

  it('the caller can tell WHICH limit tripped via the error label', () => {
    const clock = { t: 0 };
    const budget = trackerWithBudget(clock);
    budget.addTokens(1_001);
    let thrown: unknown;
    try {
      budget.assertCanContinue();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BudgetExceededError);
    expect((thrown as BudgetExceededError).limit).toBe('max_tokens');
    expect((thrown as Error).message).toBe('Review budget exceeded: max_tokens');
  });

  it('duration and token caps are both strict `>` boundaries', () => {
    const clock = { t: 0 };
    const budget = trackerWithBudget(clock);
    budget.addTokens(1_000);
    clock.t = 10_000; // exactly the duration cap: not exhausted
    expect(budget.isExhausted()).toBe(false);
    clock.t = 10_001;
    expect(budget.isExhausted()).toBe(true);
    expect(budget.exceededError()?.limit).toBe('max_duration_ms');
  });

  it('a tripped budget still leaves cost accounting usable and finite', () => {
    const costs = new CostTracker(RATES);
    const clock = { t: 0 };
    const budget = trackerWithBudget(clock);
    budget.addTokens(999_999);
    costs.record('final', 'm', usage(10, 5));
    expect(budget.isExhausted()).toBe(true);
    expect(costs.totalCostUsd).toBeGreaterThan(0);
    expect(Number.isFinite(costs.totalCostUsd)).toBe(true);
    expect(costs.snapshot().map((r: CostRecord) => r.node)).toEqual(['final']);
  });
});
