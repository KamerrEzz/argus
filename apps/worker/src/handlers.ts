import { isAbsolute, resolve, sep } from 'node:path';
import {
  ProcessReviewJobSchema,
  PublishReviewJobSchema,
  QUEUES,
  RunCommandJobSchema,
  type ProcessReviewJob,
  type PublishReviewJob,
  type RunCommandJob,
} from '@acr/queue';
import {
  approvePublish,
  createInlineCheckLauncher,
  executeReview,
  type ApplicationContainer,
} from '@acr/pipeline';
import { AppError, type CommandOutcome, type LoggerPort } from '@acr/shared';
import type { WorkerPool, WorkerSpec, CreateWorkerOptions } from '@acr/queue';

/**
 * The workspace directory arrives through Redis. It is written by our own
 * pipeline, but a worker still refuses anything outside its configured root:
 * a poisoned queue must not turn into an arbitrary path read.
 */
export function assertWorkspaceAllowed(root: string, candidate: string): void {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(candidate);
  const within =
    absoluteCandidate === absoluteRoot ||
    absoluteCandidate.startsWith(absoluteRoot.endsWith(sep) ? absoluteRoot : `${absoluteRoot}${sep}`);
  if (!within || !isAbsolute(absoluteCandidate)) {
    throw new AppError('job references a workspace outside the configured root', {
      code: 'permission_denied',
    });
  }
}

export function commandSpecs(
  container: ApplicationContainer,
  concurrency: number,
  lockDurationMs: number,
): readonly WorkerSpec<RunCommandJob, CommandOutcome>[] {
  const runCommand = async (job: { data: RunCommandJob }): Promise<CommandOutcome> => {
    assertWorkspaceAllowed(container.workspaceRoot, job.data.workspaceDir);
    const launcher = createInlineCheckLauncher({
      runner: container.runner,
      workspaceDir: job.data.workspaceDir,
      policy: container.sandboxPolicy,
    });
    if (container.sandboxUnavailable !== null) {
      throw new AppError(container.sandboxUnavailable, { code: 'sandbox_error' });
    }
    return launcher({
      kind: job.data.kind,
      script: job.data.script,
      args: job.data.args,
      timeoutMs: job.data.timeoutMs,
    });
  };

  return [
    {
      queue: QUEUES.runTests,
      schema: RunCommandJobSchema,
      handler: runCommand,
      concurrency,
      lockDurationMs,
    },
    {
      queue: QUEUES.runStaticAnalysis,
      schema: RunCommandJobSchema,
      handler: runCommand,
      concurrency,
      lockDurationMs,
    },
  ];
}

export function reviewSpecs(
  container: ApplicationContainer,
  concurrency: number,
  lockDurationMs: number,
): readonly (WorkerSpec<ProcessReviewJob, unknown> | WorkerSpec<PublishReviewJob, unknown>)[] {
  const logger = container.logger;

  const processReview = async (job: { data: ProcessReviewJob }): Promise<unknown> => {
    const result = await executeReview(container, job.data.reviewRunId);
    logger.info(
      {
        reviewRunId: result.reviewRunId,
        status: result.status,
        verdict: result.verdict,
        findings: result.findings,
        published: result.published,
        durationMs: result.durationMs,
      },
      'review job finished',
    );
    return {
      status: result.status,
      verdict: result.verdict,
      reason: result.reason,
      published: result.published,
    };
  };

  const publishReview = async (job: { data: PublishReviewJob }): Promise<unknown> => {
    if (job.data.requestedBy === undefined) {
      // The approval row records who decided; a queue job without an actor is a bug.
      throw new AppError('publish-review job is missing requestedBy', { code: 'validation_error' });
    }
    const published = await approvePublish(container, {
      reviewRunId: job.data.reviewRunId,
      decidedById: job.data.requestedBy,
      reason: 'published by worker',
    });
    return published;
  };

  return [
    {
      queue: QUEUES.processReview,
      schema: ProcessReviewJobSchema,
      handler: processReview,
      concurrency,
      lockDurationMs,
    },
    {
      queue: QUEUES.publishReview,
      schema: PublishReviewJobSchema,
      handler: publishReview,
      concurrency: 2,
      lockDurationMs,
    },
  ];
}

export function registerWorkers(
  pool: WorkerPool,
  container: ApplicationContainer,
  connection: CreateWorkerOptions,
): number {
  const lockDurationMs = Math.min(container.config.queue.jobTimeoutMs, 5 * 60_000);
  const specs: readonly WorkerSpec<never, never>[] = [
    ...reviewSpecs(container, container.config.queue.reviewConcurrency, lockDurationMs),
    ...commandSpecs(container, container.config.queue.commandConcurrency, lockDurationMs),
  ].map((spec) => spec as unknown as WorkerSpec<never, never>);

  for (const spec of specs) {
    pool.register(connection, spec);
  }
  return specs.length;
}

export function logReservedQueues(logger: LoggerPort): void {
  logger.info(
    {
      queues: [QUEUES.cloneRepository, QUEUES.runAgent],
      reason:
        'cloning and agent execution happen inside one review job today; these queues stay open for a split-host deployment',
    },
    'reserved queues are not consumed by this worker',
  );
}
