import { BudgetExceededError } from './errors';

export interface BudgetLimits {
  readonly maxDurationMs: number;
  readonly maxFiles: number;
  readonly maxTokens: number;
  readonly maxToolCalls: number;
  readonly maxAgentIterations: number;
  readonly maxDiffBytes: number;
  readonly maxFileBytes: number;
}

export interface BudgetSnapshot {
  readonly filesAnalyzed: number;
  readonly toolCalls: number;
  readonly tokensUsed: number;
  readonly iterations: number;
  readonly elapsedMs: number;
  readonly remaining: {
    readonly files: number;
    readonly toolCalls: number;
    readonly tokens: number;
    readonly iterations: number;
    readonly durationMs: number;
  };
}

export interface BudgetTrackerOptions {
  readonly now?: () => number;
}

export class BudgetTracker {
  readonly limits: BudgetLimits;
  private readonly now: () => number;
  private readonly startedAt: number;
  private filesAnalyzed = 0;
  private toolCalls = 0;
  private tokensUsed = 0;
  private iterations = 0;
  private exceeded: BudgetExceededError | null = null;

  constructor(limits: BudgetLimits, options: BudgetTrackerOptions = {}) {
    this.limits = limits;
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
  }

  recordIteration(count = 1): void {
    this.iterations += count;
  }

  recordToolCall(count = 1): void {
    this.toolCalls += count;
  }

  recordFile(count = 1): void {
    this.filesAnalyzed += count;
  }

  addTokens(count: number): void {
    if (count > 0) {
      this.tokensUsed += count;
    }
  }

  elapsedMs(): number {
    return Math.max(0, this.now() - this.startedAt);
  }

  snapshot(): BudgetSnapshot {
    return {
      filesAnalyzed: this.filesAnalyzed,
      toolCalls: this.toolCalls,
      tokensUsed: this.tokensUsed,
      iterations: this.iterations,
      elapsedMs: this.elapsedMs(),
      remaining: {
        files: Math.max(0, this.limits.maxFiles - this.filesAnalyzed),
        toolCalls: Math.max(0, this.limits.maxToolCalls - this.toolCalls),
        tokens: Math.max(0, this.limits.maxTokens - this.tokensUsed),
        iterations: Math.max(0, this.limits.maxAgentIterations - this.iterations),
        durationMs: Math.max(0, this.limits.maxDurationMs - this.elapsedMs()),
      },
    };
  }

  checkDuration(): void {
    if (this.elapsedMs() > this.limits.maxDurationMs) {
      this.exceeded = new BudgetExceededError('max_duration_ms', {
        elapsedMs: this.elapsedMs(),
        maxDurationMs: this.limits.maxDurationMs,
      });
    }
  }

  checkFiles(nextIncrement = 0): void {
    if (this.filesAnalyzed + nextIncrement > this.limits.maxFiles) {
      this.exceeded = new BudgetExceededError('max_files', {
        filesAnalyzed: this.filesAnalyzed,
        maxFiles: this.limits.maxFiles,
      });
    }
  }

  checkTokens(): void {
    if (this.tokensUsed > this.limits.maxTokens) {
      this.exceeded = new BudgetExceededError('max_tokens', {
        tokensUsed: this.tokensUsed,
        maxTokens: this.limits.maxTokens,
      });
    }
  }

  checkToolCalls(): void {
    if (this.toolCalls > this.limits.maxToolCalls) {
      this.exceeded = new BudgetExceededError('max_tool_calls', {
        toolCalls: this.toolCalls,
        maxToolCalls: this.limits.maxToolCalls,
      });
    }
  }

  checkIterations(): void {
    if (this.iterations > this.limits.maxAgentIterations) {
      this.exceeded = new BudgetExceededError('max_agent_iterations', {
        iterations: this.iterations,
        maxAgentIterations: this.limits.maxAgentIterations,
      });
    }
  }

  check(): void {
    this.checkDuration();
    this.checkFiles();
    this.checkTokens();
    this.checkToolCalls();
    this.checkIterations();
  }

  exceededError(): BudgetExceededError | null {
    return this.exceeded;
  }

  isExhausted(): boolean {
    this.check();
    return this.exceeded !== null;
  }

  assertCanContinue(): void {
    this.check();
    if (this.exceeded !== null) {
      throw this.exceeded;
    }
  }
}
