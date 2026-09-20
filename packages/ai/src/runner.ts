import { BudgetExceededError } from '@acr/shared';
import type {
  AnalysisResult,
  ChangeClassification,
  CheckExecutionRecord,
  FindingDraft,
  FindingValidationOutcome,
  InjectionSignal,
  PullRequestInfo,
  ReviewEventPort,
  ReviewPlan,
  ReviewTrigger,
  ReviewVerdict,
} from '@acr/shared';
import { buildReviewGraph } from './graph';
import { isoNow, type ReviewGraphPorts } from './nodes/instrument';
import type { NodeTraceEntry, ReviewGraphStateType } from './state';

export interface ReviewGraphInput {
  readonly reviewRunId: string;
  readonly agentExecutionId: string;
  readonly trigger: ReviewTrigger;
  readonly headSha?: string;
  readonly baseSha?: string;
}

export type ReviewGraphStatus = 'completed' | 'partial' | 'failed';

export interface ReviewOutcome {
  readonly status: ReviewGraphStatus;
  readonly verdict: ReviewVerdict | null;
  readonly summary: string;
  readonly narrative: string;
  readonly findings: readonly FindingDraft[];
  readonly publishableFindings: readonly FindingDraft[];
  readonly validated: readonly FindingValidationOutcome[];
  readonly plan: ReviewPlan | null;
  readonly classification: ChangeClassification | null;
  readonly pullRequest: PullRequestInfo | null;
  readonly commands: readonly CheckExecutionRecord[];
  readonly analyses: readonly AnalysisResult[];
  readonly nodeTrace: readonly NodeTraceEntry[];
  readonly warnings: readonly string[];
  readonly skipped: readonly string[];
  readonly injectionSignals: readonly InjectionSignal[];
  readonly usage: {
    readonly tokensIn: number;
    readonly tokensOut: number;
    readonly estimatedCostUsd: number;
  };
  readonly iterations: number;
  readonly toolCalls: number;
  readonly stoppedReason: string | null;
  readonly budgetExhausted: boolean;
  readonly error: string | null;
  readonly headSha: string;
  readonly baseSha: string;
  readonly workspaceDir: string | null;
}

const RECURSION_LIMIT = 32;
const HEARTBEAT_MS = 15_000;

/**
 * Runs the graph once and always returns an outcome, including when a node
 * throws: the last committed state is read back from the checkpoint so a
 * partially completed review still reports what it learned.
 */
export async function runReviewGraph(
  ports: ReviewGraphPorts,
  input: ReviewGraphInput,
): Promise<ReviewOutcome> {
  const graph = buildReviewGraph(ports);
  const config = {
    configurable: { thread_id: input.reviewRunId },
    recursionLimit: RECURSION_LIMIT,
  };
  const startedAt = Date.now();
  const heartbeat = startHeartbeat(ports.events, ports, input.reviewRunId, startedAt);

  let error: string | null = null;
  let budgetExhausted = false;
  let values: ReviewGraphStateType;

  try {
    values = (await graph.invoke(
      {
        reviewRunId: input.reviewRunId,
        agentExecutionId: input.agentExecutionId,
        trigger: input.trigger,
        headSha: input.headSha ?? '',
        baseSha: input.baseSha ?? '',
      },
      config,
    )) as ReviewGraphStateType;
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown);
    budgetExhausted = thrown instanceof BudgetExceededError || budgetExhausted;
    values = await salvage(ports, graph, config, input);
  } finally {
    heartbeat.stop();
  }

  const validated = values.validated ?? [];
  const publishableFindings = validated.filter((outcome) => outcome.publishable).map((outcome) => outcome.finding);
  const status: ReviewGraphStatus =
    error !== null ? 'failed' : budgetExhausted || values.budgetExhausted ? 'partial' : 'completed';

  return {
    status,
    verdict: values.verdict ?? null,
    summary: values.summary ?? '',
    narrative: values.narrative ?? '',
    findings: values.findings ?? [],
    publishableFindings,
    validated,
    plan: values.plan ?? null,
    classification: values.classification ?? null,
    pullRequest: values.pullRequest ?? null,
    commands: values.commands ?? [],
    analyses: values.analyses ?? [],
    nodeTrace: values.nodeTrace ?? [],
    warnings: [
      ...(values.warnings ?? []),
      ...(error === null ? [] : [`review stopped early: ${error}`]),
    ],
    skipped: values.skipped ?? [],
    injectionSignals: values.injectionSignals ?? [],
    usage: {
      tokensIn: values.tokensIn ?? ports.costs.totalTokensIn,
      tokensOut: values.tokensOut ?? ports.costs.totalTokensOut,
      estimatedCostUsd: ports.costs.totalCostUsd,
    },
    iterations: values.iteration ?? 0,
    toolCalls: ports.budget.snapshot().toolCalls,
    stoppedReason: values.stoppedReason ?? (error === null ? null : 'node_error'),
    budgetExhausted: budgetExhausted || values.budgetExhausted === true,
    error,
    headSha: values.headSha ?? input.headSha ?? '',
    baseSha: values.baseSha ?? input.baseSha ?? '',
    workspaceDir: values.workspaceDir ?? null,
  };
}

async function salvage(
  ports: ReviewGraphPorts,
  graph: ReturnType<typeof buildReviewGraph>,
  config: { configurable: { thread_id: string }; recursionLimit: number },
  input: ReviewGraphInput,
): Promise<ReviewGraphStateType> {
  try {
    const snapshot = await graph.getState(config);
    return (snapshot.values ?? {}) as ReviewGraphStateType;
  } catch (salvageError) {
    ports.logger.warn(
      {
        reviewRunId: input.reviewRunId,
        reason: salvageError instanceof Error ? salvageError.message : 'unknown',
      },
      'could not read the partial review state; reporting an empty outcome',
    );
    return {} as ReviewGraphStateType;
  }
}

function startHeartbeat(
  events: ReviewEventPort,
  ports: ReviewGraphPorts,
  reviewRunId: string,
  startedAt: number,
): { readonly stop: () => void } {
  let stopped = false;
  const handle = setInterval(() => {
    if (stopped) {
      return;
    }
    void events.publish({
      reviewRunId,
      type: 'heartbeat',
      at: isoNow(),
      message: `review alive after ${Math.round((Date.now() - startedAt) / 1000)}s`,
      data: { elapsedMs: Date.now() - startedAt, toolCalls: ports.budget.snapshot().toolCalls },
    });
  }, HEARTBEAT_MS);
  handle.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearInterval(handle);
    },
  };
}
