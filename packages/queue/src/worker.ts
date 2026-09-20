import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { ZodType } from 'zod';
import { ValidationError, type LoggerPort } from '@acr/shared';
import type { QueueName } from './queues';

export interface WorkerSpec<TPayload, TResult> {
  readonly queue: QueueName;
  readonly schema: ZodType<TPayload>;
  readonly handler: (job: Job<TPayload, TResult, string>) => Promise<TResult>;
  readonly concurrency: number;
  readonly lockDurationMs?: number;
}

export interface CreateWorkerOptions {
  readonly connection: Redis;
  readonly prefix: string;
  readonly logger: LoggerPort;
}

export class WorkerPool {
  private readonly workers: Worker[] = [];
  private readonly logger: LoggerPort;

  constructor(options: CreateWorkerOptions) {
    this.logger = options.logger;
  }

  register<TPayload, TResult>(
    options: CreateWorkerOptions,
    spec: WorkerSpec<TPayload, TResult>,
  ): Worker<TPayload, TResult> {
    const worker = new Worker<TPayload, TResult>(
      spec.queue,
      async (job) => {
        const parsed = spec.schema.safeParse(job.data);
        if (!parsed.success) {
          throw new ValidationError(`Invalid ${spec.queue} job payload`, parsed.error.issues);
        }
        // Replace the unvalidated payload Redis handed us with the parsed one.
        (job as { data: TPayload }).data = parsed.data;
        return spec.handler(job);
      },
      {
        connection: options.connection,
        prefix: options.prefix,
        concurrency: spec.concurrency,
        lockDuration: spec.lockDurationMs ?? 60_000,
        maxStalledCount: 1,
      },
    );

    worker.on('failed', (job, error) => {
      this.logger.error(
        {
          queue: spec.queue,
          jobId: job?.id ?? null,
          attempt: job?.attemptsMade ?? null,
          reason: error.message,
        },
        'job failed',
      );
    });
    worker.on('error', (error) => {
      this.logger.error({ queue: spec.queue, reason: error.message }, 'worker error');
    });
    worker.on('stalled', (jobId) => {
      this.logger.warn({ queue: spec.queue, jobId }, 'job stalled');
    });

    this.workers.push(worker as unknown as Worker);
    return worker;
  }

  get size(): number {
    return this.workers.length;
  }

  /** Stop accepting new jobs and wait for running jobs to settle. */
  async close(timeoutMs = 30_000): Promise<void> {
    const closing = Promise.all(this.workers.map((worker) => worker.close()));
    await Promise.race([
      closing,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
    this.workers.length = 0;
  }
}
