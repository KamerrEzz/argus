import { describe, expect, it } from 'vitest';
import { BudgetTracker, type BudgetLimits } from '@acr/shared';
import { AppError, BudgetExceededError } from '@acr/shared';

const LIMITS: BudgetLimits = {
  maxDurationMs: 10_000,
  maxFiles: 5,
  maxTokens: 1_000,
  maxToolCalls: 8,
  maxAgentIterations: 3,
  maxDiffBytes: 50_000,
  maxFileBytes: 2_000,
};

/** A tracker whose clock is fully scripted: `start` t0, `elapsed` ms after it. */
function trackerWith(limits: BudgetLimits, clock: { t: number }) {
  return new BudgetTracker(limits, { now: () => clock.t });
}

describe('BudgetTracker recording', () => {
  it('starts at zero with the full budget remaining', () => {
    const tracker = trackerWith(LIMITS, { t: 0 });
    const snapshot = tracker.snapshot();
    expect(snapshot.filesAnalyzed).toBe(0);
    expect(snapshot.toolCalls).toBe(0);
    expect(snapshot.tokensUsed).toBe(0);
    expect(snapshot.iterations).toBe(0);
    expect(snapshot.elapsedMs).toBe(0);
    expect(snapshot.remaining).toEqual({ files: 5, toolCalls: 8, tokens: 1_000, iterations: 3, durationMs: 10_000 });
  });

  it('accumulates counters, defaulting to increments of one', () => {
    const tracker = trackerWith(LIMITS, { t: 0 });
    tracker.recordIteration();
    tracker.recordIteration(4);
    tracker.recordToolCall(2);
    tracker.recordFile(3);
    const snapshot = tracker.snapshot();
    expect(snapshot.iterations).toBe(5);
    expect(snapshot.toolCalls).toBe(2);
    expect(snapshot.filesAnalyzed).toBe(3);
    expect(snapshot.remaining.iterations).toBe(0);
    expect(snapshot.remaining.files).toBe(2);
  });

  it('addTokens ignores zero and negative values (no token laundering)', () => {
    const tracker = trackerWith(LIMITS, { t: 0 });
    tracker.addTokens(0);
    tracker.addTokens(-500);
    expect(tracker.snapshot().tokensUsed).toBe(0);
    tracker.addTokens(600);
    expect(tracker.snapshot().tokensUsed).toBe(600);
  });

  it('elapsed time is driven by the injected clock and never negative', () => {
    const clock = { t: 1_000 };
    const tracker = trackerWith(LIMITS, clock);
    clock.t = 2_500;
    expect(tracker.elapsedMs()).toBe(1_500);
    clock.t = 900; // clock skew backwards must not produce negative elapsed
    expect(tracker.elapsedMs()).toBe(0);
  });

  it('remaining floors at zero even far past the limit', () => {
    const tracker = trackerWith(LIMITS, { t: 0 });
    tracker.addTokens(9_999_999);
    tracker.recordFile(100);
    const { remaining } = tracker.snapshot();
    expect(remaining.tokens).toBe(0);
    expect(remaining.files).toBe(0);
  });
});

describe('BudgetTracker cap flags', () => {
  it('a counter exactly AT the limit is NOT exceeded (caps are strict >)', () => {
    const tracker = trackerWith(LIMITS, { t: 0 });
    tracker.addTokens(1_000);
    tracker.recordToolCall(8);
    tracker.recordIteration(3);
    tracker.recordFile(5);
    tracker.check();
    expect(tracker.exceededError()).toBeNull();
    expect(tracker.isExhausted()).toBe(false);
  });

  it('each cap raises its own distinct limit flag', () => {
    const cases: { name: string; record: (t: BudgetTracker) => void; limit: string }[] = [
      { name: 'files', record: (t) => t.recordFile(6), limit: 'max_files' },
      { name: 'tokens', record: (t) => t.addTokens(1_001), limit: 'max_tokens' },
      { name: 'tool calls', record: (t) => t.recordToolCall(9), limit: 'max_tool_calls' },
      { name: 'iterations', record: (t) => t.recordIteration(4), limit: 'max_agent_iterations' },
    ];
    for (const { record, limit } of cases) {
      const tracker = trackerWith(LIMITS, { t: 0 });
      record(tracker);
      expect(tracker.isExhausted(), `expected exhaustion for ${limit}`).toBe(true);
      expect(tracker.exceededError()?.limit).toBe(limit);
    }
  });

  it('duration trips only when elapsed is strictly greater than the cap', () => {
    const clock = { t: 0 };
    const tracker = trackerWith(LIMITS, clock);
    clock.t = LIMITS.maxDurationMs;
    expect(tracker.isExhausted()).toBe(false);
    clock.t = LIMITS.maxDurationMs + 1;
    expect(tracker.isExhausted()).toBe(true);
    expect(tracker.exceededError()?.limit).toBe('max_duration_ms');
  });

  it('checkFiles accepts a prospective increment to pre-flight the next file', () => {
    const tracker = trackerWith(LIMITS, { t: 0 });
    tracker.recordFile(5);
    tracker.checkFiles(); // at the cap: fine
    expect(tracker.exceededError()).toBeNull();
    tracker.checkFiles(1); // one more would cross the cap
    expect(tracker.exceededError()?.limit).toBe('max_files');
  });

  it('isExhausted runs every check but reports the LAST tripped cap (source order in check())', () => {
    // check() evaluates duration, files, tokens, tool calls, iterations in that
    // order and each failing check overwrites `exceeded`, so with several caps
    // blown at once the iteration limit is the one surfaced.
    const tracker = trackerWith(LIMITS, { t: 0 });
    tracker.recordFile(10);
    tracker.addTokens(2_000);
    tracker.recordIteration(10);
    expect(tracker.isExhausted()).toBe(true);
    expect(tracker.exceededError()?.limit).toBe('max_agent_iterations');
  });

  it('assertCanContinue throws the recorded BudgetExceededError as an AppError', () => {
    const tracker = trackerWith(LIMITS, { t: 0 });
    tracker.addTokens(1_001);
    let thrown: unknown;
    try {
      tracker.assertCanContinue();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BudgetExceededError);
    expect(thrown).toBeInstanceOf(AppError);
    const appError = thrown as BudgetExceededError;
    expect(appError.code).toBe('budget_exceeded');
    expect(appError.httpStatus).toBe(422);
    expect(appError.retryable).toBe(false);
    expect(appError.message).toContain('max_tokens');
    expect(appError.details).toMatchObject({ tokensUsed: 1_001, maxTokens: 1_000 });
  });

  it('assertCanContinue is silent while inside every budget', () => {
    const tracker = trackerWith(LIMITS, { t: 0 });
    tracker.addTokens(999);
    expect(() => tracker.assertCanContinue()).not.toThrow();
  });
});

describe('BudgetTracker with zero/missing-style limits', () => {
  it('a limit of 0 is not tripped by equality: the tracker starts unexhausted at t0', () => {
    const zero: BudgetLimits = {
      maxDurationMs: 0,
      maxFiles: 0,
      maxTokens: 0,
      maxToolCalls: 0,
      maxAgentIterations: 0,
      maxDiffBytes: 0,
      maxFileBytes: 0,
    };
    const clock = { t: 0 };
    const tracker = trackerWith(zero, clock);
    // Strict `>` semantics: nothing has exceeded a zero budget yet.
    expect(tracker.isExhausted()).toBe(false);
    // Any real work flips the first checked non-duration cap: a single token
    // (1 > 0) trips max_tokens; duration only trips once the clock moves.
    tracker.addTokens(1);
    expect(tracker.isExhausted()).toBe(true);
    expect(tracker.exceededError()?.limit).toBe('max_tokens');
  });

  it('with all limits zero, advancing the clock by 1ms trips max_duration_ms first checked', () => {
    const zero: BudgetLimits = {
      maxDurationMs: 0,
      maxFiles: 0,
      maxTokens: 0,
      maxToolCalls: 0,
      maxAgentIterations: 0,
      maxDiffBytes: 0,
      maxFileBytes: 0,
    };
    const clock = { t: 0 };
    const tracker = trackerWith(zero, clock);
    clock.t = 1;
    tracker.check();
    // Duration trips (1 > 0); files/tokens/tool calls/iterations remain 0 == 0
    // so they do NOT overwrite the duration flag.
    expect(tracker.exceededError()?.limit).toBe('max_duration_ms');
  });

  it('limits are exposed verbatim on the tracker', () => {
    const tracker = new BudgetTracker(LIMITS);
    expect(tracker.limits).toBe(LIMITS);
  });
});

// NOTE: BudgetTracker has no cost accounting; USD cost lives in
// packages/ai/src/cost.ts (CostTracker) and is covered in packages/ai/test/cost.unit.test.ts.
// maxDiffBytes / maxFileBytes are transport-size limits enforced by callers,
// not by check() — asserting that check() ignores them:
describe('BudgetTracker scope', () => {
  it('check() never consults diff/file byte limits', () => {
    const tracker = trackerWith({ ...LIMITS, maxDiffBytes: 0, maxFileBytes: 0 }, { t: 0 });
    expect(tracker.isExhausted()).toBe(false);
  });
});
