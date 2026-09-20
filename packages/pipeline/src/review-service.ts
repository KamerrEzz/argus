import {
  AppError,
  ConflictError,
  summarizeFindings,
  type FindingDraft,
  type PriorFindingReference,
  type RepoWorkspace,
  type RepositoryRef,
  type RepositorySettings,
  type CheckRunSummary,
  type ReviewEvent,
  type ReviewRunStatus,
  type ReviewRunTarget,
  type ReviewTrigger,
  type ReviewVerdict,
} from '@acr/shared';
import { z } from 'zod';
import { listStaleQueuedRuns } from '@acr/database';
import { runReviewGraph, type ReviewOutcome } from '@acr/ai';
import { CHECK_RUN_NAME } from '@acr/github';
import { QUEUES, type ProcessReviewJob, type PublishReviewJob } from '@acr/queue';
import {
  decideApproval,
  findPendingPublishApproval,
  findRepositoryByFullName,
  requestPublishApproval,
  setReviewRunStatus,
  upsertPullRequest,
  upsertRepository,
  type RepositoryRecord,
} from '@acr/database';
import { buildScriptCatalog, type ScriptCatalog } from './checks';
import type { ApplicationContainer } from './container';
import { assembleReviewPorts, deriveAgentPermissions } from './graph-ports';
import {
  findingSeverityIcon,
  renderCheckRun,
  renderReviewComment,
  sanitizeUntrustedMarkdown,
  type ReviewRenderContext,
} from './markdown';

/** Reviewers need a stable, human-readable name to recognise across runs. */
export { CHECK_RUN_NAME } from '@acr/github';

/** The stored summary is a one-liner for lists; the comment carries the detail. */
export const MAX_SUMMARY_CHARS = 900;

export interface RequestReviewInput {
  /** `owner/name`, as GitHub spells it. */
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly trigger: ReviewTrigger;
  readonly requestedBy?: string;
  readonly idempotencyKey?: string;
}

export interface RequestReviewResult {
  readonly reviewRunId: string;
  readonly created: boolean;
  readonly status: ReviewRunStatus;
  readonly jobId: string | null;
  readonly queued: boolean;
}

/** Accumulator shape for publishing, where each artifact fills in as it lands. */
type MutablePublishedRefs = { -readonly [K in keyof PublishedRefs]: PublishedRefs[K] };

export interface PublishedRefs {
  readonly commentUrl: string | null;
  readonly checkRunUrl: string | null;
  readonly skippedReason: string | null;
}

export interface ReviewExecutionResult {
  readonly reviewRunId: string;
  readonly status: 'completed' | 'failed' | 'skipped';
  readonly verdict: ReviewVerdict | null;
  readonly outcome: ReviewOutcome | null;
  readonly published: PublishedRefs;
  readonly reason: string | null;
  readonly durationMs: number;
  readonly findings: { readonly total: number; readonly publishable: number };
}

function parseFullName(value: string): { owner: string; name: string } {
  const parts = value.trim().replace(/^\/+|\/+$/g, '').split('/');
  const owner = parts[0] ?? '';
  const name = parts[1] ?? '';
  if (parts.length !== 2 || owner.length === 0 || name.length === 0) {
    throw new AppError(`repository must be "owner/name", received "${value}"`, {
      code: 'validation_error',
    });
  }
  return { owner, name };
}

function toRef(record: RepositoryRecord): RepositoryRef {
  const { owner, name } = parseFullName(record.fullName);
  return {
    owner,
    name,
    fullName: record.fullName,
    installationId: record.installationId,
    defaultBranch: record.defaultBranch,
    private: record.isPrivate,
  };
}

/**
 * Creates (or reuses) a review run for a pull request and queues it. Safe to
 * call twice for the same head commit: the second call returns the first run.
 */
export async function requestReview(
  container: ApplicationContainer,
  input: RequestReviewInput,
): Promise<RequestReviewResult> {
  const { prisma, logger } = container;
  const ref = parseFullName(input.repository);
  const fullName = `${ref.owner}/${ref.name}`;

  let record = await findRepositoryByFullName(prisma, fullName);
  if (record === null || record.installationId === null) {
    const remote = await container.github.read.getRepository({
      owner: ref.owner,
      name: ref.name,
      installationId: record?.installationId ?? null,
    });
    record = await upsertRepository(prisma, {
      githubId: remote.id,
      owner: remote.owner,
      name: remote.name,
      fullName: remote.fullName,
      installationId: record?.installationId ?? null,
      defaultBranch: remote.defaultBranch,
      isPrivate: remote.isPrivate,
      language: remote.language,
    });
  }

  const repository = toRef(record);
  const pullRequest = await container.github.read.getPullRequest({
    repository,
    number: input.pullRequestNumber,
  });
  const pullRequestRow = await upsertPullRequest(prisma, record.id, pullRequest);

  const idempotencyKey =
    input.idempotencyKey ?? `${fullName}#${pullRequest.number}@${pullRequest.headSha.slice(0, 12)}`;

  const existing = await container.persistence.findReviewRunByIdempotencyKey(idempotencyKey);
  if (existing !== null) {
    logger.debug({ reviewRunId: existing.id, idempotencyKey }, 'review already requested for this head');
    return {
      reviewRunId: existing.id,
      created: false,
      status: existing.status,
      jobId: null,
      queued: false,
    };
  }

  // Two deliveries for the same head can pass the `findReviewRunByIdempotencyKey`
  // check above concurrently. The unique constraint is the arbiter: on conflict
  // the loser returns the winner's run instead of surfacing a 500 that makes
  // GitHub retry a webhook that already succeeded.
  let created: { id: string; created: boolean };
  try {
    created = await container.persistence.createReviewRun({
      repositoryId: record.id,
      pullRequestId: pullRequestRow.id,
      trigger: input.trigger,
      headSha: pullRequest.headSha,
      baseSha: pullRequest.baseSha,
      idempotencyKey,
      model: container.config.llm.model,
    });
  } catch (error) {
    if (!(error instanceof ConflictError)) {
      throw error;
    }
    const raced = await container.persistence.findReviewRunByIdempotencyKey(idempotencyKey);
    if (raced === null) {
      throw error;
    }
    logger.debug({ reviewRunId: raced.id, idempotencyKey }, 'review created concurrently; reusing it');
    return {
      reviewRunId: raced.id,
      created: false,
      status: raced.status,
      jobId: null,
      queued: false,
    };
  }

  const jobId = await enqueueReview(container, {
    reviewRunId: created.id,
    trigger: input.trigger,
    requestedBy: input.requestedBy,
  });

  return {
    reviewRunId: created.id,
    created: true,
    status: 'queued',
    jobId,
    queued: jobId !== null,
  };
}

/**
 * Deterministic job ids. BullMQ job ids must not contain `:`, and a stable id
 * is what lets the queue reconciler ask whether a QUEUED run still has a job.
 */
export function reviewJobId(reviewRunId: string): string {
  return `review-${reviewRunId}`;
}

export function publishJobId(reviewRunId: string): string {
  return `publish-${reviewRunId}`;
}

/** Push the run onto the queue, or report `null` when this process runs inline. */
export async function enqueueReview(
  container: ApplicationContainer,
  job: ProcessReviewJob,
): Promise<string | null> {
  if (container.queue === null) {
    return null;
  }
  const dispatched = await container.queue.dispatch<ProcessReviewJob>(
    QUEUES.processReview,
    job,
    { jobId: reviewJobId(job.reviewRunId) },
  );
  return dispatched.jobId;
}

export async function enqueuePublish(
  container: ApplicationContainer,
  job: PublishReviewJob,
): Promise<string | null> {
  if (container.queue === null) {
    return null;
  }
  const dispatched = await container.queue.dispatch<PublishReviewJob>(QUEUES.publishReview, job, {
    jobId: publishJobId(job.reviewRunId),
  });
  return dispatched.jobId;
}

/** A QUEUED run older than this has lost the job that was meant to move it. */
export const STALE_QUEUED_MS = 5 * 60_000;

export interface ReconcileOutcome {
  readonly scanned: number;
  readonly requeued: number;
  readonly alive: number;
}

/**
 * A run row can sit in QUEUED with no BullMQ job behind it — the dispatch threw,
 * or Redis was replaced while the row survived. Nothing else notices, so the
 * dashboard counts it as pending work forever and it never runs. On worker start
 * we look for those and re-dispatch only the ones that truly have no live job,
 * so a healthy backlog is never doubled.
 */
export async function reconcileStaleReviews(
  container: ApplicationContainer,
  options: { readonly olderThanMs?: number; readonly now?: Date; readonly limit?: number } = {},
): Promise<ReconcileOutcome> {
  const { queue, logger } = container;
  if (queue === null) {
    return { scanned: 0, requeued: 0, alive: 0 };
  }
  const now = options.now ?? new Date();
  const olderThan = new Date(now.getTime() - (options.olderThanMs ?? STALE_QUEUED_MS));
  const stale = await listStaleQueuedRuns(container.prisma, {
    olderThan,
    limit: options.limit ?? 100,
  });

  let requeued = 0;
  let alive = 0;
  for (const run of stale) {
    if (await queue.hasLiveJob(QUEUES.processReview, reviewJobId(run.reviewRunId))) {
      alive += 1;
      continue;
    }
    const jobId = await enqueueReview(container, {
      reviewRunId: run.reviewRunId,
      trigger: run.trigger,
      requestedBy: 'queue-reconciler',
    });
    if (jobId === null) {
      logger.warn({ reviewRunId: run.reviewRunId }, 'queued review could not be re-dispatched');
      continue;
    }
    requeued += 1;
    logger.warn(
      { reviewRunId: run.reviewRunId, jobId },
      'queued review had no live job; re-dispatched',
    );
  }
  if (requeued > 0) {
    logger.warn(
      { requeued, scanned: stale.length },
      're-dispatched reviews that had lost their queue job',
    );
  }
  return { scanned: stale.length, requeued, alive };
}

/**
 * The use-case: lock the pull request, prepare a workspace, run the graph, and
 * record the result. Every step is idempotent enough to survive a retry.
 */
export interface ExecuteReviewOptions {
  /** False runs the AI review without ever reaching the sandbox. */
  readonly allowChecks?: boolean;
  /** False keeps the result local: nothing is written to GitHub. A CLI trial must not surprise the author. */
  readonly publish?: boolean;
}

export async function executeReview(
  container: ApplicationContainer,
  reviewRunId: string,
  options: ExecuteReviewOptions = {},
): Promise<ReviewExecutionResult> {
  const { persistence, logger } = container;
  const target = await persistence.getReviewTarget(reviewRunId);
  if (target === null) {
    throw new AppError(`review run ${reviewRunId} not found`, { code: 'not_found' });
  }

  const lockName = `review:${target.pullRequestId}`;
  const lockResult = await container.locks.withLock(lockName, container.config.queue.jobTimeoutMs, () =>
    runLockedReview(container, reviewRunId, target.settings, options),
  );

  if (!lockResult.acquired) {
    logger.warn({ reviewRunId }, 'another review for this pull request holds the lock');
    return {
      reviewRunId,
      status: 'skipped',
      verdict: null,
      outcome: null,
      published: { commentUrl: null, checkRunUrl: null, skippedReason: 'already_running' },
      reason: 'another review for this pull request is already running',
      durationMs: 0,
      findings: { total: 0, publishable: 0 },
    };
  }
  return lockResult.result as ReviewExecutionResult;
}

async function runLockedReview(
  container: ApplicationContainer,
  reviewRunId: string,
  settings: RepositorySettings,
  options: ExecuteReviewOptions,
): Promise<ReviewExecutionResult> {
  const { persistence, logger } = container;
  const target = await persistence.getReviewTarget(reviewRunId);
  if (target === null) {
    throw new AppError(`review run ${reviewRunId} disappeared`, { code: 'not_found' });
  }
  const repository = target.repository;
  const startedAt = Date.now();

  await persistence.markReviewRunRunning(reviewRunId, new Date(startedAt));
  await publishStatus(container, {
    reviewRunId,
    type: 'log',
    at: new Date(startedAt).toISOString(),
    message: `review started (${target.trigger}) for ${repository.fullName}#${target.pullRequest.number}`,
    data: { headSha: target.pullRequest.headSha },
  });

  const agentExecutionId = await persistence.startAgentExecution({
    reviewRunId,
    graphName: 'code-review',
    model: container.config.llm.model,
    startedAt: new Date(startedAt),
  });

  let workspace: RepoWorkspace | null = null;
  let outcome: ReviewOutcome | null = null;
  let failure: Error | null = null;
  let previousFindings: readonly PriorFindingReference[] = [];

  try {
    const token = await container.github.auth.resolveToken(repository.installationId);
    workspace = await container.workspaces.create({
      repository,
      token,
      runId: reviewRunId,
      pullRequestNumber: target.pullRequest.number,
      ref: target.pullRequest.headRef,
      expectedSha: target.pullRequest.headSha,
    });

    const catalog = await buildScriptCatalog(workspace);
    previousFindings = await persistence.loadPreviousFindings(
      target.pullRequestId,
      reviewRunId,
    );

    const ports = assembleReviewPorts({
      container,
      reviewRunId,
      agentExecutionId,
      repository,
      pullRequestNumber: target.pullRequest.number,
      settings,
      workspace,
      catalog,
      previousFindings,
      principalId: `review-run:${reviewRunId}`,
      ...(options.allowChecks === false ? { allowToolUse: false } : {}),
    });

    outcome = await runReviewGraph(ports, {
      reviewRunId,
      agentExecutionId,
      trigger: target.trigger,
      headSha: target.pullRequest.headSha,
      baseSha: target.pullRequest.baseSha,
    });
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    logger.error(
      { reviewRunId, error: failure.message, stack: failure.stack },
      'review pipeline failed before completing',
    );
  } finally {
    if (workspace !== null) {
      await workspace.cleanup().catch((error: unknown) => {
        logger.warn({ reviewRunId, error: describe(error) }, 'workspace cleanup failed');
      });
    }
  }

  const durationMs = Date.now() - startedAt;
  const published: PublishedRefs = { commentUrl: null, checkRunUrl: null, skippedReason: null };

  if (outcome !== null && failure === null) {
    const finished = await finishAndPublish(container, {
      target,
      outcome,
      settings,
      agentExecutionId,
      durationMs,
      startedAt,
      options,
      previousFindings,
    });
    Object.assign(published, finished);
    return toResult(reviewRunId, outcome, published, null, durationMs);
  }

  const message = failure?.message ?? outcome?.error ?? 'review failed without an error message';
  await persistence
    .completeReviewRun(reviewRunId, {
      status: 'failed',
      verdict: null,
      summary: truncateSummary(`Review failed: ${message}`),
      finishedAt: new Date(),
      durationMs,
      tokensIn: outcome?.usage.tokensIn ?? 0,
      tokensOut: outcome?.usage.tokensOut ?? 0,
      estimatedCostUsd: outcome?.usage.estimatedCostUsd ?? 0,
      error: message,
      budgetExceeded: null,
    })
    .catch((error: unknown) => logger.error({ error: describe(error) }, 'could not mark run failed'));

  await persistence
    .finishAgentExecution(agentExecutionId, {
      status: 'failed',
      finishedAt: new Date(),
      durationMs,
      tokensIn: outcome?.usage.tokensIn ?? 0,
      tokensOut: outcome?.usage.tokensOut ?? 0,
      estimatedCostUsd: outcome?.usage.estimatedCostUsd ?? 0,
      error: message,
      finalNode: outcome?.nodeTrace.at(-1)?.node ?? null,
      iterations: outcome?.iterations ?? 0,
      toolCalls: outcome?.toolCalls ?? 0,
    })
    .catch((error: unknown) => logger.error({ error: describe(error) }, 'could not close agent execution'));

  await publishStatus(container, {
    reviewRunId,
    type: 'run.failed',
    at: new Date().toISOString(),
    message,
    data: { durationMs },
  });

  return {
    reviewRunId,
    status: 'failed',
    verdict: null,
    outcome,
    published,
    reason: message,
    durationMs,
    findings: {
      total: outcome?.findings.length ?? 0,
      publishable: outcome?.publishableFindings.length ?? 0,
    },
  };
}

interface FinishInput {
  readonly target: ReviewRunTarget;
  readonly outcome: ReviewOutcome;
  readonly settings: RepositorySettings;
  readonly agentExecutionId: string;
  readonly durationMs: number;
  readonly startedAt: number;
  readonly options: ExecuteReviewOptions;
  /** Findings from earlier runs on this pull request, for the progress section. */
  readonly previousFindings: readonly PriorFindingReference[];
}

async function finishAndPublish(
  container: ApplicationContainer,
  input: FinishInput,
): Promise<PublishedRefs> {
  const { target, outcome, settings, agentExecutionId, durationMs } = input;
  const { persistence, logger } = container;
  const status: Extract<ReviewRunStatus, 'completed' | 'failed'> =
    outcome.status === 'failed' ? 'failed' : 'completed';
  const summary = summarizeForRun(outcome);

  await persistence.completeReviewRun(target.reviewRunId, {
    status,
    verdict: outcome.verdict,
    summary,
    finishedAt: new Date(),
    durationMs,
    tokensIn: outcome.usage.tokensIn,
    tokensOut: outcome.usage.tokensOut,
    estimatedCostUsd: outcome.usage.estimatedCostUsd,
    error: outcome.error,
    budgetExceeded: outcome.budgetExhausted
      ? { limit: outcome.stoppedReason ?? 'budget', details: { iterations: outcome.iterations } }
      : null,
  });

  await persistence.finishAgentExecution(agentExecutionId, {
    status: status === 'completed' ? 'succeeded' : 'failed',
    finishedAt: new Date(),
    durationMs,
    tokensIn: outcome.usage.tokensIn,
    tokensOut: outcome.usage.tokensOut,
    estimatedCostUsd: outcome.usage.estimatedCostUsd,
    error: outcome.error,
    finalNode: outcome.nodeTrace.at(-1)?.node ?? null,
    iterations: outcome.iterations,
    toolCalls: outcome.toolCalls,
  });

  await publishStatus(container, {
    reviewRunId: target.reviewRunId,
    type: status === 'completed' ? 'run.completed' : 'run.failed',
    at: new Date().toISOString(),
    message: `${status}: ${summary}`.slice(0, 500),
    data: { verdict: outcome.verdict, findings: outcome.publishableFindings.length, durationMs },
  });

  if (input.options.publish === false) {
    logger.info({ reviewRunId: target.reviewRunId }, 'publishing skipped by the caller');
    return {
      commentUrl: null,
      checkRunUrl: null,
      skippedReason: 'publish_skipped_by_caller',
    };
  }

  const approvalRequired = !deriveAgentPermissions(settings, container.config).has('review:publish');
  const headSha = outcome.headSha.length > 0 ? outcome.headSha : target.pullRequest.headSha;
  const artifacts = buildPublishArtifacts(container, {
    repository: target.repository,
    pullRequestNumber: target.pullRequest.number,
    headSha,
    settings,
    renderContext: {
      outcome,
      reviewRunId: target.reviewRunId,
      repositoryFullName: target.repository.fullName,
      pullRequestNumber: target.pullRequest.number,
      headSha,
      model: container.config.llm.model,
      durationMs,
      dashboardUrl: dashboardUrl(container, target.reviewRunId),
      previousFindings: input.previousFindings,
    },
  });

  if (approvalRequired) {
    const { approvalId } = await requestPublishGate(container, artifacts);
    logger.info({ reviewRunId: target.reviewRunId, approvalId }, 'review awaits human approval');
    return {
      commentUrl: null,
      checkRunUrl: null,
      skippedReason: `approval_required:${approvalId}`,
    };
  }

  return publishArtifacts(container, artifacts);
}

function decideFallbackVerdict(outcome: ReviewOutcome): ReviewVerdict {
  const kept = outcome.validated.filter((entry) => entry.decision === 'keep' && entry.publishable);
  return summarizeFindings(kept.map((entry) => entry.finding)).bySeverity.critical > 0 ? 'failed' : 'neutral';
}

function truncateSummary(value: string): string {
  return value.length > MAX_SUMMARY_CHARS
    ? `${value.slice(0, MAX_SUMMARY_CHARS - 3)}...`
    : value;
}

function summarizeForRun(outcome: ReviewOutcome): string {
  if (outcome.summary.trim().length > 0) {
    return truncateSummary(outcome.summary);
  }
  const kept = outcome.validated.filter((entry) => entry.decision === 'keep');
  const counted = summarizeFindings(kept.map((entry) => entry.finding));
  const verdict = outcome.verdict ?? decideFallbackVerdict(outcome);
  return truncateSummary(
    `${counted.publishable} actionable finding(s); verdict ${verdict}. ${outcome.narrative.split('\n')[0] ?? ''}`.trim(),
  );
}

export interface InlineFindingComment {
  readonly fingerprint: string;
  readonly path: string;
  readonly line: number;
  /** Set only for a multi-line finding, so GitHub anchors the whole range. */
  readonly startLine: number | null;
  readonly body: string;
}

/**
 * What a publish actually sends. Rendering happens once, at review time, so an
 * approval later publishes exactly what a human read — not a fresh render of
 * rows that may have changed in between.
 */
export interface PublishArtifacts {
  readonly reviewRunId: string;
  readonly repository: RepositoryRef;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly comment: string;
  readonly checkRun: CheckRunSummary;
  readonly createComment: boolean;
  readonly createCheckRun: boolean;
  readonly inline: readonly InlineFindingComment[];
  readonly createInlineComments: boolean;
}

export interface PublishReviewInput {
  readonly repository: RepositoryRef;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly settings: RepositorySettings;
  readonly renderContext: ReviewRenderContext;
}

export function buildPublishArtifacts(
  container: ApplicationContainer,
  input: PublishReviewInput,
): PublishArtifacts {
  const { settings, renderContext } = input;
  return {
    reviewRunId: renderContext.reviewRunId,
    repository: input.repository,
    pullRequestNumber: input.pullRequestNumber,
    headSha: input.headSha,
    comment: renderReviewComment(renderContext),
    checkRun: renderCheckRun(renderContext),
    createComment: settings.publishSummaryComment,
    createCheckRun: settings.createCheckRun && container.config.features.checkRunEnabled,
    inline: settings.publishFindingsAsComments ? renderInlineFindings(renderContext) : [],
    createInlineComments: settings.publishFindingsAsComments,
  };
}

/** GitHub rejects a line outside the diff, so a bounded number keeps the blast radius sane. */
const MAX_INLINE_FINDINGS = 25;
const MAX_INLINE_BODY_CHARS = 4_000;

/**
 * One inline comment per publishable finding that has a line. A finding without
 * a line cannot be anchored to the diff and stays in the summary comment only.
 */
export function renderInlineFindings(
  context: ReviewRenderContext,
): readonly InlineFindingComment[] {
  const comments: InlineFindingComment[] = [];
  for (const entry of context.outcome.validated) {
    if (!entry.publishable) {
      continue;
    }
    const { finding } = entry;
    if (finding.line === null) {
      continue;
    }
    const end = finding.endLine === null || finding.endLine <= finding.line
      ? finding.line
      : finding.endLine;
    comments.push({
      fingerprint: entry.fingerprint,
      path: finding.file,
      line: end,
      startLine: end === finding.line ? null : finding.line,
      body: renderInlineBody(entry.finding),
    });
    if (comments.length >= MAX_INLINE_FINDINGS) {
      break;
    }
  }
  return comments;
}

function renderInlineBody(finding: FindingDraft): string {
  const lines = [
    `${findingSeverityIcon(finding.severity)} **${sanitizeUntrustedMarkdown(finding.title, 200)}** · ${finding.category} · confidence ${(finding.confidence * 100).toFixed(0)}%`,
    '',
    sanitizeUntrustedMarkdown(finding.description),
  ];
  if (finding.suggestion !== null && finding.suggestion.trim().length > 0) {
    lines.push('', `**Suggestion:** ${sanitizeUntrustedMarkdown(finding.suggestion, 800)}`);
  }
  return lines.join('\n').slice(0, MAX_INLINE_BODY_CHARS);
}

const RepositoryRefSchema = z.object({
  owner: z.string().min(1),
  name: z.string().min(1),
  fullName: z.string().min(1),
  installationId: z.number().int().nullable(),
  defaultBranch: z.string().min(1),
  private: z.boolean(),
});

const ArtifactsPayloadSchema = z.object({
  reviewRunId: z.string().min(1),
  repository: RepositoryRefSchema,
  pullRequestNumber: z.number().int().positive(),
  headSha: z.string().min(4),
  comment: z.string().min(1),
  checkRun: z.object({
    conclusion: z.enum(['success', 'neutral', 'failure', 'cancelled', 'skipped']),
    title: z.string().min(1),
    summary: z.string(),
    text: z.string(),
  }),
  createComment: z.boolean(),
  createCheckRun: z.boolean(),
  // Defaults keep a snapshot written before inline publishing readable.
  inline: z
    .array(
      z.object({
        fingerprint: z.string().min(1),
        path: z.string().min(1),
        line: z.number().int().positive(),
        startLine: z.number().int().positive().nullable(),
        body: z.string().min(1),
      }),
    )
    .default([]),
  createInlineComments: z.boolean().default(false),
});

type ArtifactsParseResult =
  | { readonly ok: true; readonly artifacts: PublishArtifacts }
  | { readonly ok: false; readonly invalidPaths: readonly string[] };

/** A stored snapshot is data, not a trusted object: validate before publishing. */
function readArtifactsPayload(value: unknown): ArtifactsParseResult {
  const parsed = ArtifactsPayloadSchema.safeParse(value);
  if (parsed.success) {
    return { ok: true, artifacts: parsed.data as unknown as PublishArtifacts };
  }
  return {
    ok: false,
    invalidPaths: parsed.error.issues.map(
      (issue) => (issue.path.length > 0 ? issue.path.join('.') : '<root>'),
    ),
  };
}

/** A stored snapshot is data, not a trusted object: `null` means "unreadable". */
export function parsePublishArtifacts(value: unknown): PublishArtifacts | null {
  const result = readArtifactsPayload(value);
  return result.ok ? result.artifacts : null;
}

/**
 * Publishing is best-effort per artifact: a rejected comment must not hide a
 * check run that did land, and neither may fail an otherwise good review.
 */
export async function publishArtifacts(
  container: ApplicationContainer,
  artifacts: PublishArtifacts,
): Promise<PublishedRefs> {
  const { repository, reviewRunId } = artifacts;
  const logger = container.logger;
  const result: MutablePublishedRefs = { commentUrl: null, checkRunUrl: null, skippedReason: null };

  if (!container.config.features.publishEnabled) {
    return { ...result, skippedReason: 'publishing_disabled' };
  }

  // The ids, not only the urls: the run row is what the dashboard and any audit
  // read back to answer "which GitHub artefacts did this publish create".
  let commentId: number | null = null;
  let checkRunId: number | null = null;

  if (artifacts.createComment) {
    try {
      const existing = await container.github.publish.findSummaryComment({
        repository,
        pullRequestNumber: artifacts.pullRequestNumber,
      });
      const ref =
        existing === null
          ? await container.github.publish.createComment({
              repository,
              pullRequestNumber: artifacts.pullRequestNumber,
              body: artifacts.comment,
            })
          : await container.github.publish.updateComment({
              repository,
              commentId: existing.id,
              body: artifacts.comment,
            });
      result.commentUrl = ref.url;
      commentId = ref.id;
      logger.info({ reviewRunId, commentUrl: ref.url }, 'review comment published');
    } catch (error) {
      logger.error({ reviewRunId, error: describe(error) }, 'could not publish the summary comment');
      result.skippedReason = `comment_failed: ${describe(error)}`;
    }
  } else {
    result.skippedReason = 'comment_disabled_by_settings';
  }

  if (artifacts.createInlineComments && artifacts.inline.length > 0) {
    const published: { fingerprint: string; commentId: number | null }[] = [];
    let posted = 0;
    for (const entry of artifacts.inline) {
      try {
        const ref = await container.github.publish.createReviewComment({
          repository,
          pullRequestNumber: artifacts.pullRequestNumber,
          commitId: artifacts.headSha,
          path: entry.path,
          line: entry.line,
          startLine: entry.startLine,
          body: entry.body,
        });
        published.push({ fingerprint: entry.fingerprint, commentId: ref.id });
        posted += 1;
      } catch (error) {
        // A line outside the diff is a normal rejection, not a failed review.
        published.push({ fingerprint: entry.fingerprint, commentId: null });
        logger.warn(
          { reviewRunId, path: entry.path, line: entry.line, error: describe(error) },
          'inline finding could not be published',
        );
      }
    }
    await container.persistence
      .markFindingsPublished(reviewRunId, published)
      .catch((error: unknown) =>
        logger.warn(
          { reviewRunId, error: describe(error) },
          'could not record the inline comment ids',
        ),
      );
    logger.info(
      { reviewRunId, posted, attempted: artifacts.inline.length },
      'inline findings published',
    );
  }

  if (artifacts.createCheckRun) {
    try {
      const ref = await container.github.publish.createCheckRun({
        repository,
        headSha: artifacts.headSha,
        name: CHECK_RUN_NAME,
        conclusion: artifacts.checkRun.conclusion,
        title: artifacts.checkRun.title,
        summary: artifacts.checkRun.summary,
        text: artifacts.checkRun.text,
        detailsUrl: dashboardUrl(container, reviewRunId),
      });
      result.checkRunUrl = ref.url;
      checkRunId = ref.id;
    } catch (error) {
      logger.error({ reviewRunId, error: describe(error) }, 'could not publish the check run');
    }
  }

  await container.persistence
    .markReviewPublished(reviewRunId, { commentId, checkRunId })
    .catch((error: unknown) =>
      logger.warn({ reviewRunId, error: describe(error) }, 'could not record the published refs'),
    );

  return result;
}

export async function publishReview(
  container: ApplicationContainer,
  input: PublishReviewInput,
): Promise<PublishedRefs> {
  return publishArtifacts(container, buildPublishArtifacts(container, input));
}

/**
 * Park the rendered artifacts behind a human decision. The run moves to
 * `awaiting_approval` so it is visible in lists rather than silently missing.
 */
export async function requestPublishGate(
  container: ApplicationContainer,
  artifacts: PublishArtifacts,
): Promise<{ approvalId: string }> {
  const approval = await requestPublishApproval(container.prisma, artifacts.reviewRunId, {
    ...artifacts,
  });
  await setReviewRunStatus(container.prisma, artifacts.reviewRunId, 'awaiting_approval');
  return { approvalId: approval.id };
}

export interface ApprovalDecisionInput {
  readonly reviewRunId: string;
  readonly decidedById: string;
  readonly reason?: string;
}

/** Approved: publish the stored snapshot, then close the run. */
export async function approvePublish(
  container: ApplicationContainer,
  input: ApprovalDecisionInput,
): Promise<PublishedRefs> {
  const approval = await findPendingPublishApproval(container.prisma, input.reviewRunId);
  if (approval === null) {
    throw new AppError(`no pending publish approval for review ${input.reviewRunId}`, {
      code: 'not_found',
    });
  }
  const stored = readArtifactsPayload(approval.payload);
  if (!stored.ok) {
    // The approval decision was made on this payload: say exactly what is
    // unreadable, so an operator can tell a corrupted column from a stale schema.
    throw new AppError(
      `the stored review artifacts are no longer readable (invalid: ${stored.invalidPaths.join(', ')})`,
      { code: 'conflict', details: { reviewRunId: input.reviewRunId, invalidPaths: stored.invalidPaths } },
    );
  }

  const published = await publishArtifacts(container, stored.artifacts);
  await decideApproval(container.prisma, {
    approvalId: approval.id,
    decidedById: input.decidedById,
    status: 'approved',
    reason: input.reason,
  });
  await setReviewRunStatus(container.prisma, input.reviewRunId, 'completed');
  await publishStatus(container, {
    reviewRunId: input.reviewRunId,
    type: 'log',
    at: new Date().toISOString(),
    message: 'review approved and published',
    data: { ...published },
  });
  return published;
}

export async function rejectPublish(
  container: ApplicationContainer,
  input: ApprovalDecisionInput,
): Promise<void> {
  const approval = await findPendingPublishApproval(container.prisma, input.reviewRunId);
  if (approval === null) {
    throw new AppError(`no pending publish approval for review ${input.reviewRunId}`, {
      code: 'not_found',
    });
  }
  await decideApproval(container.prisma, {
    approvalId: approval.id,
    decidedById: input.decidedById,
    status: 'rejected',
    reason: input.reason,
  });
  await setReviewRunStatus(container.prisma, input.reviewRunId, 'cancelled');
  await publishStatus(container, {
    reviewRunId: input.reviewRunId,
    type: 'log',
    at: new Date().toISOString(),
    message: 'review publication rejected',
    data: { reason: input.reason ?? null },
  });
}

function dashboardUrl(container: ApplicationContainer, reviewRunId: string): string | null {
  if (!container.config.features.publishEnabled) {
    return null;
  }
  const base = container.config.api.publicUrl.replace(/\/+$/, '');
  return base.length === 0 ? null : `${base}/reviews/${reviewRunId}`;
}

async function publishStatus(container: ApplicationContainer, event: ReviewEvent): Promise<void> {
  try {
    await container.events.publish(event);
  } catch (error) {
    container.logger.warn({ error: describe(error) }, 'could not publish review status event');
  }
}

function toResult(
  reviewRunId: string,
  outcome: ReviewOutcome,
  published: PublishedRefs,
  reason: string | null,
  durationMs: number,
): ReviewExecutionResult {
  const kept = outcome.validated.filter((entry) => entry.decision === 'keep');
  return {
    reviewRunId,
    status: outcome.status === 'failed' ? 'failed' : 'completed',
    verdict: outcome.verdict,
    outcome,
    published,
    reason,
    durationMs,
    findings: {
      total: kept.length,
      publishable: outcome.publishableFindings.length,
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { ScriptCatalog };
