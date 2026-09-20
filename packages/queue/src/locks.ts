import type { Redis } from 'ioredis';
import type { LoggerPort } from '@acr/shared';

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

const EXTEND_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end`;

export interface RedisLockOptions {
  readonly redis: Redis;
  readonly prefix: string;
  readonly logger: LoggerPort;
}

export type LockAcquireResult =
  | { readonly acquired: true; readonly token: string }
  | { readonly acquired: false };

/**
 * Single-owner lock built on `SET key token NX PX ttl` with compare-and-delete
 * release, so a worker can never delete a lock it no longer owns.
 *
 * The supplied connection MUST be created without `keyPrefix`; this class owns
 * the full key so that Lua scripts address the same key the client wrote.
 */
export class RedisLock {
  private readonly redis: Redis;
  private readonly prefix: string;
  private readonly logger: LoggerPort;

  constructor(options: RedisLockOptions) {
    this.redis = options.redis;
    this.prefix = options.prefix;
    this.logger = options.logger;
  }

  key(name: string): string {
    return `${this.prefix}:lock:${name}`;
  }

  async acquire(name: string, ttlMs: number): Promise<LockAcquireResult> {
    const token = `${process.pid}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
    const result = await this.redis.set(this.key(name), token, 'PX', ttlMs, 'NX');
    if (result === 'OK') {
      return { acquired: true, token };
    }
    return { acquired: false };
  }

  async release(name: string, token: string): Promise<boolean> {
    const deleted = (await this.redis.eval(
      RELEASE_SCRIPT,
      1,
      this.key(name),
      token,
    )) as number;
    return deleted === 1;
  }

  async extend(name: string, token: string, ttlMs: number): Promise<boolean> {
    const extended = (await this.redis.eval(
      EXTEND_SCRIPT,
      1,
      this.key(name),
      token,
      String(ttlMs),
    )) as number;
    return extended === 1;
  }

  /**
   * Run `fn` while holding `name`. When the lock is busy the callback never
   * runs and `acquired` is false — callers decide whether that is a no-op or a
   * conflict.
   */
  async withLock<T>(
    name: string,
    ttlMs: number,
    fn: () => Promise<T>,
  ): Promise<{ readonly acquired: boolean; readonly result?: T }> {
    const lock = await this.acquire(name, ttlMs);
    if (!lock.acquired) {
      this.logger.debug({ lock: name }, 'lock busy; skipping critical section');
      return { acquired: false };
    }
    const timer = this.startRenewal(name, lock.token, ttlMs);
    try {
      return { acquired: true, result: await fn() };
    } finally {
      timer.stop();
      await this.release(name, lock.token).catch(() => false);
    }
  }

  private startRenewal(
    name: string,
    token: string,
    ttlMs: number,
  ): { readonly stop: () => void } {
    const intervalMs = Math.max(1_000, Math.floor(ttlMs / 3));
    const handle = setInterval(() => {
      void this.extend(name, token, ttlMs).then((extended) => {
        if (!extended) {
          this.logger.warn({ lock: name }, 'lock renewal failed; ownership lost');
          clearInterval(handle);
        }
      });
    }, intervalMs);
    handle.unref?.();
    return { stop: () => clearInterval(handle) };
  }
}
