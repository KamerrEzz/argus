import { Redis } from 'ioredis';
import type { LoggerPort } from '@acr/shared';

export interface RedisConnectionOptions {
  readonly url: string;
  readonly keyPrefix?: string;
  readonly logger: LoggerPort;
  readonly label: string;
  readonly maxRetriesPerRequest?: number | null;
}

export function createRedisClient(options: RedisConnectionOptions): Redis {
  const client = new Redis(options.url, {
    keyPrefix: options.keyPrefix,
    maxRetriesPerRequest:
      options.maxRetriesPerRequest === undefined ? 3 : options.maxRetriesPerRequest,
    enableReadyCheck: true,
    retryStrategy: (attempt: number) => Math.min(attempt * 200, 5000),
  });

  client.on('error', (error: Error) => {
    options.logger.error({ redis: options.label, reason: error.message }, 'redis connection error');
  });
  client.on('reconnecting', () => {
    options.logger.warn({ redis: options.label }, 'redis reconnecting');
  });

  return client;
}

/**
 * BullMQ requires an unbounded request retry policy because its workers use
 * blocking commands that must not fail over into a retried command.
 */
export function createQueueConnection(options: Omit<RedisConnectionOptions, 'maxRetriesPerRequest'>): Redis {
  return createRedisClient({ ...options, maxRetriesPerRequest: null });
}

export interface RedisProbe {
  readonly available: boolean;
  readonly latencyMs: number;
  readonly version: string | null;
  readonly error: string | null;
}

export async function probeRedis(client: Redis): Promise<RedisProbe> {
  const startedAt = Date.now();
  try {
    const info = await client.info('server');
    const match = /redis_version:([^\r\n]+)/.exec(info);
    return {
      available: true,
      latencyMs: Date.now() - startedAt,
      version: match?.[1] ?? null,
      error: null,
    };
  } catch (error) {
    return {
      available: false,
      latencyMs: Date.now() - startedAt,
      version: null,
      error: error instanceof Error ? error.message : 'unknown',
    };
  }
}
