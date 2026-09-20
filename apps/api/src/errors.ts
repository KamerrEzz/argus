import { AppError, type LoggerPort } from '@acr/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

export interface ApiErrorBody {
  readonly code: string;
  readonly message: string;
  readonly details: unknown;
  readonly requestId: string | null;
}

/** Only the parts of a foreign error shape we can safely branch on. */
interface StructuredError {
  readonly code?: unknown;
  readonly statusCode?: unknown;
  readonly message?: unknown;
  readonly validation?: unknown;
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One shape for every failure, and never an internal message on a 500: a stack
 * trace or a driver error is a roadmap for an attacker.
 */
export function toApiError(error: unknown): { statusCode: number; body: ApiErrorBody } {
  if (error instanceof AppError) {
    return {
      statusCode: error.httpStatus,
      body: {
        code: error.code,
        message: error.expose ? error.message : 'Request could not be completed',
        details: error.expose ? (error.details ?? null) : null,
        requestId: null,
      },
    };
  }

  const structured = error as StructuredError;

  if (error instanceof ZodError) {
    return {
      statusCode: 422,
      body: {
        code: 'validation_error',
        message: 'Request validation failed',
        details: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
          code: issue.code,
        })),
        requestId: null,
      },
    };
  }

  if (Array.isArray(structured.validation) && structured.validation.length > 0) {
    return {
      statusCode: typeof structured.statusCode === 'number' ? structured.statusCode : 400,
      body: {
        code: 'validation_error',
        message: 'Request validation failed',
        details: structured.validation,
        requestId: null,
      },
    };
  }

  // Plugins such as @fastify/rate-limit reject with a plain Error carrying
  // only statusCode 429 (no FST_ERR code), so the rate-limit branch must come
  // first: otherwise a throttled client gets a 500 and we log a false alarm.
  if (structured.statusCode === 429) {
    return {
      statusCode: 429,
      body: {
        code: 'rate_limited',
        message: 'Too many requests',
        details: null,
        requestId: null,
      },
    };
  }

  if (typeof structured.code === 'string' && structured.code.startsWith('FST_ERR')) {
    const status = typeof structured.statusCode === 'number' ? structured.statusCode : 400;
    return {
      statusCode: status,
      body: {
        code: status === 404 ? 'not_found' : status === 429 ? 'rate_limited' : 'validation_error',
        message:
          status === 429
            ? 'Too many requests'
            : typeof structured.message === 'string'
              ? structured.message
              : 'Bad request',
        details: null,
        requestId: null,
      },
    };
  }

  return {
    statusCode: 500,
    body: {
      code: 'internal_error',
      message: 'Internal server error',
      details: null,
      requestId: null,
    },
  };
}

export function registerErrorHandler(app: FastifyInstance, logger: LoggerPort): void {
  app.setErrorHandler((error: Error, request: FastifyRequest, reply: FastifyReply) => {
    const { statusCode, body } = toApiError(error);
    const withId: ApiErrorBody = { ...body, requestId: request.id };

    if (statusCode >= 500) {
      logger.error(
        { requestId: request.id, method: request.method, url: request.url, error: describeError(error), stack: error.stack },
        'request failed',
      );
    } else {
      logger.debug(
        { requestId: request.id, method: request.method, url: request.url, code: withId.code },
        'request rejected',
      );
    }

    if (reply.sent) {
      return;
    }
    void reply.status(statusCode).send(withId);
  });

  app.setNotFoundHandler((request, reply) => {
    void reply
      .status(404)
      .send({ code: 'not_found', message: `No route for ${request.method} ${request.url}`, details: null, requestId: request.id } satisfies ApiErrorBody);
  });
}

/** Validate a payload with zod and turn failures into a clean 422. */
export function parseOrThrow<T>(schema: { parse: (value: unknown) => T }, value: unknown, context: string): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new AppError(`${context} failed validation`, {
        code: 'validation_error',
        details: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    throw error;
  }
}
