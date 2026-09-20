import type { AppConfig } from '@acr/config';
import { CostTracker, type CheckLauncher, type GraphLimits, type ReviewGraphPorts } from '@acr/ai';
import {
  AGENT_BASE_PERMISSIONS,
  BudgetTracker,
  agentPermissions,
  intersectPermissions,
  permissionSetOf,
  type BudgetLimits,
  type PermissionSet,
  type PriorFindingReference,
  type RepoWorkspace,
  type RepositoryRef,
  type RepositorySettings,
  type ReviewEventPort,
} from '@acr/shared';
import type { ApplicationContainer } from './container';
import { createInlineCheckLauncher, createQueuedCheckLauncher, type ScriptCatalog } from './checks';

export const DEFAULT_MAX_FINDINGS = 40;
export const DEFAULT_NODE_RETRY_DELAY_MS = 500;

export function budgetLimitsFromConfig(config: AppConfig): BudgetLimits {
  return {
    maxDurationMs: config.budgets.maxDurationMs,
    maxFiles: config.budgets.maxFiles,
    maxTokens: config.budgets.maxTokens,
    maxToolCalls: config.budgets.maxToolCalls,
    maxAgentIterations: config.budgets.maxAgentIterations,
    maxDiffBytes: config.budgets.maxDiffBytes,
    maxFileBytes: config.budgets.maxFileBytes,
  };
}

export function graphLimitsFromConfig(config: AppConfig): GraphLimits {
  return {
    maxAgentIterations: config.budgets.maxAgentIterations,
    maxToolCalls: config.budgets.maxToolCalls,
    maxFindings: DEFAULT_MAX_FINDINGS,
    maxDiffChars: config.budgets.maxDiffBytes,
    maxFileBytes: config.budgets.maxFileBytes,
    maxFileInventory: config.budgets.maxFiles * 10,
    toolTimeoutMs: Math.min(config.sandbox.timeoutMs, 120_000),
    checkTimeoutMs: config.sandbox.timeoutMs,
    nodeRetryDelayMs: DEFAULT_NODE_RETRY_DELAY_MS,
  };
}

/**
 * The agent can only ever hold what the repository grants it, minus what an
 * explicit denial removes — and never more than the agent role's standing
 * ceiling. Repository settings are operator-controlled, but they are per-repo
 * policy, not a promotion mechanism: `pull_request:write`,
 * `repository:configure` and `review:approve` correspond to actions no shipped
 * tool performs, so granting them can only widen a future blast radius (a new
 * tool, or a prompt-injected "just enable X for this repo"). Intersect first,
 * then deny, then gate. Publishing is stripped when a human has to approve,
 * so a missing approval cannot be worked around inside the graph.
 */
export function deriveAgentPermissions(
  settings: RepositorySettings,
  config: AppConfig,
): PermissionSet {
  const ceiling = permissionSetOf(AGENT_BASE_PERMISSIONS);
  const repoGranted = agentPermissions({
    granted: settings.agentPermissions.granted,
    denied: [],
  });
  const narrowed = new Set(intersectPermissions(ceiling, repoGranted));
  for (const denied of settings.agentPermissions.denied) {
    narrowed.delete(denied);
  }
  const approvalRequired =
    settings.requireApprovalToPublish || config.features.requireApprovalForPublish;
  if (approvalRequired) {
    narrowed.delete('review:publish');
  }
  return narrowed;
}

/**
 * Where a check actually runs. Queued mode needs the workspace directory to be
 * readable by the worker, i.e. a shared volume between api, worker and CLI.
 */
export function buildCheckLauncher(input: {
  readonly container: ApplicationContainer;
  readonly reviewRunId: string;
  readonly workspaceDir: string;
}): CheckLauncher {
  if (input.container.checksQueued && input.container.queue !== null) {
    return createQueuedCheckLauncher({
      queue: input.container.queue,
      reviewRunId: input.reviewRunId,
      workspaceDir: input.workspaceDir,
    });
  }
  return createInlineCheckLauncher({
    runner: input.container.runner,
    workspaceDir: input.workspaceDir,
    policy: input.container.sandboxPolicy,
  });
}

export interface AssemblePortsInput {
  readonly container: ApplicationContainer;
  readonly reviewRunId: string;
  readonly agentExecutionId: string;
  readonly repository: RepositoryRef;
  readonly pullRequestNumber: number;
  readonly settings: RepositorySettings;
  readonly workspace: RepoWorkspace;
  readonly catalog: ScriptCatalog;
  readonly previousFindings: readonly PriorFindingReference[];
  readonly principalId: string;
  /** Overrides the container bus, e.g. to tag events with a job identity. */
  readonly events?: ReviewEventPort;
  /** Deep review is the only way to reach the sandbox; disabled here means no tools at all. */
  readonly allowToolUse?: boolean;
}

export function assembleReviewPorts(input: AssemblePortsInput): ReviewGraphPorts {
  const { container, settings, catalog } = input;
  const config = container.config;
  const toolsAllowed =
    input.allowToolUse ?? (container.sandboxUnavailable === null && settings.deepReview);

  return {
    provider: container.provider,
    github: container.github.read,
    persistence: container.persistence,
    events: input.events ?? container.events,
    logger: container.logger,
    budget: new BudgetTracker(budgetLimitsFromConfig(config)),
    settings,
    repository: input.repository,
    pullRequestNumber: input.pullRequestNumber,
    reviewRunId: input.reviewRunId,
    agentExecutionId: input.agentExecutionId,
    principalId: input.principalId,
    permissions: deriveAgentPermissions(settings, config),
    limits: graphLimitsFromConfig(config),
    toolDeps: {
      launchCheck: buildCheckLauncher({
        container,
        reviewRunId: input.reviewRunId,
        workspaceDir: input.workspace.root,
      }),
      allowedScripts: catalog.allowed,
      defaultCheckTimeoutMs: config.sandbox.timeoutMs,
      sandboxUnavailable: () => container.sandboxUnavailable,
    },
    costs: new CostTracker({
      inputPer1kUsd: config.llm.inputCostPer1kUsd,
      outputPer1kUsd: config.llm.outputCostPer1kUsd,
    }),
    previousFindings: input.previousFindings,
    usePreviousFindings: input.previousFindings.length > 0,
    model: config.llm.model,
    costRates: {
      inputPer1kUsd: config.llm.inputCostPer1kUsd,
      outputPer1kUsd: config.llm.outputCostPer1kUsd,
    },
    workspace: input.workspace,
    sandboxUnavailable: container.sandboxUnavailable,
    allowToolUse: toolsAllowed,
  };
}
