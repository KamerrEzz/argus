import { collectReadinessIssues } from '@acr/config';
import type { FastifyInstance } from 'fastify';

const APP_VERSION = '0.1.0';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  /** Cheap, unauthenticated, and never fails: container state is a fact, not a gate. */
  app.get('/health', { config: { rateLimit: false } }, async () => {
    const container = app.container;
    const checks = await container.healthProbe();
    return {
      status: 'ok',
      version: APP_VERSION,
      environment: container.config.env,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      checks,
    };
  });

  /** Only a missing database blocks traffic; everything else degrades gracefully. */
  app.get('/ready', { config: { rateLimit: false } }, async (_request, reply) => {
    const container = app.container;
    const checks = await container.healthProbe();
    const issues = collectReadinessIssues(container.config).map((issue) => ({
      key: issue.key,
      message: issue.message,
    }));
    const ready = checks.database === 'ok';
    return reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not_ready',
      checks,
      issues,
    });
  });
}
