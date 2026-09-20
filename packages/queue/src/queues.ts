import { Queue, type JobsOptions } from 'bullmq';
import { z, type ZodType } from 'zod';
import type { Redis } from 'ioredis';
import {
  QueueError,
  ValidationError,
  type LoggerPort,
} from '@acr/shared';

export const QUEUES = {
  processReview: 'process-review',
  cloneRepository: 'clone-repository',
  runTests: 'run-tests',
  runStaticAnalysis: 'run-static-analysis',
  runAgent: 'run-agent',
  publishReview: 'publish-review',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const QUEUE_NAMES: readonly QueueName[] = [
  QUEUES.processReview,
  QUEUES.cloneRepository,
  QUEUES.runTests,
  QUEUES.runStaticAnalysis,
  QUEUES.runAgent,
  QUEUES.publishReview,
];

export const ProcessReviewJobSchema = z.object({
  reviewRunId: z.string().min(1),
  trigger: z.enum(['webhook', 'manual', 'retry']),
  requestedBy: z.string().min(1).optional(),
});
export type ProcessReviewJob = z.infer<typeof ProcessReviewJobSchema>;

export const CloneRepositoryJobSchema = z.object({
  reviewRunId: z.string().min(1),
  repositoryFullName: z.string().min(1),
  installationId: z.number().int().positive().nullable().optional(),
  pullRequestNumber: z.number().int().positive().nullable().optional(),
  ref: z.string().min(1).nullable().optional(),
  expectedSha: z.string().min(1).nullable().optional(),
});
export type CloneRepositoryJob = z.infer<typeof CloneRepositoryJobSchema>;

export const CloneRepositoryResultSchema = z.object({
  workspaceDir: z.string().min(1),
  headSha: z.string().min(1),
});
export type CloneRepositoryResult = z.infer<typeof CloneRepositoryResultSchema>;

export const RunAgentJobSchema = z.object({
  reviewRunId: z.string().min(1),
  workspaceDir: z.string().min(1).optional(),
  headSha: z.string().min(1).optional(),
});
export type RunAgentJob = z.infer<typeof RunAgentJobSchema>;

export const RunCommandJobSchema = z.object({
  reviewRunId: z.string().min(1),
  workspaceDir: z.string().min(1),
  kind: z.enum(['test', 'lint', 'typecheck', 'build', 'static_analysis', 'security_scan']),
  script: z.string().min(1),
  args: z.array(z.string()).max(20).default([]),
  timeoutMs: z.number().int().min(1000).max(3_600_000),
});
export type RunCommandJob = z.infer<typeof RunCommandJobSchema>;

export const PublishReviewJobSchema = z.object({
  reviewRunId: z.string().min(1),
  requestedBy: z.string().min(1).optional(),
});
export type PublishReviewJob = z.infer<typeof PublishReviewJobSchema>;

const JOB_SCHEMAS: Record<QueueName, ZodType> = {
  [QUEUES.processReview]: ProcessReviewJobSchema,
  [QUEUES.cloneRepository]: CloneRepositoryJobSchema,
  [QUEUES.runTests]: RunCommandJobSchema,
  [QUEUES.runStaticAnalysis]: RunCommandJobSchema,
  [QUEUES.runAgent]: RunAgentJobSchema,
  [QUEUES.publishReview]: PublishReviewJobSchema,
};

export interface DispatchOptions {
  readonly deduplicationId?: string;
  readonly delayMs?: number;
  readonly attempts?: number;
}

export interface DispatchResult {
  readonly jobId: string | null;
  readonly deduplicated: boolean;
}

export type JobWaitOutcome<T> =
  | { readonly status: 'completed'; readonly result: T }
  | { readonly status: 'failed'; readonly reason: string }
  | { readonly status: 'timed_out' }
  | { readonly status: 'not_found' };

export interface QueueStatistics {
  readonly name: QueueName;
  readonly waiting: number;
  readonly active: number;
  readonly completed: number;
  readonly failed: number;
  readonly delayed: number;
}

export interface QueueClientOptions {
  readonly attempts: number;
  readonly backoffMs: number;
  readonly jobTimeoutMs: number;
}

export class QueueClient {
  private readonly queues = new Map<QueueName, Queue>();
  private readonly logger: LoggerPort;
  private readonly jobTimeoutMs: number;

  constructor(connection: Redis, prefix: string, options: QueueClientOptions, logger: LoggerPort) {
    this.logger = logger;
    this.jobTimeoutMs = options.jobTimeoutMs;
    for (const name of QUEUE_NAMES) {
      const queueOptions: Partial<JobsOptions> = {
        attempts: options.attempts,
        backoff: { type: 'exponential', delay: options.backoffMs },
        removeOnComplete: { age: 60 * 60 * 24, count: 500 },
        removeOnFail: { age: 60 * 60 * 24 * 7 },
      };
      this.queues.set(
        name,
        new Queue(name, {
          connection,
          prefix,
          defaultJobOptions: queueOptions,
        }),
      );
    }
  }

  queue(name: QueueName): Queue {
    const queue = this.queues.get(name);
    if (queue === undefined) {
      throw new QueueError(`Unknown queue ${name}`);
    }
    return queue;
  }

  async dispatch<T>(name: QueueName, payload: T, options: DispatchOptions = {}): Promise<DispatchResult> {
    const schema = JOB_SCHEMAS[name];
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new ValidationError(`Invalid ${name} job payload`, parsed.error.issues);
    }

    const job = await this.queue(name).add(name, parsed.data, {
      ...(options.deduplicationId === undefined ? {} : { deduplicationId: options.deduplicationId }),
      ...(options.delayMs === undefined ? {} : { delay: options.delayMs }),
      ...(options.attempts === undefined ? {} : { attempts: options.attempts }),
    });

    if (job === null || job.id === undefined) {
      this.logger.info({ queue: name }, 'job skipped by deduplication');
      return { jobId: null, deduplicated: true };
    }
    return { jobId: job.id, deduplicated: false };
  }

  async waitForJob<T>(
    name: QueueName,
    jobId: string,
    waitOptions: { readonly timeoutMs?: number; readonly pollMs?: number } = {},
  ): Promise<JobWaitOutcome<T>> {
    const queue = this.queue(name);
    const deadline = Date.now() + (waitOptions.timeoutMs ?? this.jobTimeoutMs);
    const pollMs = waitOptions.pollMs ?? 500;

    while (Date.now() < deadline) {
      const job = await queue.getJob(jobId);
      if (job === undefined) {
        return { status: 'not_found' };
      }
      const state = await job.getState();
      if (state === 'completed') {
        return { status: 'completed', result: (job.returnvalue ?? null) as T };
      }
      if (state === 'failed') {
        return { status: 'failed', reason: job.failedReason ?? 'job failed' };
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return { status: 'timed_out' };
  }

  async stats(): Promise<readonly QueueStatistics[]> {
    const output: QueueStatistics[] = [];
    for (const name of QUEUE_NAMES) {
      const counts = (await this.queue(name).getJobCounts(
        'waiting',
        'active',
        'completed',
        'failed',
        'delayed',
      )) as unknown as Record<string, number>;
      output.push({
        name,
        waiting: counts['waiting'] ?? 0,
        active: counts['active'] ?? 0,
        completed: counts['completed'] ?? 0,
        failed: counts['failed'] ?? 0,
        delayed: counts['delayed'] ?? 0,
      });
    }
    return output;
  }

  async close(): Promise<void> {
    for (const queue of this.queues.values()) {
      await queue.close();
    }
    this.queues.clear();
  }
}
