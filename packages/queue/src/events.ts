import type { Redis } from 'ioredis';
import {
  type LoggerPort,
  type ReviewEvent,
  type ReviewEventPort,
} from '@acr/shared';

export interface ReviewEventStreamOptions {
  /** Publishing connection. MUST be created without `keyPrefix`; keys are built here. */
  readonly redis: Redis;
  /** Dedicated blocking connection used by subscribers. */
  readonly blocking: Redis;
  readonly prefix: string;
  readonly maxLen: number;
  readonly ttlSeconds?: number;
  readonly logger: LoggerPort;
}

export interface StoredEvent {
  readonly id: string;
  readonly event: ReviewEvent;
}

export interface SubscribeOptions {
  readonly reviewRunId: string;
  /** Stream cursor to resume from. Use '0' to replay the retained history. */
  readonly fromId?: string;
  readonly onEvent: (event: ReviewEvent, id: string) => void | Promise<void>;
  readonly signal?: AbortSignal;
  readonly blockMs?: number;
}

type StreamEntry = [string, string[]];
type XreadReply = [string, StreamEntry[]][];

export class ReviewEventStreams implements ReviewEventPort {
  private readonly options: ReviewEventStreamOptions;
  private closed = false;

  constructor(options: ReviewEventStreamOptions) {
    this.options = options;
  }

  key(reviewRunId: string): string {
    return `${this.options.prefix}:review-events:${reviewRunId}`;
  }

  async publish(event: ReviewEvent): Promise<void> {
    if (this.closed) {
      return;
    }
    const key = this.key(event.reviewRunId);
    try {
      await this.options.redis.xadd(
        key,
        'MAXLEN',
        '~',
        String(this.options.maxLen),
        '*',
        'data',
        JSON.stringify(event),
      );
      await this.options.redis.expire(key, this.options.ttlSeconds ?? 3600);
    } catch (error) {
      // Event delivery is best-effort: a review must not fail because a stream write failed.
      this.options.logger.warn(
        {
          reviewRunId: event.reviewRunId,
          type: event.type,
          reason: error instanceof Error ? error.message : 'unknown',
        },
        'failed to publish review event',
      );
    }
  }

  async history(reviewRunId: string, count = 500): Promise<readonly StoredEvent[]> {
    const entries = await this.options.redis.xrange(this.key(reviewRunId), '-', '+', 'COUNT', count);
    return entriesToStored(entries, this.options.logger);
  }

  async tail(reviewRunId: string, fromId: string): Promise<readonly StoredEvent[]> {
    const entries = await this.options.redis.xrange(this.key(reviewRunId), `(${fromId}`, '+', 'COUNT', 500);
    return entriesToStored(entries, this.options.logger);
  }

  /**
   * Replay then follow one review's stream until the abort signal fires.
   *
   * Redis Streams use exclusive ranges with `(`, but `XREAD` expects a plain
   * exclusive marker which it applies itself, so the cursor is normalised here.
   */
  async subscribe(options: SubscribeOptions): Promise<void> {
    const key = this.key(options.reviewRunId);
    const blockMs = options.blockMs ?? 5_000;
    const isAborted = (): boolean => options.signal?.aborted === true;
    let cursor = (options.fromId ?? '0').replace(/^\(/, '');

    while (!this.closed && !isAborted()) {
      let entries: XreadReply | null;
      try {
        entries = (await this.options.blocking.xread(
          'COUNT',
          100,
          'BLOCK',
          blockMs,
          'STREAMS',
          key,
          cursor,
        )) as XreadReply | null;
      } catch (error) {
        if (isAborted()) {
          return;
        }
        this.options.logger.warn(
          { reviewRunId: options.reviewRunId, reason: error instanceof Error ? error.message : 'unknown' },
          'review event stream read failed; retrying',
        );
        await delay(Math.min(blockMs, 2_000));
        continue;
      }

      if (entries === null) {
        continue;
      }
      for (const [, streamEntries] of entries) {
        for (const stored of entriesToStored(streamEntries, this.options.logger)) {
          cursor = stored.id;
          await options.onEvent(stored.event, stored.id);
        }
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function entriesToStored(entries: [string, string[]][] | null, logger: LoggerPort): StoredEvent[] {
  const output: StoredEvent[] = [];
  if (entries === null) {
    return output;
  }
  for (const [id, fields] of entries) {
    const index = fields.indexOf('data');
    const raw = index >= 0 ? fields[index + 1] : undefined;
    if (typeof raw !== 'string') {
      continue;
    }
    try {
      output.push({ id, event: JSON.parse(raw) as ReviewEvent });
    } catch {
      logger.warn({ eventId: id }, 'dropping malformed review event from stream');
    }
  }
  return output;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
