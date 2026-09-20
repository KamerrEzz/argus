import { type ReviewEvent, type ReviewEventPort } from '@acr/shared';
import type { StoredEvent, SubscribeOptions } from '@acr/queue';

/**
 * Same surface as the Redis stream bus, for the CLI, tests and any single
 * process that has no reason to publish across a network boundary.
 */
export class InMemoryEventBus implements ReviewEventPort {
  private readonly streams = new Map<string, StoredEvent[]>();
  private readonly waiters = new Map<string, Set<(events: readonly StoredEvent[]) => void>>();
  private sequence = 0;

  constructor(private readonly maxPerRun = 2000) {}

  async publish(event: ReviewEvent): Promise<void> {
    const key = event.reviewRunId;
    const stored: StoredEvent = { id: `${Date.now()}-${(this.sequence += 1)}`, event };
    const list = this.streams.get(key) ?? [];
    list.push(stored);
    if (list.length > this.maxPerRun) {
      list.splice(0, list.length - this.maxPerRun);
    }
    this.streams.set(key, list);

    const waiting = this.waiters.get(key);
    if (waiting !== undefined) {
      for (const notify of waiting) {
        notify([stored]);
      }
    }
  }

  async history(reviewRunId: string, count = 500): Promise<readonly StoredEvent[]> {
    const list = this.streams.get(reviewRunId) ?? [];
    return list.slice(Math.max(0, list.length - count));
  }

  async subscribe(options: SubscribeOptions): Promise<void> {
    let cursor = options.fromId ?? '0';
    const replay = await this.history(options.reviewRunId, this.maxPerRun);
    for (const stored of replay) {
      if (cursor !== '0' && compareIds(stored.id, cursor) <= 0) {
        continue;
      }
      cursor = stored.id;
      await options.onEvent(stored.event, stored.id);
    }

    const queue: StoredEvent[] = [];
    let notify: (() => void) | null = null;

    const listener = (events: readonly StoredEvent[]): void => {
      queue.push(...events);
      if (notify !== null) {
        const wake = notify;
        notify = null;
        wake();
      }
    };

    const waiters = this.waiters.get(options.reviewRunId) ?? new Set();
    waiters.add(listener);
    this.waiters.set(options.reviewRunId, waiters);

    const aborted = (): boolean => options.signal?.aborted === true;

    try {
      for (;;) {
        if (aborted()) {
          return;
        }
        while (queue.length > 0) {
          const next = queue.shift();
          if (next === undefined) {
            break;
          }
          cursor = next.id;
          await options.onEvent(next.event, next.id);
        }
        if (aborted()) {
          return;
        }
        await new Promise<void>((resolve) => {
          notify = resolve;
          const timer = setTimeout(resolve, options.blockMs ?? 5_000);
          timer.unref?.();
          options.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      }
    } finally {
      waiters.delete(listener);
    }
  }

  clear(reviewRunId?: string): void {
    if (reviewRunId === undefined) {
      this.streams.clear();
      this.waiters.clear();
      return;
    }
    this.streams.delete(reviewRunId);
    this.waiters.delete(reviewRunId);
  }
}

/** Ids are monotonic per process; a numeric compare keeps replay exact. */
function compareIds(left: string, right: string): number {
  const [leftMs, leftSeq] = splitId(left);
  const [rightMs, rightSeq] = splitId(right);
  return leftMs === rightMs ? leftSeq - rightSeq : leftMs - rightMs;
}

function splitId(id: string): [number, number] {
  const index = id.indexOf('-');
  if (index < 0) {
    return [Number.parseInt(id, 10) || 0, 0];
  }
  return [
    Number.parseInt(id.slice(0, index), 10) || 0,
    Number.parseInt(id.slice(index + 1), 10) || 0,
  ];
}
