import type { ReviewEvent } from '@acr/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireSession } from '../auth/guard';
import { parseOrThrow } from '../errors';
import { loadRunFor } from '../http-helpers';

const IdParams = z.object({ id: z.string().min(1).max(64) });
const Query = z.object({ after: z.string().min(1).max(128).optional() });

const SSE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  // nginx buffers SSE by default; this header asks it not to.
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

const PING_INTERVAL_MS = 25_000;
const BLOCK_MS = 20_000;

/**
 * Replay-then-tail: the browser can reconnect with Last-Event-ID and lose
 * nothing, which is the only reason a live agent trace is trustworthy.
 */
export async function registerEventRoutes(app: FastifyInstance): Promise<void> {
  app.get('/reviews/:id/events', { preHandler: [requireSession] }, async (request, reply) => {
    const params = parseOrThrow(IdParams, request.params, 'params');
    const query = parseOrThrow(Query, request.query, 'query');

    // Authorise before hijacking: after hijack, fastify cannot answer with 404.
    await loadRunFor(request, params.id);
    const container = app.container;
    const headerLastEventId = request.headers['last-event-id'];
    const resumeFrom =
      query.after ?? (typeof headerLastEventId === 'string' ? headerLastEventId : undefined);

    reply.hijack();
    const stream = reply.raw;
    // A hijacked socket skips every onSend hook, including @fastify/cors — so
    // the browser's EventSource would see no Access-Control-Allow-Origin and
    // drop the stream. Mirror the plugin's reflect-if-allowed rule manually.
    const headers: Record<string, string> = { ...SSE_HEADERS };
    const origin = request.headers.origin;
    if (typeof origin === 'string' && container.config.api.corsOrigins.includes(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Access-Control-Allow-Credentials'] = 'true';
    }
    stream.writeHead(200, headers);
    stream.write('retry: 3000\n\n');

    const controller = new AbortController();
    const send = (event: ReviewEvent, id: string): void => {
      if (stream.destroyed) {
        return;
      }
      stream.write(`id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    const keepAlive = setInterval(() => {
      if (!stream.destroyed) {
        stream.write(': ping\n\n');
      }
    }, PING_INTERVAL_MS);
    keepAlive.unref?.();

    const close = (): void => {
      clearInterval(keepAlive);
      controller.abort();
      if (!stream.destroyed && !stream.writableEnded) {
        stream.end();
      }
    };
    request.raw.on('close', close);

    try {
      await container.events.subscribe({
        reviewRunId: params.id,
        ...(resumeFrom === undefined ? {} : { fromId: resumeFrom }),
        blockMs: BLOCK_MS,
        signal: controller.signal,
        onEvent: (event, id) => {
          send(event, id);
        },
      });
    } catch (error) {
      container.logger.warn(
        {
          reviewRunId: params.id,
          error: error instanceof Error ? error.message : String(error),
        },
        'review event stream ended early',
      );
    } finally {
      close();
    }
  });
}
