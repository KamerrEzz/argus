// TypeScript interfaces mirroring the shapes returned by the ACR API
// (apps/api). Every list route answers `{ items, total, take, skip }`; detail
// routes wrap their payload (`{ repository }`, `{ review }`, ...). The api
// layer normalizes pagination, these types describe what the browser receives.

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type FindingCategory =
  | 'bug'
  | 'security'
  | 'performance'
  | 'architecture'
  | 'maintainability'
  | 'testing'
  | 'style';

export type FindingSource =
  | 'agent'
  | 'static_analysis'
  | 'security_scan'
  | 'test_execution'
  | 'human';

export type FindingStatus =
  | 'draft'
  | 'validated'
  | 'published'
  | 'dismissed'
  | 'resolved'
  | 'stale'
  | 'suppressed';

export type ReviewRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'awaiting_approval';

export type ReviewVerdict = 'passed' | 'neutral' | 'failed';

export type ReviewTrigger = 'webhook' | 'manual' | 'retry';

export type ExecutionStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'timed_out';

export type CommandKind =
  | 'test'
  | 'lint'
  | 'typecheck'
  | 'build'
  | 'static_analysis'
  | 'security_scan';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export type RepositoryPermissionLevel = 'read' | 'triage' | 'write' | 'maintain' | 'admin';

export type AgentPermission =
  | 'repository:read'
  | 'pull_request:read'
  | 'pull_request:write'
  | 'checks:write'
  | 'comments:write'
  | 'code_execution:execute'
  | 'review:publish'
  | 'repository:configure'
  | 'review:approve';

// ---------------------------------------------------------------- auth

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
}

// ---------------------------------------------------------------- repositories

export interface AgentPermissions {
  granted: AgentPermission[];
  denied: AgentPermission[];
}

export interface RepositorySettings {
  enabled: boolean;
  reviewDrafts: boolean;
  enableTests: boolean;
  enableLint: boolean;
  enableTypecheck: boolean;
  enableSecurityScan: boolean;
  enableAiReview: boolean;
  deepReview: boolean;
  minPublishConfidence: number;
  failOnSeverities: Severity[];
  publishSummaryComment: boolean;
  publishFindingsAsComments: boolean;
  createCheckRun: boolean;
  requireApprovalToPublish: boolean;
  ignorePaths: string[];
  maxFiles: number;
  instructionHints: string;
  agentPermissions: AgentPermissions;
}

/** PATCH accepts a partial settings object; the server merges and validates. */
export type RepositorySettingsPatch = Partial<RepositorySettings>;

export interface RepositoryCounts {
  pullRequests: number;
  reviewRuns: number;
  findings: number;
  pendingReviews: number;
}

export interface RepositoryListItem {
  id: string;
  githubId: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
  isActive: boolean;
  language: string | null;
  installationId: string | null;
  settings: RepositorySettings;
  createdAt: string;
  lastSyncedAt: string | null;
  counts: RepositoryCounts;
}

export interface RepositoryAccessEntry {
  id: string;
  userId: string;
  email: string;
  name: string;
  permission: RepositoryPermissionLevel;
  grantedAt: string;
}

export interface RecentReviewEntry {
  id: string;
  status: ReviewRunStatus;
  verdict: ReviewVerdict | null;
  createdAt: string;
  findingsTotal: number;
  pullRequest: { id: string; number: number; title: string } | null;
}

export interface RepositoryDetail {
  id: string;
  githubId: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
  isActive: boolean;
  language: string | null;
  installationId: string | null;
  settings: RepositorySettings;
  createdAt: string;
  updatedAt: string;
  lastSyncedAt: string | null;
  counts: {
    pullRequests: number;
    reviewRuns: number;
    members: number;
    findings: number;
  };
  access: RepositoryAccessEntry[];
  recentReviews: RecentReviewEntry[];
}

export interface SyncRepositoriesResult {
  synced: number;
  repositories: string[];
  failures: { installation: number; error: string }[];
}

// ---------------------------------------------------------------- pull requests

export interface PullRequestLatestReview {
  id: string;
  status: ReviewRunStatus;
  verdict: ReviewVerdict | null;
  createdAt: string;
}

export interface PullRequestListItem {
  id: string;
  githubId: string;
  number: number;
  title: string;
  author: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  baseRef: string;
  headRef: string;
  headSha: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  url: string;
  createdAt: string;
  updatedAt: string;
  repository: { id: string; fullName: string };
  counts: { reviews: number; findings: number };
  latestReview: PullRequestLatestReview | null;
}

export interface PullRequestDetail {
  id: string;
  githubId: string;
  number: number;
  title: string;
  body: string;
  author: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  url: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  repository: {
    id: string;
    fullName: string;
    owner: string;
    name: string;
    defaultBranch: string;
  };
  reviews: ReviewRunSummary[];
}

// ---------------------------------------------------------------- reviews

export interface FindingCounts {
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
}

/** Shared shape of `mapReviewRunSummary` on the API side. */
export interface ReviewRunSummary {
  id: string;
  status: ReviewRunStatus;
  verdict: ReviewVerdict | null;
  trigger: ReviewTrigger;
  headSha: string;
  baseSha: string;
  model: string;
  summary: string | null;
  filesAnalyzed: number;
  findings: FindingCounts;
  tokens: { input: number; output: number };
  estimatedCostUsd: string;
  iterations: number;
  toolCalls: number;
  error: string | null;
  budgetLimit: string | null;
  durationMs: number | null;
  createdAt: string;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  publishedAt: string | null;
  commentId: string | null;
  checkRunId: string | null;
}

export interface ReviewRunListItem extends ReviewRunSummary {
  repository: { id: string; fullName: string };
  pullRequest: { id: string; number: number; title: string; author: string; url: string } | null;
}

export interface ReviewFinding {
  id: string;
  fingerprint: string;
  severity: Severity;
  category: FindingCategory;
  status: FindingStatus;
  title: string;
  description: string;
  file: string | null;
  line: number | null;
  endLine: number | null;
  suggestion: string | null;
  evidence: string | null;
  confidence: number;
  confidenceBand: string | null;
  publishable: boolean;
  source: FindingSource;
  ruleId: string | null;
  validationReasons: string[];
  githubCommentId?: string | null;
  publishedAt?: string | null;
  createdAt: string;
}

export interface TestExecution {
  id: string;
  kind: CommandKind;
  tool: string;
  command: string;
  status: ExecutionStatus;
  exitCode: number | null;
  durationMs: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  sandbox: 'docker' | 'process';
  image: string | null;
  summary: string | null;
  details: unknown;
  skippedReason: string | null;
  createdAt: string;
}

export interface AgentNodeRun {
  id: string;
  node: string;
  attempt: number;
  status: ExecutionStatus;
  summary: string | null;
  inputMetadata: unknown;
  outputMetadata: unknown;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface AgentToolRun {
  id: string;
  tool: string;
  status: ExecutionStatus;
  inputMetadata: unknown;
  outputMetadata: unknown;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface AgentExecution {
  id: string;
  graphName: string;
  model: string;
  status: ExecutionStatus;
  currentNode: string | null;
  iterations: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  estimatedCostUsd: string;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  nodes: AgentNodeRun[];
  tools: AgentToolRun[];
}

export interface Approval {
  id: string;
  reviewRunId?: string;
  action: string;
  status: ApprovalStatus;
  payload: unknown;
  requestedAt: string;
  decidedAt: string | null;
  decidedById?: string | null;
  reason: string | null;
}

export interface ReviewPlan {
  analyzeTests: boolean;
  analyzeLint: boolean;
  analyzeTypecheck: boolean;
  analyzeSql: boolean;
  analyzeSecurity: boolean;
  analyzeDependencies: boolean;
  analyzePerformance: boolean;
  deepReview: boolean;
  reasons: string[];
}

/**
 * `getReviewRunDetail` spreads the run summary and then overrides `findings`
 * with the full array, so detail responses carry findings as items, not counts.
 */
export interface ReviewRunDetail extends Omit<ReviewRunSummary, 'findings'> {
  repository: {
    id: string;
    fullName: string;
    owner: string;
    name: string;
    defaultBranch: string;
  };
  pullRequest: {
    id: string;
    number: number;
    title: string;
    author: string;
    url: string;
    baseRef: string;
    headRef: string;
    draft: boolean;
    state: 'open' | 'closed' | 'merged';
  } | null;
  plan: ReviewPlan | null;
  planReasons: string[];
  changedFiles: unknown[];
  findings: ReviewFinding[];
  testExecutions: TestExecution[];
  agentExecutions: AgentExecution[];
  approvals: Approval[];
}

/** POST /reviews, /pull-requests/:id/review and /reviews/:id/retry. */
export interface ReviewRequestResult {
  reviewRunId: string;
  created: boolean;
  status: ReviewRunStatus;
  jobId: string | null;
  queued: boolean;
}

// ---------------------------------------------------------------- events

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

export interface ReviewEventPayload {
  reviewRunId: string;
  type: ReviewEventType;
  at: string;
  message: string;
  node?: string;
  tool?: string;
  status?: string;
  progress?: number;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------- users

export interface ManagedUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
}
