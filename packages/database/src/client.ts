import { PrismaClient, type Prisma } from '@prisma/client';
import { getConfig, getLogger, serializeError } from '@acr/config';

export interface PrismaClientOptions {
  readonly url?: string;
  readonly poolSize?: number;
  readonly logQueries?: boolean;
}

export function buildDatabaseUrl(baseUrl: string, poolSize: number): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return baseUrl;
  }
  if (!url.searchParams.has('connection_limit')) {
    url.searchParams.set('connection_limit', String(poolSize));
  }
  if (!url.searchParams.has('pool_timeout')) {
    url.searchParams.set('pool_timeout', '20');
  }
  return url.toString();
}

export function createPrismaClient(options: PrismaClientOptions = {}): PrismaClient {
  const config = getConfig();
  const url = buildDatabaseUrl(options.url ?? config.database.url, options.poolSize ?? config.database.poolSize);
  const logger = getLogger();
  const log: Prisma.LogDefinition[] = [
    { emit: 'event', level: 'warn' },
    { emit: 'event', level: 'error' },
  ];
  if (options.logQueries === true) {
    log.push({ emit: 'event', level: 'query' });
  }

  const client = new PrismaClient({
    datasources: { db: { url } },
    log,
  });

  client.$on('warn', (event) => {
    logger.warn({ prisma: true, target: event.target }, event.message);
  });
  client.$on('error', (event) => {
    logger.error({ prisma: true, target: event.target }, event.message);
  });
  if (options.logQueries === true) {
    client.$on('query', (event) => {
      logger.debug({ prisma: true, durationMs: event.duration }, event.query);
    });
  }

  return client;
}

let singleton: PrismaClient | null = null;

export function getPrismaClient(): PrismaClient {
  if (singleton === null) {
    singleton = createPrismaClient();
  }
  return singleton;
}

export async function disconnectPrismaClient(): Promise<void> {
  if (singleton !== null) {
    await singleton.$disconnect();
    singleton = null;
  }
}

export interface DatabaseHealth {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly error?: string;
}

export async function checkDatabaseHealth(client: PrismaClient): Promise<DatabaseHealth> {
  const startedAt = Date.now();
  try {
    await client.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: serializeError(error).message as string,
    };
  }
}
