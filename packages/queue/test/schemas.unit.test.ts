import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { ZodType } from 'zod';
import {
  CloneRepositoryJobSchema,
  CloneRepositoryResultSchema,
  ProcessReviewJobSchema,
  PublishReviewJobSchema,
  QUEUES,
  QUEUE_NAMES,
  QueueClient,
  RunAgentJobSchema,
  RunCommandJobSchema,
  RunTestsJobSchema,
  type QueueName,
} from '@acr/queue';
import { queueNameForKind } from '@acr/pipeline';
import { createConfig, parseEnv } from '@acr/config';
import { COMMAND_KINDS, QueueError, ValidationError, noopLogger } from '@acr/shared';

const bullmqMocks = vi.hoisted(() => {
  const constructed: { name: string; options: Record<string, unknown> }[] = [];
  const added: { queueName: string; args: unknown[] }[] = [];
  class FakeQueue {
    readonly name: string;
    constructor(name: string, options: Record<string, unknown>) {
      this.name = name;
      constructed.push({ name, options });
    }
    async add(...args: unknown[]): Promise<null> {
      added.push({ queueName: this.name, args });
      // Returning null is bullmq's deduplicated signal.
      return null;
    }
    async close(): Promise<void> {
      // no-op
    }
  }
  class FakeWorker {}
  return { FakeQueue, FakeWorker, constructed, added };
});

vi.mock('bullmq', () => ({
  Queue: bullmqMocks.FakeQueue,
  Worker: bullmqMocks.FakeWorker,
}));

function expectAccepted(schema: ZodType, value: unknown): void {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`payload unexpectedly rejected: ${JSON.stringify(parsed.error.issues)}`);
  }
  expect(parsed.success).toBe(true);
}

function expectRejected(schema: ZodType, value: unknown): void {
  expect(schema.safeParse(value).success).toBe(false);
}

const JUNK: readonly unknown[] = [null, undefined, 'string', 42, true, [], ['reviewRunId']];

/** Every job-payload schema exported from packages/queue/src/queues.ts. */
const ALL_SCHEMAS: ReadonlyArray<readonly [string, ZodType]> = [
  [QUEUES.processReview, ProcessReviewJobSchema],
  [QUEUES.cloneRepository, CloneRepositoryJobSchema],
  [`${QUEUES.runTests} / ${QUEUES.runStaticAnalysis}`, RunCommandJobSchema],
  [QUEUES.runAgent, RunAgentJobSchema],
  [QUEUES.publishReview, PublishReviewJobSchema],
  ['clone-repository result', CloneRepositoryResultSchema],
];

// Literal shapes copied from the producer call sites:
// - packages/pipeline/src/review-service.ts  enqueueReview / enqueuePublish
// - packages/pipeline/src/checks.ts          createQueuedCheckLauncher
const processReviewProducerShape = {
  reviewRunId: 'run_01ABC',
  trigger: 'webhook',
  requestedBy: 'octocat',
};
const publishProducerShape = {
  reviewRunId: 'run_01ABC',
  requestedBy: 'admin@acme',
};
const runCommandProducerShape = {
  reviewRunId: 'run_01ABC',
  workspaceDir: '/work/run-run_01ABC-9f8e7d6c',
  kind: 'test',
  script: 'test',
  args: ['--runInBand'],
  timeoutMs: 120_000,
};

describe('QUEUES registry', () => {
  it('declares six unique kebab-case queue names', () => {
    expect(QUEUE_NAMES).toHaveLength(6);
    expect(new Set(QUEUE_NAMES).size).toBe(QUEUE_NAMES.length);
    for (const name of QUEUE_NAMES) {
      expect(name).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
    }
  });

  it('QUEUE_NAMES lists exactly the values of QUEUES with no gaps', () => {
    const fromRecord = Object.values(QUEUES).sort();
    expect([...QUEUE_NAMES].sort()).toEqual(fromRecord);
  });

  it('RunTestsJobSchema is the same schema object exported as RunCommandJobSchema', () => {
    expect(RunTestsJobSchema).toBe(RunCommandJobSchema);
  });
});

describe('schemas reject hostile non-objects', () => {
  for (const [label, schema] of ALL_SCHEMAS) {
    for (const junk of JUNK) {
      it(`${label} rejects ${JSON.stringify(junk) ?? String(junk)}`, () => {
        expectRejected(schema, junk);
      });
    }
  }
});

describe('ProcessReviewJobSchema', () => {
  it('accepts exactly what enqueueReview dispatches', () => {
    expectAccepted(ProcessReviewJobSchema, processReviewProducerShape);
  });

  it('requires reviewRunId with content', () => {
    expectRejected(ProcessReviewJobSchema, { trigger: 'webhook' });
    expectRejected(ProcessReviewJobSchema, { ...processReviewProducerShape, reviewRunId: '' });
    expectRejected(ProcessReviewJobSchema, { ...processReviewProducerShape, reviewRunId: 7 });
  });

  it('constrains trigger to the review trigger vocabulary', () => {
    for (const trigger of ['webhook', 'manual', 'retry']) {
      expectAccepted(ProcessReviewJobSchema, { ...processReviewProducerShape, trigger });
    }
    expectRejected(ProcessReviewJobSchema, { ...processReviewProducerShape, trigger: 'cron' });
    expectRejected(ProcessReviewJobSchema, { reviewRunId: 'r' });
  });

  it('accepts a missing requestedBy but rejects a wrong-typed one', () => {
    expectAccepted(ProcessReviewJobSchema, { reviewRunId: 'r', trigger: 'retry' });
    expectRejected(ProcessReviewJobSchema, { ...processReviewProducerShape, requestedBy: 5 });
  });
});

describe('CloneRepositoryJobSchema', () => {
  const base = {
    reviewRunId: 'run_01ABC',
    repositoryFullName: 'acme/demo',
  };

  it('accepts the full WorkspaceManager-style input', () => {
    expectAccepted(CloneRepositoryJobSchema, {
      ...base,
      installationId: 99,
      pullRequestNumber: 42,
      ref: 'refs/pull/42/head',
      expectedSha: 'abc123def456',
    });
  });

  it('accepts nullable optionals, rejects empty-string optionals', () => {
    expectAccepted(CloneRepositoryJobSchema, {
      ...base,
      installationId: null,
      pullRequestNumber: null,
      ref: null,
      expectedSha: null,
    });
    expectRejected(CloneRepositoryJobSchema, { ...base, expectedSha: '' });
    expectRejected(CloneRepositoryJobSchema, { ...base, ref: '' });
  });

  it('requires repositoryFullName and rejects non-positive ids', () => {
    expectRejected(CloneRepositoryJobSchema, { reviewRunId: 'r' });
    expectRejected(CloneRepositoryJobSchema, { ...base, repositoryFullName: '' });
    expectRejected(CloneRepositoryJobSchema, { ...base, pullRequestNumber: 0 });
    expectRejected(CloneRepositoryJobSchema, { ...base, installationId: -1 });
    expectRejected(CloneRepositoryJobSchema, { ...base, pullRequestNumber: 1.5 });
  });
});

describe('CloneRepositoryResultSchema', () => {
  it('accepts a completed clone result and rejects holes', () => {
    expectAccepted(CloneRepositoryResultSchema, {
      workspaceDir: '/work/run-1',
      headSha: 'abc123',
    });
    expectRejected(CloneRepositoryResultSchema, { workspaceDir: '/work/run-1' });
    expectRejected(CloneRepositoryResultSchema, { headSha: '' });
    expectRejected(CloneRepositoryResultSchema, { workspaceDir: 1, headSha: 'abc' });
  });
});

describe('RunAgentJobSchema', () => {
  it('accepts a bare reviewRunId and the enriched shape', () => {
    expectAccepted(RunAgentJobSchema, { reviewRunId: 'run_01ABC' });
    expectAccepted(RunAgentJobSchema, {
      reviewRunId: 'run_01ABC',
      workspaceDir: '/work/run-1',
      headSha: 'abc123',
    });
  });

  it('rejects missing or empty reviewRunId and empty enrichment strings', () => {
    expectRejected(RunAgentJobSchema, {});
    expectRejected(RunAgentJobSchema, { reviewRunId: '' });
    expectRejected(RunAgentJobSchema, { reviewRunId: 'r', headSha: '' });
    expectRejected(RunAgentJobSchema, { reviewRunId: 'r', workspaceDir: 4 });
  });
});

describe('RunCommandJobSchema', () => {
  it('accepts exactly what createQueuedCheckLauncher dispatches', () => {
    expectAccepted(RunCommandJobSchema, runCommandProducerShape);
    expectAccepted(RunTestsJobSchema, runCommandProducerShape);
  });

  it('rejects each missing required field', () => {
    // `args` is excluded on purpose: it carries a schema default of [], so
    // omitting it is valid and gets its own assertions below.
    for (const key of Object.keys(runCommandProducerShape).filter((name) => name !== 'args')) {
      const partial: Record<string, unknown> = { ...runCommandProducerShape };
      delete partial[key];
      expectRejected(RunCommandJobSchema, partial);
    }
  });

  it('covers every CommandKind from @acr/shared with no gaps', () => {
    expect(COMMAND_KINDS).toHaveLength(6);
    for (const kind of COMMAND_KINDS) {
      expectAccepted(RunCommandJobSchema, { ...runCommandProducerShape, kind });
    }
    expectRejected(RunCommandJobSchema, { ...runCommandProducerShape, kind: 'deploy' });
    expectRejected(RunCommandJobSchema, { ...runCommandProducerShape, kind: 3 });
  });

  it('bounds args to 20 string entries and defaults them to []', () => {
    const parsed = RunCommandJobSchema.safeParse({
      reviewRunId: 'r',
      workspaceDir: '/w',
      kind: 'lint',
      script: 'lint',
      timeoutMs: 1_000,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.args).toEqual([]);
    }
    expectAccepted(RunCommandJobSchema, {
      ...runCommandProducerShape,
      args: Array.from({ length: 20 }, (_unused, index) => `arg-${String(index)}`),
    });
    expectRejected(RunCommandJobSchema, {
      ...runCommandProducerShape,
      args: Array.from({ length: 21 }, (_unused, index) => `arg-${String(index)}`),
    });
    expectRejected(RunCommandJobSchema, { ...runCommandProducerShape, args: ['ok', 7] });
    expectRejected(RunCommandJobSchema, { ...runCommandProducerShape, args: 'not-an-array' });
  });

  it('bounds timeoutMs to the integer range [1000, 3600000]', () => {
    expectAccepted(RunCommandJobSchema, { ...runCommandProducerShape, timeoutMs: 1_000 });
    expectAccepted(RunCommandJobSchema, { ...runCommandProducerShape, timeoutMs: 3_600_000 });
    expectRejected(RunCommandJobSchema, { ...runCommandProducerShape, timeoutMs: 999 });
    expectRejected(RunCommandJobSchema, { ...runCommandProducerShape, timeoutMs: 3_600_001 });
    expectRejected(RunCommandJobSchema, { ...runCommandProducerShape, timeoutMs: 120_000.5 });
    expectRejected(RunCommandJobSchema, { ...runCommandProducerShape, timeoutMs: '120000' });
  });

  it('rejects empty script names', () => {
    expectRejected(RunCommandJobSchema, { ...runCommandProducerShape, script: '' });
  });
});

describe('PublishReviewJobSchema', () => {
  it('accepts exactly what enqueuePublish dispatches', () => {
    expectAccepted(PublishReviewJobSchema, publishProducerShape);
  });

  it('requires reviewRunId; requestedBy is optional but typed', () => {
    expectRejected(PublishReviewJobSchema, {});
    expectRejected(PublishReviewJobSchema, { reviewRunId: '' });
    expectRejected(PublishReviewJobSchema, { reviewRunId: 'r', requestedBy: 9 });
    expectAccepted(PublishReviewJobSchema, { reviewRunId: 'r' });
  });
});

describe('queueNameForKind maps every CommandKind onto a real queue', () => {
  it('covers COMMAND_KINDS with no unmapped kind and no phantom queue', () => {
    const targets = new Set<QueueName>();
    for (const kind of COMMAND_KINDS) {
      const name = queueNameForKind(kind);
      expect(QUEUE_NAMES).toContain(name);
      targets.add(name);
    }
    expect(targets.size).toBe(2);
  });

  it('sends only `test` to run-tests and everything else to run-static-analysis', () => {
    expect(queueNameForKind('test')).toBe(QUEUES.runTests);
    for (const kind of COMMAND_KINDS) {
      if (kind !== 'test') {
        expect(queueNameForKind(kind)).toBe(QUEUES.runStaticAnalysis);
      }
    }
  });
});

interface CapturedOptions {
  readonly prefix?: string;
  readonly defaultJobOptions?: {
    readonly attempts?: number;
    readonly backoff?: { readonly type?: string; readonly delay?: number };
    readonly removeOnComplete?: unknown;
    readonly removeOnFail?: unknown;
  };
}

describe('QueueClient wiring against @acr/config defaults', () => {
  const raw = parseEnv({});
  const config = createConfig(raw, { workspaceRoot: tmpdir() });

  function makeClient(): QueueClient {
    return new QueueClient({} as Redis, config.redis.keyPrefix, {
      attempts: config.queue.maxAttempts,
      backoffMs: config.queue.backoffMs,
      jobTimeoutMs: config.queue.jobTimeoutMs,
    }, noopLogger);
  }

  it('config exposes the documented queue defaults used by the wiring below', () => {
    // Sourced from @acr/config rather than invented here: maxAttempts,
    // backoffMs and jobTimeoutMs must be populated numbers.
    expect(Number.isInteger(config.queue.maxAttempts)).toBe(true);
    expect(config.queue.maxAttempts).toBeGreaterThanOrEqual(1);
    expect(config.queue.backoffMs).toBeGreaterThanOrEqual(100);
    expect(config.queue.jobTimeoutMs).toBeGreaterThanOrEqual(1_000);
  });

  it('constructs one bullmq Queue per declared name with config-driven retry options', () => {
    bullmqMocks.constructed.length = 0;
    makeClient();

    expect(bullmqMocks.constructed).toHaveLength(QUEUE_NAMES.length);
    expect(bullmqMocks.constructed.map((entry) => entry.name)).toEqual([...QUEUE_NAMES]);
    for (const entry of bullmqMocks.constructed) {
      const options = entry.options as CapturedOptions;
      expect(options.prefix).toBe(config.redis.keyPrefix);
      expect(options.defaultJobOptions?.attempts).toBe(config.queue.maxAttempts);
      expect(options.defaultJobOptions?.backoff).toEqual({
        type: 'exponential',
        delay: config.queue.backoffMs,
      });
      expect(options.defaultJobOptions?.removeOnComplete).toBeDefined();
      expect(options.defaultJobOptions?.removeOnFail).toBeDefined();
    }
  });

  it('validates payloads on dispatch before touching bullmq', async () => {
    bullmqMocks.added.length = 0;
    const client = makeClient();
    await expect(client.dispatch(QUEUES.processReview, { trigger: 'webhook' })).rejects.toThrow(
      ValidationError,
    );
    await expect(client.dispatch(QUEUES.runTests, { ...runCommandProducerShape, timeoutMs: 10 })).rejects.toThrow(
      ValidationError,
    );
    expect(bullmqMocks.added).toHaveLength(0);
    await client.close();
  });

  it('forwards the parsed payload and dispatch options into bullmq add()', async () => {
    bullmqMocks.added.length = 0;
    const client = makeClient();
    const result = await client.dispatch(QUEUES.processReview, {
      ...processReviewProducerShape,
      unexpectedField: 'must be stripped',
    }, { jobId: 'review-run_01ABC', deduplicationId: 'process-review:run_01ABC', delayMs: 500, attempts: 1 });

    expect(result).toEqual({ jobId: null, deduplicated: true });
    expect(bullmqMocks.added).toHaveLength(1);
    const call = bullmqMocks.added[0];
    expect(call?.queueName).toBe(QUEUES.processReview);
    const args = call?.args ?? [];
    expect(args[0]).toBe(QUEUES.processReview);
    expect(args[1]).toEqual(processReviewProducerShape);
    expect(args[2]).toEqual({
      jobId: 'review-run_01ABC',
      // BullMQ reads `deduplication.id`; `deduplicationId` was ignored entirely.
      deduplication: { id: 'process-review:run_01ABC' },
      delay: 500,
      attempts: 1,
    });
    await client.close();
  });

  it('applies schema defaults to the payload handed to bullmq', async () => {
    bullmqMocks.added.length = 0;
    const client = makeClient();
    await client.dispatch(QUEUES.runStaticAnalysis, {
      reviewRunId: 'r',
      workspaceDir: '/w',
      kind: 'lint',
      script: 'lint',
      timeoutMs: 1_000,
    });
    const call = bullmqMocks.added[0];
    const data = call?.args[1] as Record<string, unknown>;
    expect(data['args']).toEqual([]);
    await client.close();
  });

  it('rejects unknown queue names with QueueError', () => {
    const client = makeClient();
    expect(() => client.queue('does-not-exist' as unknown as QueueName)).toThrow(QueueError);
  });
});
