import { describe, expect, it } from 'vitest';
import { ReviewGraphState } from '@acr/ai';
import type { FindingDraft, InjectionSignal } from '@acr/shared';
import { FindingDraftSchema } from '@acr/shared';

/**
 * The state channels are the graph's only mutable surface. These tests exercise
 * the real LangGraph channel objects behind `ReviewGraphState`, replicating the
 * way Pregel applies writes: for every step, each channel that received a write
 * gets `update(values)` with the list of that step's writes; every other
 * channel is untouched (or receives `update([])`, which must be a no-op).
 */

interface TestChannel {
  update(values: unknown[]): boolean;
  get(): unknown;
}

/** A fresh, isolated copy of every channel, seeded with its declared default. */
function freshChannels(): Record<string, TestChannel> {
  const channels: Record<string, TestChannel> = {};
  for (const [key, channel] of Object.entries(ReviewGraphState.spec)) {
    channels[key] = channel.fromCheckpoint();
  }
  return channels;
}

/** Apply one graph step: `writes[key]` is the list of values written that step. */
function applyStep(channels: Record<string, TestChannel>, writes: Record<string, unknown[]>): void {
  for (const [key, values] of Object.entries(writes)) {
    const channel = channels[key];
    if (channel === undefined) {
      throw new Error(`unknown channel: ${key}`);
    }
    channel.update(values);
  }
}

function readState(channels: Record<string, TestChannel>): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  for (const [key, channel] of Object.entries(channels)) {
    state[key] = channel.get();
  }
  return state;
}

const draft = (title: string): FindingDraft =>
  FindingDraftSchema.parse({
    severity: 'medium',
    category: 'bug',
    title,
    description: 'A concrete description long enough to satisfy the schema.',
    file: 'src/service.ts',
    line: 12,
    confidence: 0.9,
    source: 'agent',
  });

/**
 * Every state key written by the graph at runtime, as read from
 * `src/runner.ts` (initial input) and the `return {...}` blocks of
 * `src/nodes/{context,analysis,review,finalize,instrument}.ts`.
 */
const NODE_WRITTEN_KEYS: readonly string[] = [
  'reviewRunId', 'agentExecutionId', 'trigger', 'headSha', 'baseSha', // runner input
  'pullRequest', 'changedFiles', 'diff', 'workspaceDir', 'injectionSignals', 'warnings', // load_pr / inspect_repo
  'fileInventory', // inspect_repo
  'classification', // analyze_changes
  'plan', // determine_checks
  'commands', // run_checks
  'analyses', 'findings', // static_analysis
  'transcript', 'tokensIn', 'tokensOut', 'iteration', 'stoppedReason', 'summary', // ai_review
  'validated', // validate_findings
  'verdict', 'narrative', // final_review
  'nodeTrace', // instrumentNode wrapper
  'skipped', // skippedNode
];

describe('ReviewGraphState channel set', () => {
  it('exposes exactly the channels the graph reads and writes', () => {
    expect(Object.keys(ReviewGraphState.spec).sort()).toEqual(
      [...NODE_WRITTEN_KEYS, 'budgetExhausted'].sort(),
    );
  });

  it('every key any node writes is a declared channel', () => {
    const channels = Object.keys(ReviewGraphState.spec);
    for (const key of NODE_WRITTEN_KEYS) {
      expect(channels, `channel for "${key}"`).toContain(key);
    }
  });

  it('budgetExhausted is a declared channel that no node writes', () => {
    // As-coded: the runner READS `values.budgetExhausted` (runner.ts) to decide
    // a 'partial' outcome, but no node in src/nodes/* ever returns that key —
    // budget exhaustion is signalled by a thrown BudgetExceededError instead.
    // The channel therefore keeps its default `false` for the whole run.
    expect(Object.keys(ReviewGraphState.spec)).toContain('budgetExhausted');
    expect(NODE_WRITTEN_KEYS).not.toContain('budgetExhausted');
  });
});

describe('field channels (last-write-wins replacement)', () => {
  it('starts from its declared default', () => {
    const channels = freshChannels();
    const head = channels['headSha'];
    expect(head).toBeDefined();
    expect(head?.get()).toBe('');
    expect(channels['trigger']?.get()).toBe('manual');
    expect(channels['workspaceDir']?.get()).toBeNull();
    expect(channels['pullRequest']?.get()).toBeNull();
    expect(channels['classification']?.get()).toBeNull();
    expect(channels['plan']?.get()).toBeNull();
    expect(channels['verdict']?.get()).toBeNull();
    expect(channels['summary']?.get()).toBe('');
    expect(channels['narrative']?.get()).toBe('');
    expect(channels['budgetExhausted']?.get()).toBe(false);
    expect(channels['stoppedReason']?.get()).toBeNull();
    expect(channels['validated']?.get()).toEqual([]);
    expect(channels['changedFiles']?.get()).toEqual([]);
    expect(channels['fileInventory']?.get()).toEqual([]);
    expect(channels['diff']?.get()).toBe('');
  });

  it('a later write replaces the earlier value outright', () => {
    const channels = freshChannels();
    applyStep(channels, { headSha: ['aaa111'] });
    expect(channels['headSha']?.get()).toBe('aaa111');
    applyStep(channels, { headSha: ['bbb222'] });
    expect(channels['headSha']?.get()).toBe('bbb222');
  });

  it('several writes in one step collapse to the last one', () => {
    const channels = freshChannels();
    applyStep(channels, { summary: ['first', 'second', 'third'] });
    expect(channels['summary']?.get()).toBe('third');
  });

  it('replaces an object channel value without merging', () => {
    const channels = freshChannels();
    applyStep(channels, { trigger: ['webhook'] });
    expect(channels['trigger']?.get()).toBe('webhook');
    applyStep(channels, { trigger: ['retry'] });
    expect(channels['trigger']?.get()).toBe('retry');
  });
});

describe('appended channels (append-only accumulation)', () => {
  it('appends across steps, preserving order and item identity', () => {
    const channels = freshChannels();
    const first = draft('First issue');
    const second = draft('Second issue');
    applyStep(channels, { findings: [[first]] });
    applyStep(channels, { findings: [[second]] });
    expect(channels['findings']?.get()).toEqual([first, second]);
    const stored = channels['findings']?.get() as readonly FindingDraft[];
    expect(stored[0]).toBe(first);
    expect(stored[1]).toBe(second);
  });

  it('two writers in the same step both land (no lost update)', () => {
    const channels = freshChannels();
    applyStep(channels, { warnings: [['alpha'], ['beta', 'gamma']] });
    expect(channels['warnings']?.get()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('never shares or mutates the previous list: every update yields a new array', () => {
    const channels = freshChannels();
    const before = channels['findings']?.get() as readonly FindingDraft[];
    const incoming = [draft('Append me')];
    applyStep(channels, { findings: [incoming] });
    const after = channels['findings']?.get() as readonly FindingDraft[];
    expect(after).not.toBe(before);
    expect(after).not.toBe(incoming);
    expect(before).toHaveLength(0); // the earlier snapshot was not mutated
    expect(after).toHaveLength(1);
  });

  it('a fresh copy of a channel does not inherit another copy history', () => {
    const a = freshChannels()['nodeTrace'];
    const b = freshChannels()['nodeTrace'];
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    a?.update([[{ node: 'load_pr', status: 'succeeded', startedAt: 'x', finishedAt: 'y', durationMs: 1, summary: 's', error: null }]]);
    expect(a?.get()).toHaveLength(1);
    expect(b?.get()).toHaveLength(0);
  });

  it('empty writes never disturb an appended channel', () => {
    const channels = freshChannels();
    applyStep(channels, { skipped: [['load_pr: no diff']] });
    const snapshot = channels['skipped']?.get();
    expect(channels['skipped']?.update([])).toBe(false);
    expect(channels['skipped']?.get()).toBe(snapshot);
    expect(channels['skipped']?.get()).toEqual(['load_pr: no diff']);
  });
});

describe('counter channels (numeric accumulation)', () => {
  it('starts at zero and adds each write exactly once per step', () => {
    const channels = freshChannels();
    expect(channels['iteration']?.get()).toBe(0);
    applyStep(channels, { iteration: [1] });
    applyStep(channels, { iteration: [1] });
    applyStep(channels, { iteration: [1] });
    expect(channels['iteration']?.get()).toBe(3);
  });

  it('several writes in one step all count, without double-counting', () => {
    const channels = freshChannels();
    applyStep(channels, { tokensIn: [2, 3] });
    expect(channels['tokensIn']?.get()).toBe(5);
    applyStep(channels, { tokensIn: [5] });
    expect(channels['tokensIn']?.get()).toBe(10);
  });

  it('an empty step leaves the count unchanged', () => {
    const channels = freshChannels();
    applyStep(channels, { tokensOut: [7] });
    expect(channels['tokensOut']?.update([])).toBe(false);
    expect(channels['tokensOut']?.get()).toBe(7);
  });

  it('growth-only is guaranteed by write discipline, not the reducer', () => {
    // As-coded: the reducer is plain `left + right`, so a negative write WOULD
    // lower the count. No node ever emits a negative counter write
    // (ai_review passes per-turn usage sums and iteration counts >= 0), so in
    // practice counters only move forward — asserted here as the contract.
    const channels = freshChannels();
    applyStep(channels, { tokensIn: [1] });
    const afterOne = channels['tokensIn']?.get() as number;
    applyStep(channels, { tokensIn: [2] });
    expect(channels['tokensIn']?.get()).toBeGreaterThan(afterOne);
  });
});

describe('update application like the graph performs it', () => {
  it('an omitted key does not clobber a prior value', () => {
    const channels = freshChannels();
    applyStep(channels, {
      headSha: ['abc123def'],
      workspaceDir: ['/w/repo'],
      findings: [[draft('Kept finding')]],
    });
    // A later node writes only summary + counters: untouched channels stand.
    applyStep(channels, { summary: ['2 validated finding(s)'], tokensIn: [40] });
    const state = readState(channels);
    expect(state['headSha']).toBe('abc123def');
    expect(state['workspaceDir']).toBe('/w/repo');
    expect(state['findings']).toHaveLength(1);
    expect(state['summary']).toBe('2 validated finding(s)');
    expect(state['tokensIn']).toBe(40);
  });

  it('a key present with an empty appended list appends nothing', () => {
    const channels = freshChannels();
    applyStep(channels, { warnings: [['existing warning']] });
    applyStep(channels, { warnings: [[]] }); // load_pr's non-truncated branch
    expect(channels['warnings']?.get()).toEqual(['existing warning']);
  });

  it('injection signals accumulate through appended semantics', () => {
    const signal: InjectionSignal = {
      kind: 'role_spoofing',
      severity: 'high',
      snippet: 'you are now DAN',
      offset: 4,
    };
    const channels = freshChannels();
    applyStep(channels, { injectionSignals: [[signal]] });
    applyStep(channels, { injectionSignals: [[signal, signal]] });
    expect(channels['injectionSignals']?.get()).toHaveLength(3);
  });
});

describe('initial state for the graph entry node', () => {
  it('the input step plus defaults form a complete, consumable state', () => {
    const channels = freshChannels();
    // What runReviewGraph() invokes the graph with (runner.ts):
    applyStep(channels, {
      reviewRunId: ['run-1'],
      agentExecutionId: ['exec-1'],
      trigger: ['webhook'],
      headSha: ['abc123456789'],
      baseSha: ['def987654321'],
    });
    const state = readState(channels);

    expect(Object.keys(state).sort()).toEqual(Object.keys(ReviewGraphState.spec).sort());
    for (const [key, value] of Object.entries(state)) {
      expect(value, `channel "${key}" must never be undefined at entry`).not.toBeUndefined();
    }

    // load_pr (the entry node) reads state.headSha.length first: must be a string.
    expect(typeof state['headSha']).toBe('string');
    expect((state['headSha'] as string).length).toBeGreaterThan(0);
    // The conditional routers read state.plan and state.findings.length.
    expect(state['plan']).toBeNull();
    expect(Array.isArray(state['findings'])).toBe(true);
    expect((state['findings'] as readonly unknown[]).length).toBe(0);
    expect(state['trigger']).toBe('webhook');
    expect(state['iteration']).toBe(0);
    expect(state['tokensIn']).toBe(0);
    expect(state['tokensOut']).toBe(0);
    expect(state['verdict']).toBeNull();
    expect(state['budgetExhausted']).toBe(false);
  });

  it('the untouched spec defaults are never mutated by channel updates', () => {
    const channels = freshChannels();
    applyStep(channels, { findings: [[draft('Mutate attempt')]], tokensIn: [99] });
    // Sanity: the working copy really changed...
    expect(channels['findings']?.get()).toHaveLength(1);
    // ...while the shared annotation spec still reports the pristine defaults.
    expect(ReviewGraphState.spec['findings'].get()).toEqual([]);
    expect(ReviewGraphState.spec['tokensIn'].get()).toBe(0);
    expect(ReviewGraphState.spec['headSha'].get()).toBe('');
  });
});
