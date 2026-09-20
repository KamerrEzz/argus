import { type Permission } from './permissions';
import {
  type FindingDraft,
  type FindingStatus,
  type PriorFindingReference,
  type Severity,
} from './findings';
import type {
  AnalysisResult,
  CheckRunConclusion,
  CommandKind,
  CommandOutcome,
  ExecutionStatus,
  ReviewPlan,
  ReviewRunStatus,
  ReviewTrigger,
} from './review-types';
import type {
  CheckRunRef,
  ChangedFile,
  CodeSearchMatch,
  FileContent,
  PullRequestInfo,
  RepositoryRef,
  RepositoryTreeEntry,
  ReviewCommentRef,
} from './github-types';
import type { LoggerPort } from './logging';
import type { BudgetTracker } from './budget';
import type { RepositorySettings } from './settings';

export interface CheckExecutionRecord {
  readonly kind: CommandKind;
  readonly tool: string;
  readonly command: string;
  readonly status: ExecutionStatus;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly sandbox: 'docker' | 'process';
  readonly image: string | null;
  readonly summary: string;
  readonly findings: readonly FindingDraft[];
  readonly details: Record<string, unknown> | null;
  readonly skippedReason: string | null;
}

export function checkRecordToOutcome(record: CheckExecutionRecord): CommandOutcome {
  return {
    kind: record.kind,
    command: record.command,
    status: record.status,
    exitCode: record.exitCode,
    durationMs: record.durationMs,
    stdout: record.stdout,
    stderr: record.stderr,
    timedOut: record.timedOut,
    sandbox: record.sandbox,
    image: record.image,
    ...(record.skippedReason === null ? {} : { skippedReason: record.skippedReason }),
  };
}

export function checkRecordToAnalysis(record: CheckExecutionRecord): AnalysisResult {
  return {
    kind: record.kind,
    tool: record.tool,
    status: record.status,
    summary: record.summary,
    findings: record.findings,
    ...(record.details === null ? {} : { details: record.details }),
    ...(record.skippedReason === null ? {} : { skippedReason: record.skippedReason }),
  };
}

export interface ReviewRunTarget {
  readonly reviewRunId: string;
  readonly repositoryId: string;
  readonly repository: RepositoryRef;
  readonly pullRequestId: string;
  readonly pullRequest: PullRequestInfo;
  readonly trigger: ReviewTrigger;
  readonly settings: RepositorySettings;
  readonly previousReviewRunId: string | null;
}

export interface CreateReviewRunInput {
  readonly repositoryId: string;
  readonly pullRequestId: string;
  readonly trigger: ReviewTrigger;
  readonly headSha: string;
  readonly baseSha: string;
  readonly idempotencyKey: string;
  readonly model: string;
}

export interface PersistedFindingInput {
  readonly draft: FindingDraft;
  readonly fingerprint: string;
  readonly publishable: boolean;
  readonly status: FindingStatus;
  readonly validationReasons: readonly string[];
  readonly confidenceBand: 'low' | 'medium' | 'high';
}

export interface PersistedFinding extends PersistedFindingInput {
  readonly id: string;
  readonly createdAt: string;
}

export interface CompleteReviewRunInput {
  readonly status: Extract<ReviewRunStatus, 'completed' | 'failed' | 'cancelled'>;
  readonly verdict: 'passed' | 'neutral' | 'failed' | null;
  readonly summary: string;
  readonly finishedAt: Date;
  readonly durationMs: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly estimatedCostUsd: number;
  readonly error: string | null;
  readonly budgetExceeded: { limit: string; details: Record<string, unknown> } | null;
}

export interface AgentExecutionStart {
  readonly reviewRunId: string;
  readonly graphName: string;
  readonly model: string;
  readonly startedAt: Date;
}

export interface AgentExecutionFinish {
  readonly status: 'succeeded' | 'failed' | 'cancelled';
  readonly finishedAt: Date;
  readonly durationMs: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly estimatedCostUsd: number;
  readonly error: string | null;
  readonly finalNode: string | null;
  readonly iterations: number;
  readonly toolCalls: number;
}

export interface NodeExecutionRecord {
  readonly reviewRunId: string;
  readonly agentExecutionId: string;
  readonly node: string;
  readonly attempt: number;
  readonly status: 'succeeded' | 'failed' | 'skipped';
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly durationMs: number;
  readonly summary: string;
  readonly inputMetadata: Record<string, unknown> | null;
  readonly outputMetadata: Record<string, unknown> | null;
  readonly error: string | null;
}

export interface ToolExecutionRecord {
  readonly reviewRunId: string;
  readonly agentExecutionId: string;
  readonly tool: string;
  readonly status: 'succeeded' | 'failed' | 'denied';
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly durationMs: number;
  readonly inputMetadata: Record<string, unknown> | null;
  readonly outputMetadata: Record<string, unknown> | null;
  readonly error: string | null;
}

export interface ReviewPersistencePort {
  getReviewTarget(reviewRunId: string): Promise<ReviewRunTarget | null>;
  findReviewRunByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<{ id: string; status: ReviewRunStatus } | null>;
  createReviewRun(input: CreateReviewRunInput): Promise<{ id: string; created: boolean }>;
  markReviewRunRunning(reviewRunId: string, startedAt: Date): Promise<void>;
  saveChangedFiles(reviewRunId: string, files: readonly ChangedFile[], diff: string): Promise<void>;
  savePlan(reviewRunId: string, plan: ReviewPlan, reasons: readonly string[]): Promise<void>;
  saveExecutions(reviewRunId: string, records: readonly CheckExecutionRecord[]): Promise<void>;
  saveFindings(
    reviewRunId: string,
    findings: readonly PersistedFindingInput[],
  ): Promise<readonly PersistedFinding[]>;
  markFindingsPublished(
    reviewRunId: string,
    published: readonly { readonly fingerprint: string; readonly commentId: number | null }[],
  ): Promise<void>;
  loadPreviousFindings(
    pullRequestId: string,
    excludeReviewRunId: string,
  ): Promise<readonly PriorFindingReference[]>;
  startAgentExecution(input: AgentExecutionStart): Promise<string>;
  finishAgentExecution(agentExecutionId: string, result: AgentExecutionFinish): Promise<void>;
  recordNodeExecution(record: NodeExecutionRecord): Promise<void>;
  recordToolExecution(record: ToolExecutionRecord): Promise<void>;
  completeReviewRun(reviewRunId: string, input: CompleteReviewRunInput): Promise<void>;
  markReviewPublished(
    reviewRunId: string,
    refs: { readonly commentId: number | null; readonly checkRunId: number | null },
  ): Promise<void>;
}

export interface CommandSpec {
  readonly kind: CommandKind;
  readonly script: string;
  readonly args: readonly string[];
  readonly workspaceDir: string;
  readonly timeoutMs: number;
  readonly image: string;
  readonly network: 'none' | 'bridge';
  readonly memoryLimit: string;
  readonly cpuLimit: number;
  readonly pidsLimit: number;
  readonly env?: Readonly<Record<string, string>>;
}

export interface CommandRunResult {
  readonly status: ExecutionStatus;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly sandbox: 'docker' | 'process';
  readonly image: string | null;
  readonly command: string;
}

export interface CommandRunnerPort {
  run(spec: CommandSpec): Promise<CommandRunResult>;
}

export interface WorkspaceDirectoryEntry {
  readonly name: string;
  readonly type: 'file' | 'directory' | 'symlink' | 'other';
}

export interface RepoWorkspace {
  readonly root: string;
  readonly headSha: string;
  fileList(): Promise<readonly string[]>;
  readFile(relativePath: string, options?: { readonly maxBytes?: number }): Promise<string>;
  exists(relativePath: string): Promise<boolean>;
  listDirectory(relativePath: string): Promise<readonly WorkspaceDirectoryEntry[]>;
  cleanup(): Promise<void>;
}

export interface GithubReadPort {
  getPullRequest(input: {
    readonly repository: RepositoryRef;
    readonly number: number;
  }): Promise<PullRequestInfo>;
  getPullRequestDiff(input: {
    readonly repository: RepositoryRef;
    readonly number: number;
  }): Promise<string>;
  getChangedFiles(input: {
    readonly repository: RepositoryRef;
    readonly number: number;
  }): Promise<readonly ChangedFile[]>;
  getFileContent(input: {
    readonly repository: RepositoryRef;
    readonly path: string;
    readonly ref: string;
  }): Promise<FileContent>;
  searchRepository(input: {
    readonly repository: RepositoryRef;
    readonly query: string;
    readonly limit: number;
  }): Promise<readonly CodeSearchMatch[]>;
  getRepositoryTree(input: {
    readonly repository: RepositoryRef;
    readonly ref: string;
  }): Promise<readonly RepositoryTreeEntry[]>;
}

export interface GithubPublishPort {
  findSummaryComment(input: {
    readonly repository: RepositoryRef;
    readonly pullRequestNumber: number;
  }): Promise<ReviewCommentRef | null>;
  createComment(input: {
    readonly repository: RepositoryRef;
    readonly pullRequestNumber: number;
    readonly body: string;
  }): Promise<ReviewCommentRef>;
  updateComment(input: {
    readonly repository: RepositoryRef;
    readonly commentId: number;
    readonly body: string;
  }): Promise<ReviewCommentRef>;
  createCheckRun(input: {
    readonly repository: RepositoryRef;
    readonly headSha: string;
    readonly name: string;
    readonly conclusion: CheckRunConclusion;
    readonly title: string;
    readonly summary: string;
    readonly text: string;
    readonly detailsUrl: string | null;
  }): Promise<CheckRunRef>;
  updateCheckRun(input: {
    readonly repository: RepositoryRef;
    readonly checkRunId: number;
    readonly conclusion: CheckRunConclusion;
    readonly title: string;
    readonly summary: string;
    readonly text: string;
  }): Promise<CheckRunRef>;
}

export const REVIEW_EVENT_TYPES = [
  'run.queued',
  'run.started',
  'node.started',
  'node.finished',
  'tool.started',
  'tool.finished',
  'check.started',
  'check.finished',
  'finding.created',
  'log',
  'warning',
  'error',
  'run.completed',
  'run.failed',
  'heartbeat',
] as const;
export type ReviewEventType = (typeof REVIEW_EVENT_TYPES)[number];

export interface ReviewEvent {
  readonly reviewRunId: string;
  readonly type: ReviewEventType;
  readonly at: string;
  readonly message: string;
  readonly node?: string;
  readonly tool?: string;
  readonly status?: string;
  readonly progress?: number;
  readonly data?: Record<string, unknown>;
}

export interface ReviewEventPort {
  publish(event: ReviewEvent): Promise<void>;
}

export interface ClockPort {
  now(): Date;
  nowMs(): number;
}

export const systemClock: ClockPort = {
  now: () => new Date(),
  nowMs: () => Date.now(),
};

export interface ReviewApprovalPort {
  requestApproval(input: {
    readonly reviewRunId: string;
    readonly action: string;
    readonly payload: Record<string, unknown>;
  }): Promise<{ readonly approved: boolean; readonly approverId: string | null }>;
}

export interface AgentToolContext {
  readonly reviewRunId: string;
  readonly agentExecutionId: string;
  readonly principal: { readonly type: 'user' | 'agent' | 'system'; readonly id: string; readonly permissions: ReadonlySet<Permission> };
  readonly repository: RepositoryRef;
  readonly pullRequest: PullRequestInfo;
  readonly changedFiles: readonly ChangedFile[];
  readonly workspace: RepoWorkspace;
  readonly github: GithubReadPort;
  readonly persistence: ReviewPersistencePort;
  readonly logger: LoggerPort;
  readonly budget: BudgetTracker;
  readonly settings: RepositorySettings;
  readonly maxFileBytes: number;
  readonly usePreviousFindings: boolean;
  readonly previousFindings: readonly PriorFindingReference[];
  readonly recordToolCall: (record: {
    readonly tool: string;
    readonly status: 'succeeded' | 'failed' | 'denied';
    readonly startedAt: Date;
    readonly finishedAt: Date;
    readonly durationMs: number;
    readonly inputMetadata: Record<string, unknown> | null;
    readonly outputMetadata: Record<string, unknown> | null;
    readonly error: string | null;
  }) => Promise<void>;
}

export type { Severity, FindingStatus };
