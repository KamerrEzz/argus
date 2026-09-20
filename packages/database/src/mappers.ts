import type {
  ApprovalStatus as DbApprovalStatus,
  ExecutionKind as DbExecutionKind,
  ExecutionStatus as DbExecutionStatus,
  FindingCategory as DbFindingCategory,
  FindingSource as DbFindingSource,
  FindingStatus as DbFindingStatus,
  RepositoryPermission as DbRepositoryPermission,
  ReviewRunStatus as DbReviewRunStatus,
  ReviewTrigger as DbReviewTrigger,
  ReviewVerdict as DbReviewVerdict,
  SandboxKind as DbSandboxKind,
  Severity as DbSeverity,
  UserRole as DbUserRole,
  WebhookEventStatus as DbWebhookEventStatus,
  PullRequestState as DbPullRequestState,
} from '@prisma/client';
import type {
  Category,
  CommandKind,
  ExecutionStatus,
  FindingSource,
  FindingStatus,
  PullRequestInfo,
  RepositoryPermissionLevel,
  RepositoryRef,
  ReviewRunStatus,
  ReviewTrigger,
  ReviewVerdict,
  Severity,
} from '@acr/shared';

const SEVERITY_TO_DB = {
  critical: 'CRITICAL',
  high: 'HIGH',
  medium: 'MEDIUM',
  low: 'LOW',
  info: 'INFO',
} as const satisfies Record<Severity, DbSeverity>;

const SEVERITY_FROM_DB = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  INFO: 'info',
} as const satisfies Record<DbSeverity, Severity>;

const CATEGORY_TO_DB = {
  bug: 'BUG',
  security: 'SECURITY',
  performance: 'PERFORMANCE',
  architecture: 'ARCHITECTURE',
  maintainability: 'MAINTAINABILITY',
  testing: 'TESTING',
  style: 'STYLE',
} as const satisfies Record<Category, DbFindingCategory>;

const CATEGORY_FROM_DB = {
  BUG: 'bug',
  SECURITY: 'security',
  PERFORMANCE: 'performance',
  ARCHITECTURE: 'architecture',
  MAINTAINABILITY: 'maintainability',
  TESTING: 'testing',
  STYLE: 'style',
} as const satisfies Record<DbFindingCategory, Category>;

const FINDING_STATUS_TO_DB = {
  draft: 'DRAFT',
  validated: 'VALIDATED',
  published: 'PUBLISHED',
  dismissed: 'DISMISSED',
  resolved: 'RESOLVED',
  stale: 'STALE',
  suppressed: 'SUPPRESSED',
} as const satisfies Record<FindingStatus, DbFindingStatus>;

const FINDING_STATUS_FROM_DB = {
  DRAFT: 'draft',
  VALIDATED: 'validated',
  PUBLISHED: 'published',
  DISMISSED: 'dismissed',
  RESOLVED: 'resolved',
  STALE: 'stale',
  SUPPRESSED: 'suppressed',
} as const satisfies Record<DbFindingStatus, FindingStatus>;

const FINDING_SOURCE_TO_DB = {
  agent: 'AGENT',
  static_analysis: 'STATIC_ANALYSIS',
  security_scan: 'SECURITY_SCAN',
  test_execution: 'TEST_EXECUTION',
  human: 'HUMAN',
} as const satisfies Record<FindingSource, DbFindingSource>;

const FINDING_SOURCE_FROM_DB = {
  AGENT: 'agent',
  STATIC_ANALYSIS: 'static_analysis',
  SECURITY_SCAN: 'security_scan',
  TEST_EXECUTION: 'test_execution',
  HUMAN: 'human',
} as const satisfies Record<DbFindingSource, FindingSource>;

const EXECUTION_STATUS_TO_DB = {
  pending: 'PENDING',
  running: 'RUNNING',
  succeeded: 'SUCCEEDED',
  failed: 'FAILED',
  skipped: 'SKIPPED',
  timed_out: 'TIMED_OUT',
} as const satisfies Record<ExecutionStatus, DbExecutionStatus>;

const EXECUTION_STATUS_FROM_DB = {
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  TIMED_OUT: 'timed_out',
} as const satisfies Record<DbExecutionStatus, ExecutionStatus>;

const COMMAND_KIND_TO_DB = {
  test: 'TEST',
  lint: 'LINT',
  typecheck: 'TYPECHECK',
  build: 'BUILD',
  static_analysis: 'STATIC_ANALYSIS',
  security_scan: 'SECURITY_SCAN',
} as const satisfies Record<CommandKind, DbExecutionKind>;

const COMMAND_KIND_FROM_DB = {
  TEST: 'test',
  LINT: 'lint',
  TYPECHECK: 'typecheck',
  BUILD: 'build',
  STATIC_ANALYSIS: 'static_analysis',
  SECURITY_SCAN: 'security_scan',
} as const satisfies Record<DbExecutionKind, CommandKind>;

const RUN_STATUS_TO_DB = {
  queued: 'QUEUED',
  running: 'RUNNING',
  completed: 'COMPLETED',
  failed: 'FAILED',
  cancelled: 'CANCELLED',
  awaiting_approval: 'AWAITING_APPROVAL',
} as const satisfies Record<ReviewRunStatus, DbReviewRunStatus>;

const RUN_STATUS_FROM_DB = {
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  AWAITING_APPROVAL: 'awaiting_approval',
} as const satisfies Record<DbReviewRunStatus, ReviewRunStatus>;

const TRIGGER_TO_DB = {
  webhook: 'WEBHOOK',
  manual: 'MANUAL',
  retry: 'RETRY',
} as const satisfies Record<ReviewTrigger, DbReviewTrigger>;

const TRIGGER_FROM_DB = {
  WEBHOOK: 'webhook',
  MANUAL: 'manual',
  RETRY: 'retry',
} as const satisfies Record<DbReviewTrigger, ReviewTrigger>;

const VERDICT_TO_DB = {
  passed: 'PASSED',
  neutral: 'NEUTRAL',
  failed: 'FAILED',
} as const satisfies Record<ReviewVerdict, DbReviewVerdict>;

const VERDICT_FROM_DB = {
  PASSED: 'passed',
  NEUTRAL: 'neutral',
  FAILED: 'failed',
} as const satisfies Record<DbReviewVerdict, ReviewVerdict>;

export const toDbSeverity = (value: Severity): DbSeverity => SEVERITY_TO_DB[value];
export const fromDbSeverity = (value: DbSeverity): Severity => SEVERITY_FROM_DB[value];
export const toDbCategory = (value: Category): DbFindingCategory => CATEGORY_TO_DB[value];
export const fromDbCategory = (value: DbFindingCategory): Category => CATEGORY_FROM_DB[value];
export const toDbFindingStatus = (value: FindingStatus): DbFindingStatus => FINDING_STATUS_TO_DB[value];
export const fromDbFindingStatus = (value: DbFindingStatus): FindingStatus => FINDING_STATUS_FROM_DB[value];
export const toDbFindingSource = (value: FindingSource): DbFindingSource => FINDING_SOURCE_TO_DB[value];
export const fromDbFindingSource = (value: DbFindingSource): FindingSource => FINDING_SOURCE_FROM_DB[value];
export const toDbExecutionStatus = (value: ExecutionStatus): DbExecutionStatus =>
  EXECUTION_STATUS_TO_DB[value];
export const fromDbExecutionStatus = (value: DbExecutionStatus): ExecutionStatus =>
  EXECUTION_STATUS_FROM_DB[value];
export const toDbCommandKind = (value: CommandKind): DbExecutionKind => COMMAND_KIND_TO_DB[value];
export const fromDbCommandKind = (value: DbExecutionKind): CommandKind => COMMAND_KIND_FROM_DB[value];
export const toDbRunStatus = (value: ReviewRunStatus): DbReviewRunStatus => RUN_STATUS_TO_DB[value];
export const fromDbRunStatus = (value: DbReviewRunStatus): ReviewRunStatus => RUN_STATUS_FROM_DB[value];
export const toDbTrigger = (value: ReviewTrigger): DbReviewTrigger => TRIGGER_TO_DB[value];
export const fromDbTrigger = (value: DbReviewTrigger): ReviewTrigger => TRIGGER_FROM_DB[value];
export const toDbVerdict = (value: ReviewVerdict): DbReviewVerdict => VERDICT_TO_DB[value];
export const fromDbVerdict = (value: DbReviewVerdict): ReviewVerdict => VERDICT_FROM_DB[value];
export const toDbSandboxKind = (value: 'docker' | 'process'): DbSandboxKind =>
  value === 'docker' ? 'DOCKER' : 'PROCESS';
export const fromDbSandboxKind = (value: DbSandboxKind): 'docker' | 'process' =>
  value === 'DOCKER' ? 'docker' : 'process';

const PERMISSION_LEVEL_FROM_DB = {
  READ: 'read',
  TRIAGE: 'triage',
  WRITE: 'write',
  MAINTAIN: 'maintain',
  ADMIN: 'admin',
} as const satisfies Record<DbRepositoryPermission, RepositoryPermissionLevel>;

const PERMISSION_LEVEL_TO_DB = {
  read: 'READ',
  triage: 'TRIAGE',
  write: 'WRITE',
  maintain: 'MAINTAIN',
  admin: 'ADMIN',
} as const satisfies Record<RepositoryPermissionLevel, DbRepositoryPermission>;

export const fromDbRepositoryPermission = (value: DbRepositoryPermission): RepositoryPermissionLevel =>
  PERMISSION_LEVEL_FROM_DB[value];
export const toDbRepositoryPermission = (value: RepositoryPermissionLevel): DbRepositoryPermission =>
  PERMISSION_LEVEL_TO_DB[value];

export const fromDbUserRole = (value: DbUserRole): 'admin' | 'member' =>
  value === 'ADMIN' ? 'admin' : 'member';

const WEBHOOK_STATUS_FROM_DB = {
  RECEIVED: 'received',
  PROCESSED: 'processed',
  IGNORED: 'ignored',
  FAILED: 'failed',
} as const satisfies Record<DbWebhookEventStatus, 'received' | 'processed' | 'ignored' | 'failed'>;

export const fromDbWebhookStatus = (
  value: DbWebhookEventStatus,
): 'received' | 'processed' | 'ignored' | 'failed' => WEBHOOK_STATUS_FROM_DB[value];

const APPROVAL_STATUS_FROM_DB = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
} as const satisfies Record<DbApprovalStatus, 'pending' | 'approved' | 'rejected' | 'expired'>;

export const fromDbApprovalStatus = (
  value: DbApprovalStatus,
): 'pending' | 'approved' | 'rejected' | 'expired' => APPROVAL_STATUS_FROM_DB[value];

const PULL_REQUEST_STATE_FROM_DB = {
  OPEN: 'open',
  CLOSED: 'closed',
  MERGED: 'merged',
} as const satisfies Record<DbPullRequestState, 'open' | 'closed' | 'merged'>;

export const fromDbPullRequestState = (value: DbPullRequestState): 'open' | 'closed' | 'merged' =>
  PULL_REQUEST_STATE_FROM_DB[value];

export interface RepositoryRow {
  readonly id: string;
  readonly githubId: string;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly installationId: string | null;
  readonly defaultBranch: string;
  readonly isPrivate: boolean;
  readonly language: string | null;
  readonly isActive: boolean;
}

export function toRepositoryRef(row: RepositoryRow): RepositoryRef {
  return {
    owner: row.owner,
    name: row.name,
    fullName: row.fullName,
    installationId: row.installationId === null ? null : Number(row.installationId),
    defaultBranch: row.defaultBranch,
    private: row.isPrivate,
  };
}

export interface PullRequestRow {
  readonly id: string;
  readonly githubId: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly author: string;
  readonly state: DbPullRequestState;
  readonly draft: boolean;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly headRef: string;
  readonly headSha: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly url: string;
  readonly labels: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly mergedAt: Date | null;
  readonly closedAt: Date | null;
}

export function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
}

export function toPullRequestInfo(row: PullRequestRow): PullRequestInfo {
  return {
    id: Number(row.githubId),
    number: row.number,
    title: row.title,
    body: row.body,
    author: row.author,
    state: fromDbPullRequestState(row.state),
    draft: row.draft,
    baseRef: row.baseRef,
    baseSha: row.baseSha,
    headRef: row.headRef,
    headSha: row.headSha,
    additions: row.additions,
    deletions: row.deletions,
    changedFiles: row.changedFiles,
    url: row.url,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    mergedAt: row.mergedAt === null ? null : row.mergedAt.toISOString(),
    labels: toStringArray(row.labels),
  };
}
