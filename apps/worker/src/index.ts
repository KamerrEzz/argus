import { createServer, type Server } from 'node:http';
import { hostname } from 'node:os';
import { createContainer, reconcileStaleReviews, type ApplicationContainer } from '@acr/pipeline';
import { WorkerPool } from '@acr/queue';
import { logReservedQueues, registerWorkers } from './handlers';

const WORKER_IDENTITY = `${process.pid}@${hostname()}`;

interface RunningWorker {
  readonly pool: WorkerPool;
  readonly container: ApplicationContainer;
  readonly health: Server | null;
}

/**
 * A worker has no other interface: if Redis is down there is nothing to wait
 * for, so this fails loudly instead of pretending to be idle.
 */
export async function startWorker(): Promise<RunningWorker> {
  const container = await createContainer({ requireRedis: true, loggerName: 'worker' });
  const connection = container.redis.connection;
  if (connection === null || container.queue === null) {
    await container.close();
    throw new Error('the worker requires Redis: set REDIS_URL and start the queue');
  }

  const pool = new WorkerPool({
    connection,
    prefix: container.config.redis.keyPrefix,
    logger: container.logger,
  });

  const count = registerWorkers(
    pool,
    container,
    { connection, prefix: container.config.redis.keyPrefix, logger: container.logger },
  );

  container.logger.info(
    {
      worker: WORKER_IDENTITY,
      workers: count,
      reviewConcurrency: container.config.queue.reviewConcurrency,
      commandConcurrency: container.config.queue.commandConcurrency,
      sandboxMode: container.config.sandbox.mode,
      checksQueued: container.checksQueued,
    },
    'worker started',
  );
  logReservedQueues(container.logger);

  // A run row can be left in QUEUED with no job behind it and nothing else would
  // ever pick it up. Reconcile once on start, and never block startup on it.
  void reconcileStaleReviews(container)
    .then((outcome) => {
      if (outcome.scanned > 0) {
        container.logger.info({ ...outcome }, 'review queue reconciliation finished');
      }
    })
    .catch((error: unknown) => {
      container.logger.warn({ error: String(error) }, 'review queue reconciliation failed');
    });

  const health = startHealthServer(container);
  return { pool, container, health };
}

/** Container probes need an answer that does not depend on a queue being busy. */
function startHealthServer(container: ApplicationContainer): Server | null {
  const port = container.config.worker.healthPort;
  if (port === 0) {
    return null;
  }

  const server = createServer((request, response) => {
    if (request.url !== '/health') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'not_found' }));
      return;
    }
    void container
      .healthProbe()
      .then((checks) => {
        const healthy = checks.database === 'ok' && checks.redis === 'ok';
        response.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: healthy ? 'ok' : 'degraded', checks }));
      })
      .catch((error: unknown) => {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'error', error: String(error) }));
      });
  });

  server.listen(port, container.config.api.host, () => {
    container.logger.info({ port }, 'worker health endpoint listening');
  });
  return server;
}

async function main(): Promise<void> {
  const { pool, container, health } = await startWorker();
  let closing = false;

  const shutdown = (signal: string): void => {
    if (closing) {
      return;
    }
    closing = true;
    container.logger.info({ signal }, 'worker stopping: draining running jobs');

    const forceExit = setTimeout(() => {
      container.logger.error({ drainTimeoutMs: 60_000 }, 'drain timed out; exiting');
      process.exit(1);
    }, 60_000);
    forceExit.unref();

    void pool
      .close(55_000)
      .catch((error: unknown) => {
        container.logger.error({ error: String(error) }, 'error while draining workers');
      })
      .then(() => {
        health?.close();
        return container.close();
      })
      .catch((error: unknown) => {
        container.logger.error({ error: String(error) }, 'error while closing the container');
      })
      .finally(() => {
        clearTimeout(forceExit);
        process.exit(0);
      });
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    container.logger.error({ reason: String(reason) }, 'unhandled promise rejection');
  });
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `worker failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
