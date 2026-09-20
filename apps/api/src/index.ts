import { countUsers, ensureBootstrapAdmin } from '@acr/database';
import { createContainer, type ApplicationContainer } from '@acr/pipeline';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app';

/**
 * A fresh install has nobody who can log in. The bootstrap account exists only
 * while the user table is empty, so it cannot become a permanent back door.
 */
async function bootstrapAdmin(container: ApplicationContainer): Promise<void> {
  const { email, password, name } = container.config.auth.bootstrapAdmin;
  if (email.trim().length === 0 || password.trim().length === 0) {
    return;
  }
  if ((await countUsers(container.prisma)) > 0) {
    return;
  }
  const user = await ensureBootstrapAdmin(container.prisma, {
    email: email.trim().toLowerCase(),
    password,
    name: name.trim().length > 0 ? name : 'Administrator',
  });
  container.logger.warn(
    { userId: user.id, email: user.email },
    'created the bootstrap administrator from environment settings',
  );
}

export async function startServer(): Promise<{ app: FastifyInstance; container: ApplicationContainer }> {
  const container = await createContainer({ requireRedis: true, loggerName: 'api' });
  await bootstrapAdmin(container);
  const app = await buildApp({ container });
  await app.listen({ port: container.config.api.port, host: container.config.api.host });
  return { app, container };
}

async function main(): Promise<void> {
  const { app, container } = await startServer();
  let closing = false;

  const shutdown = (signal: string): void => {
    if (closing) {
      return;
    }
    closing = true;
    container.logger.info({ signal }, 'shutting down');

    const forceExit = setTimeout(() => {
      container.logger.error({ timeoutMs: 15_000 }, 'graceful shutdown timed out; exiting');
      process.exit(1);
    }, 15_000);
    forceExit.unref();

    void app
      .close()
      .catch((error: unknown) => {
        container.logger.error({ error: String(error) }, 'error while closing the HTTP server');
      })
      .then(() => container.close())
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
    process.stderr.write(`api failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
