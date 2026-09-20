import type { PrismaClient } from '@prisma/client';
import { parseRepositorySettings, type RepositorySettings, type ReviewTrigger } from '@acr/shared';
import {
  fromDbCategory,
  fromDbCommandKind,
  fromDbExecutionStatus,
  fromDbFindingSource,
  fromDbFindingStatus,
  fromDbPullRequestState,
  fromDbRunStatus,
  fromDbSandboxKind,
  fromDbSeverity,
  fromDbTrigger,
  fromDbVerdict,
  fromDbWebhookStatus,
} from './mappers';

export interface Page {
  readonly take: number;
  readonly skip: number;
}

export interface PaginatedResult<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly take: number;
  readonly skip: number;
}

export interface RepositoryListItem {
  readonly id: string;
  readonly githubId: string;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly isPrivate: boolean;
  readonly isActive: boolean;
  readonly language: string | null;
  readonly installationId: string | null;
  readonly settings: RepositorySettings;
  readonly createdAt: string;
  readonly lastSyncedAt: string | null;
  readonly counts: {
    readonly pullRequests: number;
    readonly reviewRuns: number;
    readonly findings: number;
    readonly pendingReviews: number;
  };
}

export interface RepositoryFilter extends Page {
  readonly repositoryIds?: readonly string[] | undefined;
  readonly search?: string | undefined;
  readonly isActive?: boolean | undefined;
}

async function countFindingsByRepository(
  prisma: PrismaClient,
  repositoryIds: readonly string[],
): Promise<Map<string, number>> {
  const output = new Map<string, number>();
  if (repositoryIds.length === 0) {
    return output;
  }
  const runs = await prisma.reviewRun.findMany({
    where: { repositoryId: { in: [...repositoryIds] } },
    select: { id: true, repositoryId: true },
  });
  if (runs.length === 0) {
    return output;
  }
  const runToRepository = new Map(runs.map((run) => [run.id, run.repositoryId]));
  const grouped = await prisma.reviewFinding.groupBy({
    by: ['reviewRunId'],
    where: {
      reviewRunId: { in: [...runToRepository.keys()] },
      publishable: true,
      status: { in: ['PUBLISHED', 'VALIDATED'] },
    },
    _count: { _all: true },
  });
  for (const group of grouped) {
    const repositoryId = runToRepository.get(group.reviewRunId);
    if (repositoryId === undefined) {
      continue;
    }
    output.set(repositoryId, (output.get(repositoryId) ?? 0) + group._count._all);
  }
  return output;
}

export async function listRepositories(
  prisma: PrismaClient,
  filter: RepositoryFilter,
): Promise<PaginatedResult<RepositoryListItem>> {
  const where = {
    ...(filter.repositoryIds === undefined ? {} : { id: { in: [...filter.repositoryIds] } }),
    ...(filter.isActive === undefined ? {} : { isActive: filter.isActive }),
    ...(filter.search === undefined || filter.search.trim() === ''
      ? {}
      : {
          OR: [
            { fullName: { contains: filter.search, mode: 'insensitive' as const } },
            { owner: { contains: filter.search, mode: 'insensitive' as const } },
            { name: { contains: filter.search, mode: 'insensitive' as const } },
          ],
        }),
  };

  const [rows, total] = await Promise.all([
    prisma.repository.findMany({
      where,
      orderBy: { fullName: 'asc' },
      take: filter.take,
      skip: filter.skip,
      include: {
        _count: { select: { pullRequests: true, reviewRuns: true } },
      },
    }),
    prisma.repository.count({ where }),
  ]);

  const ids = rows.map((row) => row.id);
  const [findingsByRepository, pendingByRepository] = await Promise.all([
    countFindingsByRepository(prisma, ids),
    prisma.reviewRun
      .groupBy({
        by: ['repositoryId'],
        where: { repositoryId: { in: ids }, status: { in: ['QUEUED', 'RUNNING'] } },
        _count: { _all: true },
      })
      .then((groups) => new Map(groups.map((group) => [group.repositoryId, group._count._all]))),
  ]);

  return {
    items: rows.map((row) => ({
      id: row.id,
      githubId: row.githubId,
      owner: row.owner,
      name: row.name,
      fullName: row.fullName,
      defaultBranch: row.defaultBranch,
      isPrivate: row.isPrivate,
      isActive: row.isActive,
      language: row.language,
      installationId: row.installationId,
      settings: parseRepositorySettings(row.settings),
      createdAt: row.createdAt.toISOString(),
      lastSyncedAt: row.lastSyncedAt === null ? null : row.lastSyncedAt.toISOString(),
      counts: {
        pullRequests: row._count.pullRequests,
        reviewRuns: row._count.reviewRuns,
        findings: findingsByRepository.get(row.id) ?? 0,
        pendingReviews: pendingByRepository.get(row.id) ?? 0,
      },
    })),
    total,
    take: filter.take,
    skip: filter.skip,
  };
}

export async function getRepositoryDetail(
  prisma: PrismaClient,
  repositoryId: string,
): Promise<Record<string, unknown> | null> {
  const row = await prisma.repository.findUnique({
    where: { id: repositoryId },
    include: {
      _count: { select: { pullRequests: true, reviewRuns: true, access: true } },
      access: {
        include: { user: { select: { id: true, email: true, name: true } } },
        orderBy: { grantedAt: 'asc' },
      },
    },
  });
  if (row === null) {
    return null;
  }
  const findings = await countFindingsByRepository(prisma, [repositoryId]);
  const recentRuns = await prisma.reviewRun.findMany({
    where: { repositoryId },
    orderBy: { createdAt: 'desc' },
    take: 10,
    include: { pullRequest: { select: { id: true, number: true, title: true } } },
  });
  return {
    id: row.id,
    githubId: row.githubId,
    owner: row.owner,
    name: row.name,
    fullName: row.fullName,
    defaultBranch: row.defaultBranch,
    isPrivate: row.isPrivate,
    isActive: row.isActive,
    language: row.language,
    installationId: row.installationId,
    settings: parseRepositorySettings(row.settings),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastSyncedAt: row.lastSyncedAt === null ? null : row.lastSyncedAt.toISOString(),
    counts: {
      pullRequests: row._count.pullRequests,
      reviewRuns: row._count.reviewRuns,
      members: row._count.access,
      findings: findings.get(repositoryId) ?? 0,
    },
    access: row.access.map((entry) => ({
      id: entry.id,
      userId: entry.user.id,
      email: entry.user.email,
      name: entry.user.name,
      permission: entry.permission.toLowerCase(),
      grantedAt: entry.grantedAt.toISOString(),
    })),
    recentReviews: recentRuns.map((run) => ({
      id: run.id,
      status: fromDbRunStatus(run.status),
      verdict: run.verdict === null ? null : fromDbVerdict(run.verdict),
      createdAt: run.createdAt.toISOString(),
      findingsTotal: run.findingsTotal,
      pullRequest: run.pullRequest,
    })),
  };
}

export interface PullRequestFilter extends Page {
  readonly repositoryIds?: readonly string[] | undefined;
  readonly repositoryId?: string | undefined;
  readonly state?: 'open' | 'closed' | 'merged' | undefined;
  readonly search?: string | undefined;
}

export async function listPullRequests(
  prisma: PrismaClient,
  filter: PullRequestFilter,
): Promise<PaginatedResult<Record<string, unknown>>> {
  const stateFilter =
    filter.state === undefined
      ? {}
      : { state: (filter.state === 'open' ? 'OPEN' : filter.state === 'closed' ? 'CLOSED' : 'MERGED') as 'OPEN' | 'CLOSED' | 'MERGED' };

  const where = {
    ...stateFilter,
    ...(filter.repositoryId === undefined ? {} : { repositoryId: filter.repositoryId }),
    ...(filter.repositoryIds === undefined ? {} : { repositoryId: { in: [...filter.repositoryIds] } }),
    ...(filter.search === undefined || filter.search.trim() === ''
      ? {}
      : {
          OR: [
            { title: { contains: filter.search, mode: 'insensitive' as const } },
            { author: { contains: filter.search, mode: 'insensitive' as const } },
          ],
        }),
  };

  const [rows, total] = await Promise.all([
    prisma.pullRequest.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take: filter.take,
      skip: filter.skip,
      include: {
        repository: { select: { id: true, fullName: true } },
        _count: { select: { reviewRuns: true, findings: true } },
        reviewRuns: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, status: true, verdict: true, createdAt: true },
        },
      },
    }),
    prisma.pullRequest.count({ where }),
  ]);

  return {
    items: rows.map((row) => ({
      id: row.id,
      githubId: row.githubId,
      number: row.number,
      title: row.title,
      author: row.author,
      state: fromDbPullRequestState(row.state),
      draft: row.draft,
      baseRef: row.baseRef,
      headRef: row.headRef,
      headSha: row.headSha,
      additions: row.additions,
      deletions: row.deletions,
      changedFiles: row.changedFiles,
      url: row.url,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      repository: row.repository,
      counts: {
        reviews: row._count.reviewRuns,
        findings: row._count.findings,
      },
      latestReview:
        row.reviewRuns[0] === undefined
          ? null
          : {
              id: row.reviewRuns[0].id,
              status: fromDbRunStatus(row.reviewRuns[0].status),
              verdict:
                row.reviewRuns[0].verdict === null ? null : fromDbVerdict(row.reviewRuns[0].verdict),
              createdAt: row.reviewRuns[0].createdAt.toISOString(),
            },
    })),
    total,
    take: filter.take,
    skip: filter.skip,
  };
}

export async function getPullRequestDetail(
  prisma: PrismaClient,
  pullRequestId: string,
): Promise<Record<string, unknown> | null> {
  const row = await prisma.pullRequest.findUnique({
    where: { id: pullRequestId },
    include: {
      repository: true,
      reviewRuns: { orderBy: { createdAt: 'desc' }, take: 30 },
    },
  });
  if (row === null) {
    return null;
  }
  return {
    id: row.id,
    githubId: row.githubId,
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
    labels: Array.isArray(row.labels) ? row.labels : [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    repository: {
      id: row.repository.id,
      fullName: row.repository.fullName,
      owner: row.repository.owner,
      name: row.repository.name,
      defaultBranch: row.repository.defaultBranch,
    },
    reviews: row.reviewRuns.map((run) => mapReviewRunSummary(run)),
  };
}

interface ReviewRunRowLike {
  readonly id: string;
  readonly status: Parameters<typeof fromDbRunStatus>[0];
  readonly verdict: Parameters<typeof fromDbVerdict>[0] | null;
  readonly trigger: Parameters<typeof fromDbTrigger>[0];
  readonly headSha: string;
  readonly baseSha: string;
  readonly model: string;
  readonly summary: string | null;
  readonly filesAnalyzed: number;
  readonly findingsTotal: number;
  readonly criticalCount: number;
  readonly highCount: number;
  readonly mediumCount: number;
  readonly lowCount: number;
  readonly infoCount: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly estimatedCostUsd: { toString(): string };
  readonly iterations: number;
  readonly toolCalls: number;
  readonly error: string | null;
  readonly budgetLimit: string | null;
  readonly durationMs: number | null;
  readonly createdAt: Date;
  readonly queuedAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly publishedAt: Date | null;
  readonly commentId: string | null;
  readonly checkRunId: string | null;
}

function mapReviewRunSummary(run: ReviewRunRowLike): Record<string, unknown> {
  return {
    id: run.id,
    status: fromDbRunStatus(run.status),
    verdict: run.verdict === null ? null : fromDbVerdict(run.verdict),
    trigger: fromDbTrigger(run.trigger),
    headSha: run.headSha,
    baseSha: run.baseSha,
    model: run.model,
    summary: run.summary,
    filesAnalyzed: run.filesAnalyzed,
    findings: {
      total: run.findingsTotal,
      critical: run.criticalCount,
      high: run.highCount,
      medium: run.mediumCount,
      low: run.lowCount,
      info: run.infoCount,
    },
    tokens: { input: run.tokensIn, output: run.tokensOut },
    estimatedCostUsd: run.estimatedCostUsd.toString(),
    iterations: run.iterations,
    toolCalls: run.toolCalls,
    error: run.error,
    budgetLimit: run.budgetLimit,
    durationMs: run.durationMs,
    createdAt: run.createdAt.toISOString(),
    queuedAt: run.queuedAt.toISOString(),
    startedAt: run.startedAt === null ? null : run.startedAt.toISOString(),
    finishedAt: run.finishedAt === null ? null : run.finishedAt.toISOString(),
    publishedAt: run.publishedAt === null ? null : run.publishedAt.toISOString(),
    commentId: run.commentId,
    checkRunId: run.checkRunId,
  };
}

export interface ReviewFilter extends Page {
  readonly repositoryIds?: readonly string[] | undefined;
  readonly repositoryId?: string | undefined;
  readonly pullRequestId?: string | undefined;
  readonly status?: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'awaiting_approval' | undefined;
  readonly verdict?: 'passed' | 'neutral' | 'failed' | undefined;
}

function toDbRunStatusFilter(
  status: ReviewFilter['status'],
): 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'AWAITING_APPROVAL' | undefined {
  switch (status) {
    case 'queued':
      return 'QUEUED';
    case 'running':
      return 'RUNNING';
    case 'completed':
      return 'COMPLETED';
    case 'failed':
      return 'FAILED';
    case 'cancelled':
      return 'CANCELLED';
    case 'awaiting_approval':
      return 'AWAITING_APPROVAL';
    default:
      return undefined;
  }
}

export async function listReviewRuns(
  prisma: PrismaClient,
  filter: ReviewFilter,
): Promise<PaginatedResult<Record<string, unknown>>> {
  const statusFilter = toDbRunStatusFilter(filter.status);
  const where = {
    ...(filter.repositoryId === undefined ? {} : { repositoryId: filter.repositoryId }),
    ...(filter.repositoryIds === undefined ? {} : { repositoryId: { in: [...filter.repositoryIds] } }),
    ...(filter.pullRequestId === undefined ? {} : { pullRequestId: filter.pullRequestId }),
    ...(statusFilter === undefined ? {} : { status: statusFilter }),
    ...(filter.verdict === undefined
      ? {}
      : { verdict: (filter.verdict === 'passed' ? 'PASSED' : filter.verdict === 'failed' ? 'FAILED' : 'NEUTRAL') as 'PASSED' | 'FAILED' | 'NEUTRAL' }),
  };

  const [rows, total] = await Promise.all([
    prisma.reviewRun.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: filter.take,
      skip: filter.skip,
      include: {
        repository: { select: { id: true, fullName: true } },
        pullRequest: { select: { id: true, number: true, title: true, author: true, url: true } },
      },
    }),
    prisma.reviewRun.count({ where }),
  ]);

  return {
    items: rows.map((row) => ({
      ...mapReviewRunSummary(row),
      repository: row.repository,
      pullRequest: row.pullRequest,
    })),
    total,
    take: filter.take,
    skip: filter.skip,
  };
}

export async function getReviewRunDetail(
  prisma: PrismaClient,
  reviewRunId: string,
): Promise<Record<string, unknown> | null> {
  const run = await prisma.reviewRun.findUnique({
    where: { id: reviewRunId },
    include: {
      repository: true,
      pullRequest: true,
      findings: { orderBy: [{ severity: 'asc' }, { file: 'asc' }, { line: 'asc' }] },
      testRuns: { orderBy: { createdAt: 'asc' } },
      agentRuns: {
        orderBy: { startedAt: 'asc' },
        include: {
          nodes: { orderBy: { startedAt: 'asc' } },
          tools: { orderBy: { startedAt: 'asc' } },
        },
      },
      approvals: { orderBy: { requestedAt: 'desc' } },
    },
  });
  if (run === null) {
    return null;
  }

  const changedFiles = Array.isArray(run.changedFiles) ? run.changedFiles : [];

  return {
    ...mapReviewRunSummary(run),
    repository: {
      id: run.repository.id,
      fullName: run.repository.fullName,
      owner: run.repository.owner,
      name: run.repository.name,
      defaultBranch: run.repository.defaultBranch,
    },
    pullRequest: {
      id: run.pullRequest.id,
      number: run.pullRequest.number,
      title: run.pullRequest.title,
      author: run.pullRequest.author,
      url: run.pullRequest.url,
      baseRef: run.pullRequest.baseRef,
      headRef: run.pullRequest.headRef,
      draft: run.pullRequest.draft,
      state: fromDbPullRequestState(run.pullRequest.state),
    },
    plan: run.plan,
    planReasons: Array.isArray(run.planReasons) ? run.planReasons : [],
    changedFiles,
    findings: run.findings.map((finding) => ({
      id: finding.id,
      fingerprint: finding.fingerprint,
      severity: fromDbSeverity(finding.severity),
      category: fromDbCategory(finding.category),
      status: fromDbFindingStatus(finding.status),
      title: finding.title,
      description: finding.description,
      file: finding.file,
      line: finding.line,
      endLine: finding.endLine,
      suggestion: finding.suggestion,
      evidence: finding.evidence,
      confidence: finding.confidence,
      confidenceBand: finding.confidenceBand,
      publishable: finding.publishable,
      source: fromDbFindingSource(finding.source),
      ruleId: finding.ruleId,
      validationReasons: Array.isArray(finding.validationReasons) ? finding.validationReasons : [],
      githubCommentId: finding.githubCommentId,
      publishedAt: finding.publishedAt === null ? null : finding.publishedAt.toISOString(),
      createdAt: finding.createdAt.toISOString(),
    })),
    testExecutions: run.testRuns.map((execution) => ({
      id: execution.id,
      kind: fromDbCommandKind(execution.kind),
      tool: execution.tool,
      command: execution.command,
      status: fromDbExecutionStatus(execution.status),
      exitCode: execution.exitCode,
      durationMs: execution.durationMs,
      stdout: execution.stdout,
      stderr: execution.stderr,
      timedOut: execution.timedOut,
      sandbox: fromDbSandboxKind(execution.sandbox),
      image: execution.image,
      summary: execution.summary,
      details: execution.details,
      skippedReason: execution.skippedReason,
      createdAt: execution.createdAt.toISOString(),
    })),
    agentExecutions: run.agentRuns.map((agent) => ({
      id: agent.id,
      graphName: agent.graphName,
      model: agent.model,
      status: fromDbExecutionStatus(agent.status),
      currentNode: agent.currentNode,
      iterations: agent.iterations,
      toolCalls: agent.toolCalls,
      tokensIn: agent.tokensIn,
      tokensOut: agent.tokensOut,
      estimatedCostUsd: agent.estimatedCostUsd.toString(),
      error: agent.error,
      startedAt: agent.startedAt.toISOString(),
      finishedAt: agent.finishedAt === null ? null : agent.finishedAt.toISOString(),
      durationMs: agent.durationMs,
      nodes: agent.nodes.map((node) => ({
        id: node.id,
        node: node.node,
        attempt: node.attempt,
        status: fromDbExecutionStatus(node.status),
        summary: node.summary,
        inputMetadata: node.inputMetadata,
        outputMetadata: node.outputMetadata,
        error: node.error,
        startedAt: node.startedAt.toISOString(),
        finishedAt: node.finishedAt === null ? null : node.finishedAt.toISOString(),
        durationMs: node.durationMs,
      })),
      tools: agent.tools.map((tool) => ({
        id: tool.id,
        tool: tool.tool,
        status: fromDbExecutionStatus(tool.status),
        inputMetadata: tool.inputMetadata,
        outputMetadata: tool.outputMetadata,
        error: tool.error,
        startedAt: tool.startedAt.toISOString(),
        finishedAt: tool.finishedAt === null ? null : tool.finishedAt.toISOString(),
        durationMs: tool.durationMs,
      })),
    })),
    approvals: run.approvals.map((approval) => ({
      id: approval.id,
      action: approval.action,
      status: approval.status.toLowerCase(),
      payload: approval.payload,
      requestedAt: approval.requestedAt.toISOString(),
      decidedAt: approval.decidedAt === null ? null : approval.decidedAt.toISOString(),
      reason: approval.reason,
    })),
  };
}

export interface FindingFilter {
  readonly severity?: string | undefined;
  readonly category?: string | undefined;
  readonly status?: string | undefined;
  readonly publishableOnly?: boolean | undefined;
}

export async function listReviewFindings(
  prisma: PrismaClient,
  reviewRunId: string,
  filter: FindingFilter = {},
): Promise<readonly Record<string, unknown>[]> {
  const severityMap: Record<string, 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO'> = {
    critical: 'CRITICAL',
    high: 'HIGH',
    medium: 'MEDIUM',
    low: 'LOW',
    info: 'INFO',
  };
  const categoryMap: Record<
    string,
    'BUG' | 'SECURITY' | 'PERFORMANCE' | 'ARCHITECTURE' | 'MAINTAINABILITY' | 'TESTING' | 'STYLE'
  > = {
    bug: 'BUG',
    security: 'SECURITY',
    performance: 'PERFORMANCE',
    architecture: 'ARCHITECTURE',
    maintainability: 'MAINTAINABILITY',
    testing: 'TESTING',
    style: 'STYLE',
  };
  const statusMap: Record<
    string,
    'DRAFT' | 'VALIDATED' | 'PUBLISHED' | 'DISMISSED' | 'RESOLVED' | 'STALE' | 'SUPPRESSED'
  > = {
    draft: 'DRAFT',
    validated: 'VALIDATED',
    published: 'PUBLISHED',
    dismissed: 'DISMISSED',
    resolved: 'RESOLVED',
    stale: 'STALE',
    suppressed: 'SUPPRESSED',
  };

  const severity = filter.severity === undefined ? undefined : severityMap[filter.severity];
  const category = filter.category === undefined ? undefined : categoryMap[filter.category];
  const status = filter.status === undefined ? undefined : statusMap[filter.status];

  const rows = await prisma.reviewFinding.findMany({
    where: {
      reviewRunId,
      ...(severity === undefined ? {} : { severity }),
      ...(category === undefined ? {} : { category }),
      ...(status === undefined ? {} : { status }),
      ...(filter.publishableOnly === true ? { publishable: true } : {}),
    },
    orderBy: [{ severity: 'asc' }, { file: 'asc' }, { line: 'asc' }],
  });

  return rows.map((finding) => ({
    id: finding.id,
    fingerprint: finding.fingerprint,
    severity: fromDbSeverity(finding.severity),
    category: fromDbCategory(finding.category),
    status: fromDbFindingStatus(finding.status),
    title: finding.title,
    description: finding.description,
    file: finding.file,
    line: finding.line,
    endLine: finding.endLine,
    suggestion: finding.suggestion,
    evidence: finding.evidence,
    confidence: finding.confidence,
    confidenceBand: finding.confidenceBand,
    publishable: finding.publishable,
    source: fromDbFindingSource(finding.source),
    ruleId: finding.ruleId,
    validationReasons: Array.isArray(finding.validationReasons) ? finding.validationReasons : [],
    createdAt: finding.createdAt.toISOString(),
  }));
}

export async function getDashboardStats(
  prisma: PrismaClient,
  repositoryIds: readonly string[],
): Promise<Record<string, unknown>> {
  const repositoryFilter = { in: [...repositoryIds] };
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [repositories, pullRequests, reviewRuns, failedRuns, activeRuns, findings, recentRuns] =
    await Promise.all([
      prisma.repository.count({ where: { id: repositoryFilter } }),
      prisma.pullRequest.count({ where: { repositoryId: repositoryFilter } }),
      prisma.reviewRun.count({ where: { repositoryId: repositoryFilter } }),
      prisma.reviewRun.count({ where: { repositoryId: repositoryFilter, status: 'FAILED' } }),
      prisma.reviewRun.count({
        where: { repositoryId: repositoryFilter, status: { in: ['QUEUED', 'RUNNING'] } },
      }),
      prisma.reviewFinding.count({
        where: {
          reviewRun: { repositoryId: repositoryFilter },
          publishable: true,
          status: { in: ['PUBLISHED', 'VALIDATED'] },
        },
      }),
      prisma.reviewRun.findMany({
        where: { repositoryId: repositoryFilter, createdAt: { gte: since } },
        select: { createdAt: true, durationMs: true, verdict: true },
      }),
    ]);

  const durations = recentRuns
    .map((run) => run.durationMs)
    .filter((duration): duration is number => duration !== null);
  const averageDurationMs =
    durations.length === 0
      ? 0
      : Math.round(durations.reduce((total, value) => total + value, 0) / durations.length);

  const byDay = new Map<string, number>();
  for (const run of recentRuns) {
    const key = run.createdAt.toISOString().slice(0, 10);
    byDay.set(key, (byDay.get(key) ?? 0) + 1);
  }

  return {
    repositories,
    pullRequests,
    reviewRuns,
    failedRuns,
    activeRuns,
    openFindings: findings,
    averageDurationMs,
    runsLast7Days: [...byDay.entries()]
      .map(([date, count]) => ({ date, count }))
      .sort((left, right) => left.date.localeCompare(right.date)),
    verdicts: {
      passed: recentRuns.filter((run) => run.verdict === 'PASSED').length,
      neutral: recentRuns.filter((run) => run.verdict === 'NEUTRAL').length,
      failed: recentRuns.filter((run) => run.verdict === 'FAILED').length,
    },
  };
}

export async function listWebhookEvents(
  prisma: PrismaClient,
  filter: Page & { readonly status?: string | undefined },
): Promise<PaginatedResult<Record<string, unknown>>> {
  const statusMap: Record<
    string,
    'RECEIVED' | 'PROCESSED' | 'IGNORED' | 'FAILED'
  > = {
    received: 'RECEIVED',
    processed: 'PROCESSED',
    ignored: 'IGNORED',
    failed: 'FAILED',
  };
  const status = filter.status === undefined ? undefined : statusMap[filter.status];
  const where = status === undefined ? {} : { status };
  const [rows, total] = await Promise.all([
    prisma.webhookEvent.findMany({ where, orderBy: { receivedAt: 'desc' }, take: filter.take, skip: filter.skip }),
    prisma.webhookEvent.count({ where }),
  ]);
  return {
    items: rows.map((row) => ({
      id: row.id,
      deliveryId: row.deliveryId,
      event: row.event,
      action: row.action,
      status: fromDbWebhookStatus(row.status),
      repositoryFullName: row.repositoryFullName,
      pullRequestNumber: row.pullRequestNumber,
      reviewRunId: row.reviewRunId,
      error: row.error,
      receivedAt: row.receivedAt.toISOString(),
      processedAt: row.processedAt === null ? null : row.processedAt.toISOString(),
    })),
    total,
    take: filter.take,
    skip: filter.skip,
  };
}

export interface StaleQueuedRun {
  readonly reviewRunId: string;
  readonly trigger: ReviewTrigger;
}

/**
 * Runs still marked QUEUED once the cutoff has passed. Their job is no longer in
 * the queue (the dispatch failed, or Redis was replaced while the row survived),
 * so nothing will ever move them unless they are dispatched again.
 */
export async function listStaleQueuedRuns(
  prisma: PrismaClient,
  options: { readonly olderThan: Date; readonly limit: number },
): Promise<readonly StaleQueuedRun[]> {
  const rows = await prisma.reviewRun.findMany({
    where: { status: 'QUEUED', createdAt: { lt: options.olderThan } },
    orderBy: { createdAt: 'asc' },
    take: options.limit,
    select: { id: true, trigger: true },
  });
  return rows.map((row) => ({ reviewRunId: row.id, trigger: fromDbTrigger(row.trigger) }));
}
