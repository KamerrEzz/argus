import type { TokenUsage } from './provider/types';

export interface CostRates {
  /** USD per 1,000 completion/input tokens. */
  readonly inputPer1kUsd: number;
  readonly outputPer1kUsd: number;
}

export interface CostRecord {
  readonly usage: TokenUsage;
  readonly estimatedCostUsd: number;
  readonly model: string;
  readonly node: string;
}

/**
 * Non-finite or negative amounts (an unset model price surfacing as undefined,
 * a provider reporting negative usage) must never poison the ledger: they are
 * clamped to zero so a cost is either a real positive number or nothing.
 */
function safeAmount(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Cost accounting is deliberately arithmetic and transparent: rates come from
 * configuration, so an unexpected price never silently changes behaviour.
 */
export function estimateCostUsd(usage: TokenUsage, rates: CostRates): number {
  const input = (safeAmount(usage.inputTokens) / 1000) * safeAmount(rates.inputPer1kUsd);
  const output = (safeAmount(usage.outputTokens) / 1000) * safeAmount(rates.outputPer1kUsd);
  const total = input + output;
  if (!Number.isFinite(total)) {
    return Number.MAX_VALUE;
  }
  // Rounding to micro-dollars can overflow for absurd-but-finite totals; those
  // are already far past any rounding granularity, so return them unrounded.
  const scaled = total * 1_000_000;
  return Number.isFinite(scaled) ? Math.round(scaled) / 1_000_000 : total;
}

export class CostTracker {
  private readonly rates: CostRates;
  private readonly records: CostRecord[] = [];
  private inputTokens = 0;
  private outputTokens = 0;

  constructor(rates: CostRates) {
    this.rates = rates;
  }

  record(node: string, model: string, usage: TokenUsage): CostRecord {
    const record: CostRecord = { usage, model, node, estimatedCostUsd: estimateCostUsd(usage, this.rates) };
    // Same anti-poisoning rule as costs: a provider sending NaN or negative
    // usage must not corrupt the running totals that feed budget accounting.
    this.inputTokens += safeAmount(usage.inputTokens);
    this.outputTokens += safeAmount(usage.outputTokens);
    this.records.push(record);
    return record;
  }

  get totalTokensIn(): number {
    return this.inputTokens;
  }

  get totalTokensOut(): number {
    return this.outputTokens;
  }

  get totalTokens(): number {
    return this.inputTokens + this.outputTokens;
  }

  get totalCostUsd(): number {
    const total = this.records.reduce((sum, record) => sum + record.estimatedCostUsd, 0);
    return Number.isFinite(total) ? total : Number.MAX_VALUE;
  }

  snapshot(): readonly CostRecord[] {
    return [...this.records];
  }
}
