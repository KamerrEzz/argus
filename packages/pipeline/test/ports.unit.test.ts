import { describe, expect, it, vi } from 'vitest';
import { createConfig, parseEnv, type AppConfig } from '@acr/config';
import {
  AGENT_BASE_PERMISSIONS,
  PERMISSIONS,
  RepositorySettingsSchema,
  SandboxError,
  parseRepositorySettings,
  type CommandRunResult,
  type Permission,
  type PriorFindingReference,
  type RepoWorkspace,
  type RepositoryRef,
  type RepositorySettings,
  type ReviewEvent,
} from '@acr/shared';
import { QUEUES, type DispatchResult, type JobWaitOutcome } from '@acr/queue';
import type { AllowedScripts } from '@acr/ai';
import type { AvailableScripts } from '@acr/sandbox';
import type { ScriptCatalog } from '@acr/pipeline';
import {
  DEFAULT_MAX_FINDINGS,
  assembleReviewPorts,
  budgetLimitsFromConfig,
  buildCheckLauncher,
  deriveAgentPermissions,
  graphLimitsFromConfig,
  type ApplicationContainer,
  type AssemblePortsInput,
} from '@acr/pipeline';

// ---------------------------------------------------------------------------
// Synthetic config: parseEnv({}) pins every value to the defaults documented
// in packages/config/src/env.ts — the repo .env is never consulted. Field
// overrides below are unique numbers so a mis-mapped field cannot alias.
// ---------------------------------------------------------------------------

function defaultConfig(): AppConfig {
  return createConfig(parseEnv({}), { workspaceRoot: '/acr-unit-test' });
}

function syntheticConfig(sandboxTimeoutMs = 90_000): AppConfig {
  const base = defaultConfig();
  return {
    ...base,
    budgets: {
      maxDurationMs: 11111,
      maxFiles: 22,
      maxTokens: 333333,
      maxToolCalls: 44,
      maxAgentIterations: 55,
      maxDiffBytes: 666666,
      maxFileBytes: 777777,
      minPublishConfidence: 0.42,
    },
    sandbox: { ...base.sandbox, timeoutMs: sandboxTimeoutMs },
  };
}

function zeroConfig(): AppConfig {
  const base = defaultConfig();
  return {
    ...base,
    budgets: {
      maxDurationMs: 0,
      maxFiles: 0,
      maxTokens: 0,
      maxToolCalls: 0,
      maxAgentIterations: 0,
      maxDiffBytes: 0,
      maxFileBytes: 0,
      minPublishConfidence: 0,
    },
    sandbox: { ...base.sandbox, timeoutMs: 0 },
  };
}

function configWithApproval(required: boolean): AppConfig {
  const base = defaultConfig();
  return { ...base, features: { ...base.features, requireApprovalForPublish: required } };
}

function settingsWith(overrides: Record<string, unknown>): RepositorySettings {
  return RepositorySettingsSchema.parse(overrides);
}

const REPO: RepositoryRef = {
  owner: 'acme',
  name: 'widgets',
  fullName: 'acme/widgets',
  installationId: 77,
  defaultBranch: 'main',
  private: false,
};

const NO_APPROVAL_CONFIG = configWithApproval(false);

// ---------------------------------------------------------------------------

describe('deriveAgentPermissions — publish approval gate', () => {
  it('keeps review:publish when neither the settings nor the config require approval', () => {
    const set = deriveAgentPermissions(settingsWith({}), NO_APPROVAL_CONFIG);
    expect(set.has('review:publish')).toBe(true);
    expect([...set].sort()).toEqual([...AGENT_BASE_PERMISSIONS].sort());
  });

  it('drops review:publish when the repository requires approval (config does not)', () => {
    const set = deriveAgentPermissions(
      settingsWith({ requireApprovalToPublish: true }),
      NO_APPROVAL_CONFIG,
    );
    expect(set.has('review:publish')).toBe(false);
  });

  it('drops review:publish when the config requires approval (settings do not)', () => {
    const set = deriveAgentPermissions(
      settingsWith({ requireApprovalToPublish: false }),
      configWithApproval(true),
    );
    expect(set.has('review:publish')).toBe(false);
  });

  it('drops review:publish when both require it, and keeps every other base permission', () => {
    const set = deriveAgentPermissions(
      settingsWith({ requireApprovalToPublish: true }),
      configWithApproval(true),
    );
    const expected = AGENT_BASE_PERMISSIONS.filter((p) => p !== 'review:publish').sort();
    expect([...set].sort()).toEqual(expected);
  });
});

describe('deriveAgentPermissions — repository settings interplay', () => {
  it('an explicit narrower granted list is honoured exactly', () => {
    const set = deriveAgentPermissions(
      settingsWith({ agentPermissions: { granted: ['repository:read', 'pull_request:read'], denied: [] } }),
      NO_APPROVAL_CONFIG,
    );
    expect([...set].sort()).toEqual(['pull_request:read', 'repository:read']);
  });

  it('denied removes a permission even when granted explicitly', () => {
    const set = deriveAgentPermissions(
      settingsWith({
        agentPermissions: { granted: ['repository:read', 'code_execution:execute'], denied: ['code_execution:execute'] },
      }),
      NO_APPROVAL_CONFIG,
    );
    expect(set.has('repository:read')).toBe(true);
    expect(set.has('code_execution:execute')).toBe(false);
  });

  it('an empty granted list produces the empty set', () => {
    const set = deriveAgentPermissions(
      settingsWith({ agentPermissions: { granted: [], denied: [] } }),
      NO_APPROVAL_CONFIG,
    );
    expect(set.size).toBe(0);
  });

  it('grants inside the base set land, grants outside it are dropped (ceiling)', () => {
    for (const permission of PERMISSIONS) {
      const settings = settingsWith({ agentPermissions: { granted: [permission], denied: [] } });
      expect(settings.agentPermissions.granted).toEqual([permission]);
      const set = deriveAgentPermissions(settings, NO_APPROVAL_CONFIG);
      const inBase = (AGENT_BASE_PERMISSIONS as readonly string[]).includes(permission);
      expect(set.has(permission as Permission)).toBe(inBase);
      expect(PERMISSIONS as readonly string[]).toContain(permission);
    }
  });

  it('a settings blob naming a non-permission never produces a live PermissionSet entry', () => {
    // RepositorySettingsSchema is z.enum(PERMISSIONS): a hostile/typo'd name
    // fails the whole parse and parseRepositorySettings falls back to the
    // default base set — it cannot smuggle an unknown token into the agent.
    const hostile = parseRepositorySettings({
      agentPermissions: { granted: ['repository:read', 'not-a-real:permission'], denied: [] },
    });
    expect(hostile.agentPermissions.granted).toEqual([...AGENT_BASE_PERMISSIONS]);
    const set = deriveAgentPermissions(hostile, NO_APPROVAL_CONFIG);
    for (const permission of set) {
      expect(PERMISSIONS as readonly string[]).toContain(permission);
    }
  });

  it('the derived set is always a subset of PERMISSIONS, even fully widened with the gate on', () => {
    const wide = settingsWith({
      requireApprovalToPublish: true,
      agentPermissions: { granted: [...PERMISSIONS], denied: [] },
    });
    const set = deriveAgentPermissions(wide, NO_APPROVAL_CONFIG);
    for (const permission of set) {
      expect(PERMISSIONS as readonly string[]).toContain(permission);
    }
    expect(set.has('review:publish')).toBe(false);
  });

  it('a repository can never widen the agent beyond AGENT_BASE_PERMISSIONS', () => {
    // Security decision: repository settings are per-repo policy, not a
    // promotion mechanism. deriveAgentPermissions intersects grants with the
    // agent role ceiling, so review:approve, repository:configure and
    // pull_request:write can never reach the graph, with or without the gate.
    const wide = settingsWith({ agentPermissions: { granted: [...PERMISSIONS], denied: [] } });
    const set = deriveAgentPermissions(wide, NO_APPROVAL_CONFIG);
    expect([...set].sort()).toEqual([...AGENT_BASE_PERMISSIONS].sort());
    expect(set.has('review:approve')).toBe(false);
    expect(set.has('repository:configure')).toBe(false);

    const gated = settingsWith({
      requireApprovalToPublish: true,
      agentPermissions: { granted: [...PERMISSIONS], denied: [] },
    });
    const gatedSet = deriveAgentPermissions(gated, NO_APPROVAL_CONFIG);
    expect([...gatedSet].sort()).toEqual(
      AGENT_BASE_PERMISSIONS.filter((p) => p !== 'review:publish').sort(),
    );
  });
});

describe('budgetLimitsFromConfig', () => {
  it('maps every budget field faithfully (distinct synthetic values)', () => {
    const limits = budgetLimitsFromConfig(syntheticConfig());
    expect(limits).toEqual({
      maxDurationMs: 11111,
      maxFiles: 22,
      maxTokens: 333333,
      maxToolCalls: 44,
      maxAgentIterations: 55,
      maxDiffBytes: 666666,
      maxFileBytes: 777777,
    });
  });

  it('passes zeros through without substituting defaults', () => {
    const limits = budgetLimitsFromConfig(zeroConfig());
    expect(limits).toEqual({
      maxDurationMs: 0,
      maxFiles: 0,
      maxTokens: 0,
      maxToolCalls: 0,
      maxAgentIterations: 0,
      maxDiffBytes: 0,
      maxFileBytes: 0,
    });
  });

  it('the default config carries the documented env defaults into the limits', () => {
    const raw = parseEnv({});
    const limits = budgetLimitsFromConfig(defaultConfig());
    expect(limits.maxDurationMs).toBe(raw.REVIEW_MAX_DURATION_MS);
    expect(limits.maxFiles).toBe(raw.REVIEW_MAX_FILES);
    expect(limits.maxTokens).toBe(raw.REVIEW_MAX_TOKENS);
    expect(limits.maxToolCalls).toBe(raw.REVIEW_MAX_TOOL_CALLS);
    expect(limits.maxAgentIterations).toBe(raw.REVIEW_MAX_AGENT_ITERATIONS);
    expect(limits.maxDiffBytes).toBe(raw.REVIEW_MAX_DIFF_BYTES);
    expect(limits.maxFileBytes).toBe(raw.REVIEW_MAX_FILE_BYTES);
    // Sanity on the documented defaults themselves (packages/config/src/env.ts).
    expect(raw.REVIEW_MAX_DURATION_MS).toBe(900_000);
    expect(raw.REVIEW_MAX_FILES).toBe(50);
    expect(raw.REVIEW_MAX_TOKENS).toBe(200_000);
    expect(raw.REVIEW_MAX_TOOL_CALLS).toBe(60);
    expect(raw.REVIEW_MAX_AGENT_ITERATIONS).toBe(12);
  });
});

describe('graphLimitsFromConfig', () => {
  it('maps every field, deriving maxFileInventory from maxFiles and capping toolTimeoutMs at 120s', () => {
    const limits = graphLimitsFromConfig(syntheticConfig(90_000));
    expect(limits).toEqual({
      maxAgentIterations: 55,
      maxToolCalls: 44,
      maxFindings: DEFAULT_MAX_FINDINGS,
      maxDiffChars: 666666,
      maxFileBytes: 777777,
      maxFileInventory: 22 * 10,
      toolTimeoutMs: 90_000,
      checkTimeoutMs: 90_000,
      nodeRetryDelayMs: 500,
    });
    expect(DEFAULT_MAX_FINDINGS).toBe(40);
  });

  it('sandbox timeouts above 120s cap the tool timeout but never the check timeout', () => {
    const limits = graphLimitsFromConfig(syntheticConfig(600_000));
    expect(limits.toolTimeoutMs).toBe(120_000);
    expect(limits.checkTimeoutMs).toBe(600_000);
  });

  it('zeros stay zeros; the two constants stay the documented defaults', () => {
    const limits = graphLimitsFromConfig(zeroConfig());
    expect(limits.maxFileInventory).toBe(0);
    expect(limits.toolTimeoutMs).toBe(0);
    expect(limits.checkTimeoutMs).toBe(0);
    expect(limits.maxFindings).toBe(40);
    expect(limits.nodeRetryDelayMs).toBe(500);
  });

  it('the default config yields the documented default graph limits', () => {
    const raw = parseEnv({});
    const limits = graphLimitsFromConfig(defaultConfig());
    expect(limits.maxAgentIterations).toBe(raw.REVIEW_MAX_AGENT_ITERATIONS);
    expect(limits.maxToolCalls).toBe(raw.REVIEW_MAX_TOOL_CALLS);
    expect(limits.maxDiffChars).toBe(raw.REVIEW_MAX_DIFF_BYTES);
    expect(limits.maxFileBytes).toBe(raw.REVIEW_MAX_FILE_BYTES);
    expect(limits.maxFileInventory).toBe(raw.REVIEW_MAX_FILES * 10);
    expect(limits.toolTimeoutMs).toBe(Math.min(raw.SANDBOX_TIMEOUT_MS, 120_000));
    expect(limits.checkTimeoutMs).toBe(raw.SANDBOX_TIMEOUT_MS);
  });
});

// ---------------------------------------------------------------------------
// buildCheckLauncher + assembleReviewPorts with fakes only.
// ---------------------------------------------------------------------------

function commandRunResult(): CommandRunResult {
  return {
    status: 'succeeded',
    exitCode: 0,
    stdout: 'ok',
    stderr: '',
    durationMs: 5,
    timedOut: false,
    sandbox: 'process',
    image: null,
    command: 'npm run test',
  };
}

function fakeRunner() {
  return { run: vi.fn(async (_spec: unknown): Promise<CommandRunResult> => commandRunResult()) };
}

function fakeQueueClient() {
  return {
    dispatch: vi.fn(
      async (_name: string, _payload: unknown): Promise<DispatchResult> => ({
        jobId: 'job-9',
        deduplicated: false,
      }),
    ),
    waitForJob: vi.fn(
      async (_name: string, _jobId: string, _options: unknown): Promise<JobWaitOutcome<CommandRunResult>> => ({
        status: 'completed',
        result: commandRunResult(),
      }),
    ),
  };
}

interface PortsContainerParts {
  readonly container: ApplicationContainer;
  readonly runner: ReturnType<typeof fakeRunner>;
  readonly queue: ReturnType<typeof fakeQueueClient> | null;
  readonly events: { publish: ReturnType<typeof vi.fn<(event: ReviewEvent) => Promise<void>>> };
  readonly githubRead: Record<string, unknown>;
  readonly persistence: Record<string, unknown>;
  readonly provider: Record<string, unknown>;
}

function portsContainer(options: {
  readonly config?: AppConfig;
  readonly checksQueued?: boolean;
  readonly withQueue?: boolean;
  readonly sandboxUnavailable?: string | null;
  readonly policyTimeoutMs?: number;
}): PortsContainerParts {
  const runner = fakeRunner();
  const queue = options.withQueue === true ? fakeQueueClient() : null;
  const events = {
    publish: vi.fn(async (_event: ReviewEvent) => undefined),
  };
  const githubRead: Record<string, unknown> = { getPullRequest: vi.fn() };
  const persistence: Record<string, unknown> = {};
  const provider: Record<string, unknown> = {};
  const container = {
    config: options.config ?? defaultConfig(),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
    prisma: {},
    persistence,
    github: { read: githubRead, publish: {} },
    runner,
    provider,
    events,
    locks: {},
    queue,
    redis: { connection: null, shared: null },
    workspaces: {},
    sandboxPolicy: {
      image: 'node:22-test',
      network: 'none',
      memoryLimit: '1g',
      cpuLimit: 1,
      pidsLimit: 256,
      timeoutMs: options.policyTimeoutMs ?? 60_000,
    },
    sandboxUnavailable: options.sandboxUnavailable ?? null,
    workspaceRoot: '/acr-unit-test/.work',
    checksQueued: options.checksQueued ?? false,
  };
  return {
    container: container as unknown as ApplicationContainer,
    runner,
    queue,
    events,
    githubRead,
    persistence,
    provider,
  };
}

function fakeWorkspace(): RepoWorkspace {
  return {
    root: '/ws/run-9',
    headSha: 'a'.repeat(40),
    fileList: vi.fn(async () => []),
    readFile: vi.fn(async (_path: string, _options?: { maxBytes?: number }) => ''),
    exists: vi.fn(async () => false),
    listDirectory: vi.fn(async () => []),
    cleanup: vi.fn(async () => undefined),
  };
}

function fakeCatalog(): ScriptCatalog {
  const allowed: AllowedScripts = { test: ['test'], lint: [], typecheck: ['typecheck'] };
  const availability: AvailableScripts = { test: true, lint: false, typecheck: true, build: false };
  return { manifest: null, allowed, availability, dependencySummary: null };
}

describe('buildCheckLauncher — queue preferred, inline fallback', () => {
  it('queued mode hands the launch to the queue and waits for the job', async () => {
    const parts = portsContainer({ checksQueued: true, withQueue: true });
    const launcher = buildCheckLauncher({
      container: parts.container,
      reviewRunId: 'run-9',
      workspaceDir: '/ws/run-9',
    });
    const outcome = await launcher({ kind: 'test', script: 'test', args: ['--ci'], timeoutMs: 1_000 });

    expect(outcome.kind).toBe('test');
    expect(outcome.status).toBe('succeeded');
    expect(outcome.exitCode).toBe(0);
    const dispatchCall = parts.queue?.dispatch.mock.calls[0];
    expect(dispatchCall?.[0]).toBe(QUEUES.runTests);
    expect(dispatchCall?.[1]).toEqual({
      reviewRunId: 'run-9',
      workspaceDir: '/ws/run-9',
      kind: 'test',
      script: 'test',
      args: ['--ci'],
      timeoutMs: 1_000,
    });
    const waitCall = parts.queue?.waitForJob.mock.calls[0];
    expect(waitCall?.[0]).toBe(QUEUES.runTests);
    expect(waitCall?.[1]).toBe('job-9');
    expect(waitCall?.[2]).toEqual({ timeoutMs: 61_000, pollMs: 500 });
    expect(parts.runner.run).not.toHaveBeenCalled();
  });

  it('non-test kinds go to the static-analysis queue', async () => {
    const parts = portsContainer({ checksQueued: true, withQueue: true });
    const launcher = buildCheckLauncher({ container: parts.container, reviewRunId: 'run-9', workspaceDir: '/ws' });
    for (const kind of ['lint', 'typecheck', 'build', 'static_analysis', 'security_scan'] as const) {
      await launcher({ kind, script: 's', args: [], timeoutMs: 1_000 });
    }
    for (const call of parts.queue?.dispatch.mock.calls ?? []) {
      expect(call[0]).toBe(QUEUES.runStaticAnalysis);
    }
    expect(parts.queue?.dispatch).toHaveBeenCalledTimes(5);
  });

  it('a deduplicated dispatch fails with SandboxError instead of silently succeeding', async () => {
    const parts = portsContainer({ checksQueued: true, withQueue: true });
    parts.queue?.dispatch.mockResolvedValueOnce({ jobId: null, deduplicated: true });
    const launcher = buildCheckLauncher({ container: parts.container, reviewRunId: 'run-9', workspaceDir: '/ws' });
    await expect(
      launcher({ kind: 'test', script: 'test', args: [], timeoutMs: 1_000 }),
    ).rejects.toBeInstanceOf(SandboxError);
    expect(parts.queue?.waitForJob).not.toHaveBeenCalled();
  });

  it('a job that did not complete surfaces its failure reason via SandboxError', async () => {
    const parts = portsContainer({ checksQueued: true, withQueue: true });
    parts.queue?.waitForJob.mockResolvedValueOnce({ status: 'failed', reason: 'worker died' });
    const launcher = buildCheckLauncher({ container: parts.container, reviewRunId: 'run-9', workspaceDir: '/ws' });
    await expect(
      launcher({ kind: 'lint', script: 'lint', args: [], timeoutMs: 1_000 }),
    ).rejects.toThrow(/did not complete: worker died/);
  });

  it('queued intent but queue === null falls back to the inline runner', async () => {
    const parts = portsContainer({ checksQueued: true, withQueue: false, policyTimeoutMs: 60_000 });
    const launcher = buildCheckLauncher({ container: parts.container, reviewRunId: 'run-9', workspaceDir: '/ws' });
    await launcher({ kind: 'test', script: 'test', args: [], timeoutMs: 70_000 });

    expect(parts.queue).toBeNull();
    const spec = parts.runner.run.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(spec['workspaceDir']).toBe('/ws');
    // timeout is min(request, policy): 70s requested against a 60s policy.
    expect(spec['timeoutMs']).toBe(60_000);
    expect(spec['image']).toBe('node:22-test');
    expect(spec['network']).toBe('none');
  });

  it('inline mode never touches the queue even when one exists', async () => {
    const parts = portsContainer({ checksQueued: false, withQueue: true });
    const launcher = buildCheckLauncher({ container: parts.container, reviewRunId: 'run-9', workspaceDir: '/ws' });
    await launcher({ kind: 'test', script: 'test', args: [], timeoutMs: 500 });
    expect(parts.queue?.dispatch).not.toHaveBeenCalled();
    const spec = parts.runner.run.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(spec['timeoutMs']).toBe(500);
  });
});

describe('assembleReviewPorts', () => {
  function input(overrides: Partial<AssemblePortsInput> & { container: ApplicationContainer }): AssemblePortsInput {
    return {
      reviewRunId: 'run-9',
      agentExecutionId: 'exec-9',
      repository: REPO,
      pullRequestNumber: 7,
      settings: settingsWith({}),
      workspace: fakeWorkspace(),
      catalog: fakeCatalog(),
      previousFindings: [],
      principalId: 'review-run:run-9',
      ...overrides,
    };
  }

  it('with allowToolUse:false no launcher runs: queue and runner stay untouched', () => {
    const parts = portsContainer({ checksQueued: true, withQueue: true });
    const ports = assembleReviewPorts(input({ container: parts.container, allowToolUse: false }));

    expect(ports.allowToolUse).toBe(false);
    // AS-CODED: the launcher closure is still constructed (graph-ports.ts has
    // no null branch); the gate is the allowToolUse flag itself, which is the
    // equivalent of "launcher is never called".
    expect(typeof ports.toolDeps.launchCheck).toBe('function');
    expect(parts.queue?.dispatch).not.toHaveBeenCalled();
    expect(parts.runner.run).not.toHaveBeenCalled();
  });

  it('default tool gate: deep review AND a usable sandbox are both required', () => {
    const okParts = portsContainer({});
    expect(assembleReviewPorts(input({ container: okParts.container })).allowToolUse).toBe(true);

    const noSandbox = portsContainer({ sandboxUnavailable: 'docker is unavailable' });
    expect(assembleReviewPorts(input({ container: noSandbox.container })).allowToolUse).toBe(false);

    const shallow = portsContainer({});
    expect(
      assembleReviewPorts(
        input({ container: shallow.container, settings: settingsWith({ deepReview: false }) }),
      ).allowToolUse,
    ).toBe(false);

    // AS-CODED: an explicit allowToolUse:true overrides even an unavailable
    // sandbox (input.allowToolUse ?? fallback) — flagged in the report.
    expect(
      assembleReviewPorts(input({ container: noSandbox.container, allowToolUse: true })).allowToolUse,
    ).toBe(true);
  });

  it('passes container pieces through as ports and computes the rest from config', () => {
    const parts = portsContainer({ config: syntheticConfig(90_000) });
    const previous: readonly PriorFindingReference[] = [
      { fingerprint: 'f1', status: 'published', severity: 'high' },
    ];
    const catalog = fakeCatalog();
    const ports = assembleReviewPorts(
      input({
        container: parts.container,
        catalog,
        previousFindings: previous,
        settings: settingsWith({ requireApprovalToPublish: true }),
      }),
    );

    expect(ports.provider).toBe(parts.provider);
    expect(ports.github).toBe(parts.githubRead);
    expect(ports.persistence).toBe(parts.persistence);
    expect(ports.events).toBe(parts.events);
    expect(ports.repository).toBe(REPO);
    expect(ports.workspace.root).toBe('/ws/run-9');
    expect(ports.reviewRunId).toBe('run-9');
    expect(ports.agentExecutionId).toBe('exec-9');
    expect(ports.principalId).toBe('review-run:run-9');
    expect(ports.pullRequestNumber).toBe(7);
    expect(ports.model).toBe(defaultConfig().llm.model);
    expect(ports.costRates).toEqual({
      inputPer1kUsd: defaultConfig().llm.inputCostPer1kUsd,
      outputPer1kUsd: defaultConfig().llm.outputCostPer1kUsd,
    });
    expect(ports.limits).toEqual(graphLimitsFromConfig(syntheticConfig(90_000)));
    expect(ports.budget.limits).toEqual(budgetLimitsFromConfig(syntheticConfig(90_000)));
    expect(ports.permissions).toEqual(
      deriveAgentPermissions(settingsWith({ requireApprovalToPublish: true }), syntheticConfig(90_000)),
    );
    expect(ports.permissions.has('review:publish')).toBe(false);
    expect(ports.toolDeps.allowedScripts).toBe(catalog.allowed);
    expect(ports.toolDeps.defaultCheckTimeoutMs).toBe(90_000);
    expect(ports.toolDeps.sandboxUnavailable?.()).toBeNull();
    expect(ports.sandboxUnavailable).toBeNull();
    expect(ports.previousFindings).toBe(previous);
    expect(ports.usePreviousFindings).toBe(true);
    expect(ports.costs.totalCostUsd).toBe(0);
  });

  it('empty previousFindings disables the cross-run context', () => {
    const parts = portsContainer({});
    const ports = assembleReviewPorts(input({ container: parts.container, previousFindings: [] }));
    expect(ports.usePreviousFindings).toBe(false);
  });

  it('an injected events port overrides the container bus', () => {
    const parts = portsContainer({});
    const injected = { publish: vi.fn(async (_event: ReviewEvent) => undefined) };
    const ports = assembleReviewPorts(input({ container: parts.container, events: injected }));
    expect(ports.events).toBe(injected);
    expect(ports.events).not.toBe(parts.events);
  });
});

describe('PERMISSIONS universe spot check', () => {
  it('review:publish and code_execution:execute are members, typos are not', () => {
    const universe = new Set<string>(PERMISSIONS);
    expect(universe.has('review:publish')).toBe(true);
    expect(universe.has('code_execution:execute')).toBe(true);
    expect(universe.has('review:approve')).toBe(true);
    expect(universe.has('publish')).toBe(false);
  });

  it('settings defaults grant exactly the agent base set', () => {
    const defaults = parseRepositorySettings({});
    expect([...defaults.agentPermissions.granted].sort()).toEqual([...AGENT_BASE_PERMISSIONS].sort());
    expect(defaults.agentPermissions.denied).toEqual([]);
  });

  it('a full PERMISSIONS-length granted list survives schema parsing', () => {
    const granted = PERMISSIONS satisfies readonly Permission[];
    const settings = settingsWith({ agentPermissions: { granted: [...granted], denied: [] } });
    expect(settings.agentPermissions.granted).toHaveLength(PERMISSIONS.length);
  });
});
