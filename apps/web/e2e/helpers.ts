import { expect, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  API_URL,
  DATABASE_URL,
  REDIS_PREFIX,
  REDIS_URL,
  SEED,
} from './env';

let prismaClient: PrismaClient | null = null;

/** Shared Prisma client for test setup (rows the UI cannot create without AI/GitHub). */
export function prisma(): PrismaClient {
  if (prismaClient === null) {
    prismaClient = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  }
  return prismaClient;
}

let redisClient: Redis | null = null;

/** Shared Redis client. No keyPrefix: stream owners build namespaced keys themselves. */
export function redis(): Redis {
  if (redisClient === null) {
    redisClient = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
  }
  return redisClient;
}

/** Sign in through the real login form and wait until we leave /login. */
export async function loginAs(
  page: Page,
  email: string = ADMIN_EMAIL,
  password: string = ADMIN_PASSWORD,
): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 });
}

/**
 * Browser-side fetch against the API with the session cookie. page.request
 * cannot be used: it targets the web origin, while the API is cross-origin.
 */
export async function apiFetch<T>(
  page: Page,
  path: string,
  init?: { readonly method?: string; readonly body?: unknown },
): Promise<{ readonly status: number; readonly json: T }> {
  return page.evaluate(
    async ({ base, path: requestPath, method, body }: { readonly base: string; readonly path: string; readonly method: string | undefined; readonly body: unknown }) => {
      const response = await fetch(`${base}${requestPath}`, {
        method: method ?? 'GET',
        credentials: 'include',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, json: (await response.json()) as T };
    },
    { base: API_URL, path, method: init?.method, body: init?.body },
  );
}

export interface AwaitingRun {
  readonly runId: string;
  readonly approvalId: string;
}

/**
 * Fabricate the one state the UI cannot reach without model keys: a run gated
 * on publish approval with a valid artifact snapshot. Mirrors
 * ArtifactsPayloadSchema in packages/pipeline/src/review-service.ts.
 */
export async function createAwaitingRun(tag: string): Promise<AwaitingRun> {
  const db = prisma();
  const runId = randomUUID();
  const headSha = `e2e${Date.now().toString(16)}`;
  await db.reviewRun.create({
    data: {
      id: runId,
      repositoryId: SEED.repositoryApiId,
      pullRequestId: SEED.pullRequestSqlId,
      status: 'AWAITING_APPROVAL',
      trigger: 'MANUAL',
      headSha,
      baseSha: 'base0000e2e',
      model: 'e2e-probe',
      idempotencyKey: `e2e:${tag}:${randomUUID()}`,
      summary: 'e2e awaiting run',
    },
  });
  const approval = await db.reviewApproval.create({
    data: {
      id: randomUUID(),
      reviewRunId: runId,
      action: 'publish_review',
      status: 'PENDING',
      payload: {
        reviewRunId: runId,
        repository: {
          owner: 'acme',
          name: 'api-gateway',
          fullName: 'acme/api-gateway',
          installationId: null,
          defaultBranch: 'main',
          private: true,
        },
        pullRequestNumber: 128,
        headSha,
        comment: 'e2e snapshot comment',
        checkRun: { conclusion: 'neutral', title: 'e2e', summary: 'e2e', text: 'e2e' },
        createComment: true,
        createCheckRun: false,
      },
    },
  });
  return { runId, approvalId: approval.id };
}

/** Append one probe event to a run's Redis stream (same key layout as ReviewEventStreams). */
export async function publishProbeEvent(runId: string, message: string): Promise<void> {
  const key = `${REDIS_PREFIX}:review-events:${runId}`;
  const entry = {
    reviewRunId: runId,
    type: 'node.started',
    at: new Date().toISOString(),
    message,
    node: 'e2e-probe',
  };
  await redis().xadd(key, '*', 'data', JSON.stringify(entry));
  await redis().expire(key, 600);
}

/** Poll an API predicate until it holds or the budget runs out. */
export async function pollApi(
  page: Page,
  path: string,
  predicate: (json: unknown) => boolean,
  timeoutMs: number,
): Promise<unknown> {
  const started = Date.now();
  let last: unknown = null;
  while (Date.now() - started < timeoutMs) {
    const response = await apiFetch<unknown>(page, path);
    last = response.json;
    if (response.status === 200 && predicate(response.json)) {
      return response.json;
    }
    await page.waitForTimeout(3000);
  }
  expect(last, `timed out waiting for ${path}`).toBe('expected-state');
  throw new Error('unreachable');
}
