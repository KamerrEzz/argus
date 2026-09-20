import { Prisma, type PrismaClient } from '@prisma/client';
import {
  ConflictError,
  DatabaseError,
  NotFoundError,
  isAppError,
  parseRepositorySettings,
  type AgentExecutionFinish,
  type AgentExecutionStart,
  type ChangedFile,
  type CheckExecutionRecord,
  type CompleteReviewRunInput,
  type CreateReviewRunInput,
  type NodeExecutionRecord,
  type PersistedFinding,
  type PersistedFindingInput,
  type PriorFindingReference,
  type ReviewPersistencePort,
  type ReviewPlan,
  type ReviewRunTarget,
  type ReviewRunStatus,
  type ToolExecutionRecord,
} from '@acr/shared';
import {
  fromDbCategory,
  fromDbFindingSource,
  fromDbFindingStatus,
  fromDbRunStatus,
  fromDbSeverity,
  fromDbTrigger,
  toDbCategory,
  toDbCommandKind,
  toDbExecutionStatus,
  toDbFindingSource,
  toDbFindingStatus,
  toDbRunStatus,
  toDbSandboxKind,
  toDbSeverity,
  toDbTrigger,
  toDbVerdict,
  toPullRequestInfo,
  toRepositoryRef,
} from './mappers';

function translateDatabaseError(operation: string, error: unknown): Error {
  if (isAppError(error)) {
    return error;
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = error.meta as Record<string, unknown> | undefined;
    if (error.code === 'P2025') {
      return new NotFoundError(`Database record for ${operation}`, meta);
    }
    if (error.code === 'P2002') {
      return new ConflictError(`Unique constraint violation during ${operation}`, meta);
    }
    if (error.code === 'P2003') {
      return new ConflictError(`Foreign key violation during ${operation}`, meta);
    }
    return new DatabaseError(`${operation} failed (${error.code})`, { details: meta, cause: error });
  }
  if (error instanceof Prisma.PrismaClientInitializationError) {
    return new DatabaseError(`Database connection failed during ${operation}`, { cause: error });
  }
  return new DatabaseError(`${operation} failed`, { cause: error });
}

export class PrismaReviewStore implements ReviewPersistencePort {
  constructor(private readonly prisma: PrismaClient) {}

  private async guarded<T>(operation: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw translateDatabaseError(operation, error);
    }
  }

  async getReviewTarget(reviewRunId: string): Promise<ReviewRunTarget | null> {
    return this.guarded('getReviewTarget', async () => {
      const run = await this.prisma.reviewRun.findUnique({
        where: { id: reviewRunId },
        include: { repository: true, pullRequest: true },
      });
      if (run === null) {
        return null;
      }
      const previous = await this.prisma.reviewRun.findFirst({
        where: {
          pullRequestId: run.pullRequestId,
          id: { not: run.id },
          status: { in: ['COMPLETED', 'FAILED'] },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      return {
        reviewRunId: run.id,
        repositoryId: run.repositoryId,
        repository: toRepositoryRef(run.repository),
        pullRequestId: run.pullRequestId,
        pullRequest: toPullRequestInfo(run.pullRequest),
        trigger: fromDbTrigger(run.trigger),
        settings: parseRepositorySettings(run.repository.settings),
        previousReviewRunId: previous?.id ?? null,
      };
    });
  }

  async findReviewRunByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<{ id: string; status: ReviewRunStatus } | null> {
    return this.guarded('findReviewRunByIdempotencyKey', async () => {
      const run = await this.prisma.reviewRun.findUnique({
        where: { idempotencyKey },
        select: { id: true, status: true },
      });
      return run === null ? null : { id: run.id, status: fromDbRunStatus(run.status) };
    });
  }

  async createReviewRun(input: CreateReviewRunInput): Promise<{ id: string; created: boolean }> {
    return this.guarded('createReviewRun', async () => {
      try {
        const created = await this.prisma.reviewRun.create({
          data: {
            repositoryId: input.repositoryId,
            pullRequestId: input.pullRequestId,
            trigger: toDbTrigger(input.trigger),
            headSha: input.headSha,
            baseSha: input.baseSha,
            idempotencyKey: input.idempotencyKey,
            model: input.model,
            status: 'QUEUED',
          },
          select: { id: true },
        });
        return { id: created.id, created: true };
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          const existing = await this.prisma.reviewRun.findUnique({
            where: { idempotencyKey: input.idempotencyKey },
            select: { id: true },
          });
          if (existing !== null) {
            return { id: existing.id, created: false };
          }
        }
        throw error;
      }
    });
  }

  async markReviewRunRunning(reviewRunId: string, startedAt: Date): Promise<void> {
    await this.guarded('markReviewRunRunning', async () => {
      await this.prisma.reviewRun.update({
        where: { id: reviewRunId },
        data: { status: 'RUNNING', startedAt },
      });
    });
  }

  async saveChangedFiles(reviewRunId: string, files: readonly ChangedFile[], diff: string): Promise<void> {
    await this.guarded('saveChangedFiles', async () => {
      await this.prisma.reviewRun.update({
        where: { id: reviewRunId },
        data: {
          changedFiles: files as unknown as Prisma.InputJsonValue,
          diff,
          filesAnalyzed: files.length,
        },
      });
    });
  }

  async savePlan(reviewRunId: string, plan: ReviewPlan, reasons: readonly string[]): Promise<void> {
    await this.guarded('savePlan', async () => {
      await this.prisma.reviewRun.update({
        where: { id: reviewRunId },
        data: {
          plan: plan as unknown as Prisma.InputJsonValue,
          planReasons: reasons as unknown as Prisma.InputJsonValue,
        },
      });
    });
  }

  async saveExecutions(reviewRunId: string, records: readonly CheckExecutionRecord[]): Promise<void> {
    if (records.length === 0) {
      return;
    }
    await this.guarded('saveExecutions', async () => {
      await this.prisma.testExecution.createMany({
        data: records.map((record) => ({
          reviewRunId,
          kind: toDbCommandKind(record.kind),
          tool: record.tool,
          command: record.command,
          status: toDbExecutionStatus(record.status),
          exitCode: record.exitCode,
          durationMs: Math.max(0, Math.round(record.durationMs)),
          stdout: record.stdout,
          stderr: record.stderr,
          timedOut: record.timedOut,
          sandbox: toDbSandboxKind(record.sandbox),
          image: record.image,
          summary: record.summary,
          details: (record.details ?? undefined) as Prisma.InputJsonValue | undefined,
          skippedReason: record.skippedReason,
        })),
      });
    });
  }

  async saveFindings(
    reviewRunId: string,
    findings: readonly PersistedFindingInput[],
  ): Promise<readonly PersistedFinding[]> {
    if (findings.length === 0) {
      return [];
    }
    return this.guarded('saveFindings', async () => {
      const run = await this.prisma.reviewRun.findUnique({
        where: { id: reviewRunId },
        select: { pullRequestId: true },
      });
      if (run === null) {
        throw new NotFoundError('ReviewRun', { reviewRunId });
      }
      await this.prisma.reviewFinding.createMany({
        data: findings.map((entry) => ({
          reviewRunId,
          pullRequestId: run.pullRequestId,
          fingerprint: entry.fingerprint,
          severity: toDbSeverity(entry.draft.severity),
          category: toDbCategory(entry.draft.category),
          status: toDbFindingStatus(entry.status),
          title: entry.draft.title,
          description: entry.draft.description,
          file: entry.draft.file,
          line: entry.draft.line,
          endLine: entry.draft.endLine,
          suggestion: entry.draft.suggestion,
          evidence: entry.draft.evidence,
          confidence: entry.draft.confidence,
          confidenceBand: entry.confidenceBand,
          publishable: entry.publishable,
          source: toDbFindingSource(entry.draft.source),
          ruleId: entry.draft.ruleId,
          validationReasons: entry.validationReasons as unknown as Prisma.InputJsonValue,
          metadata: (entry.draft.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
        })),
        skipDuplicates: true,
      });

      const rows = await this.prisma.reviewFinding.findMany({
        where: { reviewRunId, fingerprint: { in: findings.map((entry) => entry.fingerprint) } },
      });

      return rows.map((row) => ({
        id: row.id,
        fingerprint: row.fingerprint,
        publishable: row.publishable,
        status: fromDbFindingStatus(row.status),
        validationReasons: Array.isArray(row.validationReasons)
          ? (row.validationReasons as unknown[]).filter((entry): entry is string => typeof entry === 'string')
          : [],
        confidenceBand: row.confidenceBand === 'high' ? 'high' : row.confidenceBand === 'medium' ? 'medium' : 'low',
        draft: {
          severity: fromDbSeverity(row.severity),
          category: fromDbCategory(row.category),
          title: row.title,
          description: row.description,
          file: row.file,
          line: row.line,
          endLine: row.endLine,
          suggestion: row.suggestion,
          confidence: row.confidence,
          evidence: row.evidence,
          source: fromDbFindingSource(row.source),
          ruleId: row.ruleId,
          metadata: (row.metadata ?? null) as Record<string, unknown> | null,
        },
        createdAt: row.createdAt.toISOString(),
      }));
    });
  }

  async markFindingsPublished(
    reviewRunId: string,
    published: readonly { readonly fingerprint: string; readonly commentId: number | null }[],
  ): Promise<void> {
    if (published.length === 0) {
      return;
    }
    await this.guarded('markFindingsPublished', async () => {
      for (const entry of published) {
        await this.prisma.reviewFinding.updateMany({
          where: { reviewRunId, fingerprint: entry.fingerprint },
          data: {
            status: 'PUBLISHED',
            publishedAt: new Date(),
            githubCommentId: entry.commentId === null ? null : String(entry.commentId),
          },
        });
      }
    });
  }

  async loadPreviousFindings(
    pullRequestId: string,
    excludeReviewRunId: string,
  ): Promise<readonly PriorFindingReference[]> {
    return this.guarded('loadPreviousFindings', async () => {
      const rows = await this.prisma.reviewFinding.findMany({
        where: {
          pullRequestId,
          reviewRunId: { not: excludeReviewRunId },
          status: { in: ['PUBLISHED', 'VALIDATED', 'DISMISSED', 'SUPPRESSED', 'RESOLVED', 'STALE'] },
        },
        orderBy: { createdAt: 'desc' },
        distinct: ['fingerprint'],
        select: {
          fingerprint: true,
          status: true,
          severity: true,
          title: true,
          file: true,
          line: true,
        },
      });
      return rows.map((row) => ({
        fingerprint: row.fingerprint,
        status: fromDbFindingStatus(row.status),
        severity: fromDbSeverity(row.severity),
        title: row.title,
        file: row.file,
        line: row.line,
      }));
    });
  }

  async startAgentExecution(input: AgentExecutionStart): Promise<string> {
    return this.guarded('startAgentExecution', async () => {
      const created = await this.prisma.agentExecution.create({
        data: {
          reviewRunId: input.reviewRunId,
          graphName: input.graphName,
          model: input.model,
          startedAt: input.startedAt,
          status: 'RUNNING',
        },
        select: { id: true },
      });
      return created.id;
    });
  }

  async finishAgentExecution(agentExecutionId: string, result: AgentExecutionFinish): Promise<void> {
    await this.guarded('finishAgentExecution', async () => {
      await this.prisma.agentExecution.update({
        where: { id: agentExecutionId },
        data: {
          status: toDbExecutionStatus(result.status === 'succeeded' ? 'succeeded' : 'failed'),
          finishedAt: result.finishedAt,
          durationMs: Math.max(0, Math.round(result.durationMs)),
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          estimatedCostUsd: result.estimatedCostUsd.toFixed(6),
          error: result.error,
          currentNode: result.finalNode,
          iterations: result.iterations,
          toolCalls: result.toolCalls,
        },
      });
      await this.prisma.reviewRun.update({
        where: { id: (await this.agentRunId(agentExecutionId)) },
        data: {
          iterations: result.iterations,
          toolCalls: result.toolCalls,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          estimatedCostUsd: result.estimatedCostUsd.toFixed(6),
        },
      });
    });
  }

  private async agentRunId(agentExecutionId: string): Promise<string> {
    const row = await this.prisma.agentExecution.findUnique({
      where: { id: agentExecutionId },
      select: { reviewRunId: true },
    });
    if (row === null) {
      throw new NotFoundError('AgentExecution', { agentExecutionId });
    }
    return row.reviewRunId;
  }

  async recordNodeExecution(record: NodeExecutionRecord): Promise<void> {
    await this.guarded('recordNodeExecution', async () => {
      await this.prisma.agentNodeExecution.create({
        data: {
          reviewRunId: record.reviewRunId,
          agentExecutionId: record.agentExecutionId,
          node: record.node,
          attempt: record.attempt,
          status: toDbExecutionStatus(record.status),
          summary: record.summary,
          inputMetadata: (record.inputMetadata ?? undefined) as Prisma.InputJsonValue | undefined,
          outputMetadata: (record.outputMetadata ?? undefined) as Prisma.InputJsonValue | undefined,
          error: record.error,
          startedAt: record.startedAt,
          finishedAt: record.finishedAt,
          durationMs: Math.max(0, Math.round(record.durationMs)),
        },
      });
    });
  }

  async recordToolExecution(record: ToolExecutionRecord): Promise<void> {
    await this.guarded('recordToolExecution', async () => {
      await this.prisma.toolExecution.create({
        data: {
          reviewRunId: record.reviewRunId,
          agentExecutionId: record.agentExecutionId,
          tool: record.tool,
          status: record.status === 'denied' ? 'FAILED' : toDbExecutionStatus(record.status),
          inputMetadata: (record.inputMetadata ?? undefined) as Prisma.InputJsonValue | undefined,
          outputMetadata: (record.outputMetadata ?? undefined) as Prisma.InputJsonValue | undefined,
          error: record.error,
          startedAt: record.startedAt,
          finishedAt: record.finishedAt,
          durationMs: Math.max(0, Math.round(record.durationMs)),
        },
      });
    });
  }

  async completeReviewRun(reviewRunId: string, input: CompleteReviewRunInput): Promise<void> {
    await this.guarded('completeReviewRun', async () => {
      const grouped = await this.prisma.reviewFinding.groupBy({
        by: ['severity'],
        where: { reviewRunId, publishable: true },
        _count: { _all: true },
      });
      const counts: Record<string, number> = {};
      let total = 0;
      for (const group of grouped) {
        counts[group.severity] = group._count._all;
        total += group._count._all;
      }
      await this.prisma.reviewRun.update({
        where: { id: reviewRunId },
        data: {
          status: toDbRunStatus(input.status),
          verdict: input.verdict === null ? null : toDbVerdict(input.verdict),
          summary: input.summary,
          finishedAt: input.finishedAt,
          durationMs: Math.max(0, Math.round(input.durationMs)),
          tokensIn: input.tokensIn,
          tokensOut: input.tokensOut,
          estimatedCostUsd: input.estimatedCostUsd.toFixed(6),
          error: input.error,
          budgetLimit: input.budgetExceeded === null ? null : input.budgetExceeded.limit,
          findingsTotal: total,
          criticalCount: counts.CRITICAL ?? 0,
          highCount: counts.HIGH ?? 0,
          mediumCount: counts.MEDIUM ?? 0,
          lowCount: counts.LOW ?? 0,
          infoCount: counts.INFO ?? 0,
        },
      });
    });
  }

  async markReviewPublished(
    reviewRunId: string,
    refs: { readonly commentId: number | null; readonly checkRunId: number | null },
  ): Promise<void> {
    await this.guarded('markReviewPublished', async () => {
      await this.prisma.reviewRun.update({
        where: { id: reviewRunId },
        data: {
          commentId: refs.commentId === null ? null : String(refs.commentId),
          checkRunId: refs.checkRunId === null ? null : String(refs.checkRunId),
          publishedAt: new Date(),
        },
      });
    });
  }
}
