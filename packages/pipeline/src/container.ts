import type { PrismaClient } from '@prisma/client';
import { createLogger, getConfig, type AppConfig } from '@acr/config';
import { PrismaReviewStore, createPrismaClient } from '@acr/database';
import { createGithubIntegration, type GithubIntegration } from '@acr/github';
import {
  WorkspaceManager,
  createCommandRunner,
  probeDocker,
  probeGit,
  workspaceRootOf,
  type SandboxProbe,
} from '@acr/sandbox';
import {
  QueueClient,
  RedisLock,
  ReviewEventStreams,
  createQueueConnection,
  createRedisClient,
  probeRedis,
  type RedisProbe,
  type StoredEvent,
  type SubscribeOptions,
} from '@acr/queue';
import { createProvider, type AIProvider } from '@acr/ai';
import {
  AppError,
  type CommandRunnerPort,
  type LoggerPort,
  type ReviewEventPort,
} from '@acr/shared';
import type { Redis } from 'ioredis';
import { InMemoryEventBus } from './events-inmemory';
import type { SandboxPolicy } from './checks';

export type { StoredEvent, SubscribeOptions } from '@acr/queue';

/** Everything the API needs to serve a live review feed, in one shape. */
export interface ReviewEventSource extends ReviewEventPort {
  history(reviewRunId: string, count?: number): Promise<readonly StoredEvent[]>;
  subscribe(options: SubscribeOptions): Promise<void>;
}

export interface DistributedLock {
  withLock<T>(
    name: string,
    ttlMs: number,
    fn: () => Promise<T>,
  ): Promise<{ readonly acquired: boolean; readonly result?: T }>;
}

/** Lock for a single process: same contract, no cross-process guarantee. */
export class InProcessLock implements DistributedLock {
  private readonly held = new Map<string, string>();

  async acquire(name: string): Promise<{ readonly acquired: boolean; readonly token: string }> {
    if (this.held.has(name)) {
      return { acquired: false, token: '' };
    }
    const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    this.held.set(name, token);
    return { acquired: true, token };
  }

  async release(name: string, token: string): Promise<boolean> {
    if (this.held.get(name) !== token) {
      return false;
    }
    this.held.delete(name);
    return true;
  }

  async withLock<T>(
    name: string,
    _ttlMs: number,
    fn: () => Promise<T>,
  ): Promise<{ readonly acquired: boolean; readonly result?: T }> {
    const lock = await this.acquire(name);
    if (!lock.acquired) {
      return { acquired: false };
    }
    try {
      return { acquired: true, result: await fn() };
    } finally {
      await this.release(name, lock.token);
    }
  }
}

export interface ContainerOptions {
  readonly config?: AppConfig;
  readonly logger?: LoggerPort;
  /** Name for the logger this function builds; each process passes its own. */
  readonly loggerName?: string;
  /** Inject a provider (e.g. ScriptedProvider) instead of building from config. */
  readonly provider?: AIProvider;
  /**
   * When true (the API/worker default) a Redis outage fails startup. The CLI
   * sets it false and runs inline with in-process events and locks.
   */
  readonly requireRedis?: boolean;
  /** Skip the sandbox probes for tests and dry runs. */
  readonly probeSandbox?: boolean;
}

export interface ApplicationContainer {
  readonly config: AppConfig;
  readonly logger: LoggerPort;
  readonly prisma: PrismaClient;
  readonly persistence: PrismaReviewStore;
  readonly github: GithubIntegration;
  readonly workspaces: WorkspaceManager;
  readonly runner: CommandRunnerPort;
  readonly provider: AIProvider;
  readonly events: ReviewEventSource;
  readonly locks: DistributedLock;
  readonly queue: QueueClient | null;
  readonly redis: { readonly connection: Redis | null; readonly shared: Redis | null };
  readonly sandboxPolicy: SandboxPolicy;
  readonly sandboxUnavailable: string | null;
  readonly workspaceRoot: string;
  readonly checksQueued: boolean;
  healthProbe(): Promise<HealthSnapshot>;
  close(): Promise<void>;
}

export interface HealthSnapshot {
  readonly database: 'ok' | 'error';
  readonly redis: 'ok' | 'unavailable' | 'error';
  readonly docker: 'ok' | 'unavailable';
  readonly git: 'ok' | 'unavailable';
  readonly llm: 'configured' | 'missing_key';
  readonly checks: 'inline' | 'queued' | 'disabled';
}

export async function createContainer(options: ContainerOptions = {}): Promise<ApplicationContainer> {
  const config = options.config ?? getConfig();
  const logger =
    options.logger ??
    createLogger({
      name: options.loggerName ?? 'pipeline',
      level: config.log.level,
      pretty: config.log.pretty,
    });
  const requireRedis = options.requireRedis ?? true;
  const probeSandbox = options.probeSandbox ?? true;

  const prisma = createPrismaClient({
    url: config.database.url,
    poolSize: config.database.poolSize,
  });

  const github = createGithubIntegration({
    config,
    logger,
    maxFileBytes: config.budgets.maxFileBytes,
  });

  const dockerProbe = probeSandbox ? await probeDocker(config) : unavailableProbe(PROBES_SKIPPED);
  const gitProbe = probeSandbox ? await probeGit(config) : unavailableProbe(PROBES_SKIPPED);

  const sandboxUnavailable = resolveSandboxUnavailable(config, dockerProbe, gitProbe, logger);
  const effectiveConfig = applySandboxMode(config, dockerProbe, logger);

  const runner = createCommandRunner({ config: effectiveConfig, logger });

  const redis = await connectRedis(effectiveConfig, logger, requireRedis);
  const queue =
    redis.connection === null
      ? null
      : new QueueClient(
          redis.connection,
          effectiveConfig.redis.keyPrefix,
          {
            attempts: effectiveConfig.queue.maxAttempts,
            backoffMs: effectiveConfig.queue.backoffMs,
            jobTimeoutMs: effectiveConfig.queue.jobTimeoutMs,
          },
          logger,
        );

  const events: ReviewEventSource =
    redis.shared === null && redis.blocking === null
      ? new InMemoryEventBus()
      : new ReviewEventStreams({
          redis: redis.shared as Redis,
          blocking: redis.blocking as Redis,
          prefix: effectiveConfig.redis.keyPrefix,
          maxLen: effectiveConfig.queue.eventStreamMaxLen,
          logger,
        });

  const locks: DistributedLock =
    redis.shared === null
      ? new InProcessLock()
      : new RedisLock({ redis: redis.shared, prefix: effectiveConfig.redis.keyPrefix, logger });

  const provider = options.provider ?? createProvider(effectiveConfig, logger);
  const checksQueued = queue !== null && effectiveConfig.queue.commandExecution === 'queued';

  const container: ApplicationContainer = {
    config: effectiveConfig,
    logger,
    prisma,
    persistence: new PrismaReviewStore(prisma),
    github,
    workspaces: new WorkspaceManager({
      root: workspaceRootOf(effectiveConfig),
      gitBinary: effectiveConfig.sandbox.gitBinary,
      cloneDepth: effectiveConfig.sandbox.cloneDepth,
      maxFileBytes: effectiveConfig.budgets.maxFileBytes,
      logger,
    }),
    runner,
    provider,
    events,
    locks,
    queue,
    redis: { connection: redis.connection, shared: redis.shared },
    sandboxPolicy: {
      image: effectiveConfig.sandbox.image,
      network: effectiveConfig.sandbox.network,
      memoryLimit: effectiveConfig.sandbox.memoryLimit,
      cpuLimit: effectiveConfig.sandbox.cpuLimit,
      pidsLimit: effectiveConfig.sandbox.pidsLimit,
      timeoutMs: effectiveConfig.sandbox.timeoutMs,
    },
    sandboxUnavailable,
    workspaceRoot: workspaceRootOf(effectiveConfig),
    checksQueued,

    async healthProbe(): Promise<HealthSnapshot> {
      const database = await prisma.$queryRaw`SELECT 1`.then(
        () => 'ok' as const,
        () => 'error' as const,
      );
      const redisState = await (async () => {
        if (redis.shared === null) {
          return 'unavailable' as const;
        }
        const probe: RedisProbe = await probeRedis(redis.shared);
        return probe.available ? ('ok' as const) : ('unavailable' as const);
      })();
      return {
        database,
        redis: redisState,
        docker: dockerProbe.available ? 'ok' : 'unavailable',
        git: gitProbe.available ? 'ok' : 'unavailable',
        llm: effectiveConfig.llm.apiKey.trim().length > 0 ? 'configured' : 'missing_key',
        checks: sandboxUnavailable !== null ? 'disabled' : checksQueued ? 'queued' : 'inline',
      };
    },

    async close(): Promise<void> {
      const failures: unknown[] = [];
      const settle = async (label: string, action: () => Promise<unknown>): Promise<void> => {
        try {
          await action();
        } catch (error) {
          failures.push(new Error(`failed to close ${label}: ${describe(error)}`));
        }
      };
      await settle('queue', async () => queue?.close());
      await settle('redis', async () => redis.close());
      await settle('prisma', () => prisma.$disconnect());
      if (failures.length > 0) {
        logger.warn({ failures: failures.map(describe) }, 'container closed with errors');
      }
    },
  };

  return container;
}

interface RedisHandles {
  readonly connection: Redis | null;
  readonly shared: Redis | null;
  readonly blocking: Redis | null;
  close(): Promise<void>;
}

/**
 * No ioredis `keyPrefix` here: BullMQ, the lock and the event stream each build
 * their own namespaced keys, and a client-side prefix would double them.
 */
async function connectRedis(
  config: AppConfig,
  logger: LoggerPort,
  requireRedis: boolean,
): Promise<RedisHandles> {
  const base = { url: config.redis.url, logger };
  const connection = createQueueConnection({ ...base, label: 'queue' });
  const shared = createRedisClient({ ...base, label: 'app', maxRetriesPerRequest: 3 });
  const blocking = createRedisClient({ ...base, label: 'blocking', maxRetriesPerRequest: 3 });
  const clients = [connection, shared, blocking];

  const close = async (): Promise<void> => {
    await Promise.all(
      clients.map(async (client) => {
        client.disconnect();
      }),
    );
  };

  const probe = await withTimeout(probeRedis(shared), 4_000).catch(() => ({
    available: false,
    latencyMs: 0,
    version: null,
    error: 'probe timed out',
  }));

  if (!probe.available) {
    logger.error({ error: probe.error }, 'redis is unavailable');
    await close();
    if (requireRedis) {
      throw new AppError(
        'Redis is required but unreachable. Start Redis, or run the CLI for an in-process review.',
        { code: 'configuration_error', details: { url: redactUrl(config.redis.url), error: probe.error } },
      );
    }
    return { connection: null, shared: null, blocking: null, close: async () => undefined };
  }

  return { connection, shared, blocking, close };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function unavailableProbe(error: string): SandboxProbe {
  return { available: false, version: null, error };
}

/** Marker used when probes are skipped outright: "unavailable" would be a lie,
 * the binary was never even tried. */
const PROBES_SKIPPED = 'skipped';

export function resolveSandboxUnavailable(
  config: AppConfig,
  docker: SandboxProbe,
  git: SandboxProbe,
  logger: LoggerPort,
): string | null {
  if (!git.available) {
    if (git.error === PROBES_SKIPPED) {
      logger.warn({ probeSandbox: false }, 'sandbox probes skipped: code checks and cloning are disabled');
      return 'sandbox probes skipped (probeSandbox:false): code checks and cloning are disabled';
    }
    logger.warn({ error: git.error }, 'git binary is unavailable');
    return `git is unavailable (${git.error ?? 'not found'}): code checks and cloning are disabled`;
  }
  if (config.sandbox.mode === 'off') {
    logger.warn({ mode: config.sandbox.mode }, 'sandbox is disabled (SANDBOX_MODE=off): reviews are code-reading only');
    return 'sandbox is disabled (SANDBOX_MODE=off): code checks are disabled';
  }
  if (config.sandbox.mode !== 'docker') {
    return null;
  }
  if (!docker.available && !config.sandbox.allowProcessSandbox) {
    if (docker.error === PROBES_SKIPPED) {
      logger.warn(
        { probeSandbox: false },
        'sandbox probes skipped with no process fallback: code checks are disabled',
      );
      return 'sandbox probes skipped (probeSandbox:false) with no process fallback: code checks are disabled';
    }
    logger.warn({ error: docker.error }, 'docker is unavailable and process sandbox is not allowed');
    return 'docker is unavailable and ALLOW_PROCESS_SANDBOX is false: code checks are disabled';
  }
  return null;
}

/** Docker missing but the process sandbox is allowed: keep reviewing, degrade isolation. */
function applySandboxMode(config: AppConfig, docker: SandboxProbe, logger: LoggerPort): AppConfig {
  if (config.sandbox.mode !== 'docker' || docker.available || !config.sandbox.allowProcessSandbox) {
    return config;
  }
  logger.warn(
    { error: docker.error },
    'docker unavailable, falling back to the process sandbox for code checks',
  );
  return { ...config, sandbox: { ...config.sandbox, mode: 'process' } } as AppConfig;
}

function redactUrl(value: string): string {
  return value.replace(/\/\/([^@/]+)@/, '//***@');
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
