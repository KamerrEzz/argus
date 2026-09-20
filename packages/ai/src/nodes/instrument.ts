import type {
  GithubReadPort,
  LoggerPort,
  Permission,
  RepositoryRef,
  RepositorySettings,
  ReviewEventPort,
  ReviewPersistencePort,
  ReviewEvent,
  BudgetTracker,
  RepoWorkspace,
  PriorFindingReference,
} from '@acr/shared';
import type { AIProvider } from '../provider/types';
import type { ToolDependencies } from '../tools/contracts';
import type { CostRates, CostTracker } from '../cost';
import type { ReviewGraphStateType } from '../state';

export interface GraphLimits {
  readonly maxAgentIterations: number;
  readonly maxToolCalls: number;
  readonly maxFindings: number;
  readonly maxDiffChars: number;
  readonly maxFileBytes: number;
  readonly maxFileInventory: number;
  readonly toolTimeoutMs: number;
  readonly checkTimeoutMs: number;
  readonly nodeRetryDelayMs: number;
}

/**
 * Everything the graph needs, as plain ports. The graph never imports an
 * implementation: the application layer decides what is real and what is a
 * test double.
 */
export interface ReviewGraphPorts {
  readonly provider: AIProvider;
  readonly github: GithubReadPort;
  readonly persistence: ReviewPersistencePort;
  readonly events: ReviewEventPort;
  readonly logger: LoggerPort;
  readonly budget: BudgetTracker;
  readonly settings: RepositorySettings;
  readonly repository: RepositoryRef;
  readonly pullRequestNumber: number;
  readonly reviewRunId: string;
  readonly agentExecutionId: string;
  readonly principalId: string;
  readonly permissions: ReadonlySet<Permission>;
  readonly limits: GraphLimits;
  readonly toolDeps: ToolDependencies;
  readonly costs: CostTracker;
  readonly previousFindings: readonly PriorFindingReference[];
  readonly usePreviousFindings: boolean;
  readonly model: string;
  readonly costRates: CostRates;
  readonly workspace: RepoWorkspace;
  readonly sandboxUnavailable: string | null;
  readonly allowToolUse: boolean;
}

export type NodeUpdate = Partial<ReviewGraphStateType>;
export type GraphNodeFn = (state: ReviewGraphStateType) => Promise<NodeUpdate>;

export function isoNow(): string {
  return new Date().toISOString();
}

export async function publish(ports: ReviewGraphPorts, event: Omit<ReviewEvent, 'at'>): Promise<void> {
  await ports.events.publish({ ...event, at: isoNow() });
}

export interface TracedResult {
  readonly update: NodeUpdate;
  readonly status: 'succeeded' | 'failed' | 'skipped';
  readonly durationMs: number;
  readonly summary: string;
  readonly error: string | null;
}

/**
 * Wraps a node with the three things every node must do: emit progress, write
 * the node execution record, and keep a trace entry in state. A failed node is
 * recorded and re-thrown; only the runner decides whether the review survives.
 */
export function instrumentNode(
  ports: ReviewGraphPorts,
  node: string,
  fn: GraphNodeFn,
): GraphNodeFn {
  return async (state) => {
    const startedAt = new Date();
    await publish(ports, {
      reviewRunId: ports.reviewRunId,
      type: 'node.started',
      message: `${node} started`,
      node,
    });

    try {
      const update = await fn(state);
      const finishedAt = new Date();
      const summary = summarizeUpdate(update);
      await record(ports, node, startedAt, finishedAt, 'succeeded', summary, update, null);
      await publish(ports, {
        reviewRunId: ports.reviewRunId,
        type: 'node.finished',
        message: `${node}: ${summary}`,
        node,
        status: 'succeeded',
      });
      return {
        ...update,
        nodeTrace: [
          {
            node,
            status: 'succeeded' as const,
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            durationMs: finishedAt.getTime() - startedAt.getTime(),
            summary,
            error: null,
          },
        ],
      };
    } catch (error) {
      const finishedAt = new Date();
      const message = error instanceof Error ? error.message : String(error);
      await record(ports, node, startedAt, finishedAt, 'failed', '', null, message);
      await publish(ports, {
        reviewRunId: ports.reviewRunId,
        type: 'error',
        message: `${node} failed: ${message}`,
        node,
        status: 'failed',
      });
      throw error;
    }
  };
}

export function skippedNode(node: string, reason: string): NodeUpdate {
  return {
    skipped: [`${node}: ${reason}`],
    nodeTrace: [
      {
        node,
        status: 'skipped',
        startedAt: isoNow(),
        finishedAt: isoNow(),
        durationMs: 0,
        summary: reason,
        error: null,
      },
    ],
  };
}

async function record(
  ports: ReviewGraphPorts,
  node: string,
  startedAt: Date,
  finishedAt: Date,
  status: 'succeeded' | 'failed' | 'skipped',
  summary: string,
  update: NodeUpdate | null,
  error: string | null,
): Promise<void> {
  await ports.persistence.recordNodeExecution({
    reviewRunId: ports.reviewRunId,
    agentExecutionId: ports.agentExecutionId,
    node,
    attempt: 1,
    status,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    summary,
    inputMetadata: null,
    outputMetadata: update === null ? null : metadataOf(update),
    error,
  });
}

function metadataOf(update: NodeUpdate): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(update as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      metadata[key] = value.length;
    } else if (typeof value === 'string') {
      metadata[key] = value.length > 120 ? `${value.slice(0, 120)}...` : value;
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      metadata[key] = value;
    }
  }
  return metadata;
}

function summarizeUpdate(update: NodeUpdate): string {
  const parts: string[] = [];
  const record = update as Record<string, unknown>;
  if (typeof record['summary'] === 'string' && record['summary'].length > 0) {
    parts.push(String(record['summary']).slice(0, 160));
  }
  for (const key of ['changedFiles', 'commands', 'findings', 'analyses', 'validated']) {
    const value = record[key];
    if (Array.isArray(value)) {
      parts.push(`${key}=${value.length}`);
    }
  }
  if (typeof record['verdict'] === 'string') {
    parts.push(`verdict=${record['verdict']}`);
  }
  return parts.length > 0 ? parts.join(' ') : 'done';
}
