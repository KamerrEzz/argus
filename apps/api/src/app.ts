import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { AppError } from '@acr/shared';
import fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { ApplicationContainer } from '@acr/pipeline';
import { registerErrorHandler } from './errors';
import { registerAuthRoutes } from './routes/auth';
import { registerEventRoutes } from './routes/events';
import { registerHealthRoutes } from './routes/health';
import { registerPullRequestRoutes } from './routes/pull-requests';
import { registerRepositoryRoutes } from './routes/repositories';
import { registerReviewRoutes } from './routes/reviews';
import { registerWebhookRoutes } from './routes/webhooks';

export interface BuildAppOptions {
  readonly container: ApplicationContainer;
  /** Tests get a rate-limiter-free app so repeated calls in one process stay fast. */
  readonly disableRateLimit?: boolean;
}

const JSON_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { container } = options;
  const { config, logger } = container;

  const app = fastify({
    logger: false,
    bodyLimit: JSON_BODY_LIMIT_BYTES,
    // The deployment sits behind nginx or a load balancer; without this, every
    // rate-limit bucket collapses onto the proxy's IP.
    trustProxy: true,
    // Fastify 5.12 warns that this is deprecated in favour of `logController`, but
    // its own types reject that key and the whole overload set collapses as a
    // result. Revisit when the server is bumped past the version that ships it.
    disableRequestLogging: true,
    requestIdLogLabel: undefined,
  });

  app.decorate('container', container);
  registerErrorHandler(app, logger);

  /**
   * GitHub signs the raw bytes it sent. Parsing to an object and re-serialising
   * would change them, so the buffer is kept alongside the parsed body.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request: FastifyRequest, payload: Buffer, done: (error: Error | null, body?: unknown) => void) => {
      request.rawBody = payload;
      if (payload.length === 0) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(payload.toString('utf8')));
      } catch {
        done(new AppError('request body is not valid JSON', { code: 'validation_error' }));
      }
    },
  );

  await app.register(cookie, { secret: config.auth.secret });

  const origins = config.api.corsOrigins;
  await app.register(cors, {
    origin: origins.length === 0 ? false : [...origins],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  if (options.disableRateLimit !== true) {
    await app.register(rateLimit, {
      global: true,
      max: config.api.rateLimit.max,
      timeWindow: config.api.rateLimit.windowMs,
    });
  }

  app.addHook('onResponse', async (request, reply) => {
    logger[reply.statusCode >= 500 ? 'error' : 'info'](
      {
        requestId: request.id,
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
        userId: request.user?.sub ?? null,
      },
      'request completed',
    );
  });

  // Health and webhooks are machine traffic; a limit there causes silent outages.
  app.get('/', async () => ({
    name: 'AI Code Review & QA Agent API',
    version: '0.1.0',
    health: '/health',
  }));

  await registerHealthRoutes(app);
  await registerAuthRoutes(app);
  await registerRepositoryRoutes(app);
  await registerPullRequestRoutes(app);
  await registerReviewRoutes(app);
  await registerEventRoutes(app);
  await registerWebhookRoutes(app);

  await app.ready();
  return app;
}
