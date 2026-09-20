import {
  findRepositoryByFullName,
  getPullRequestById,
  listApprovalsForRun,
  listReviewFindings,
  listReviewRuns,
} from '@acr/database';
import { AppError, NotFoundError } from '@acr/shared';
import { approvePublish, enqueuePublish, rejectPublish, requestReview } from '@acr/pipeline';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { accessibleRepositoryIds, assertRepositoryAccess, claimsOf, requireSession } from '../auth/guard';
import { parseOrThrow } from '../errors';
import {
  loadRunFor,
  pullRequestNumberOfRun,
  repositoryIdOfRun,
  repositoryRefFor,
  runReviewDetached,
} from '../http-helpers';

const ListQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  repositoryId: z.string().min(1).max(64).optional(),
  pullRequestId: z.string().min(1).max(64).optional(),
  status: z
    .enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'awaiting_approval'])
    .optional(),
  verdict: z.enum(['passed', 'neutral', 'failed']).optional(),
});

const IdParams = z.object({ id: z.string().min(1).max(64) });

const CreateReviewSchema = z.object({
  repository: z.string().min(3).max(200),
  pullRequestNumber: z.coerce.number().int().positive().max(2_000_000),
  trigger: z.enum(['webhook', 'manual', 'retry']).default('manual'),
});

const FindingsQuery = z.object({
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
  category: z.string().max(40).optional(),
  status: z.enum(['validated', 'suppressed', 'pending', 'dismissed', 'resolved']).optional(),
  publishableOnly: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional(),
});

const DecisionSchema = z.object({ reason: z.string().max(2_000).optional() });

function isPublishableOnly(value: unknown): boolean {
  return value === true || value === 'true';
}

export async function registerReviewRoutes(app: FastifyInstance): Promise<void> {
  app.get('/reviews', { preHandler: [requireSession] }, async (request) => {
    const query = parseOrThrow(ListQuery, request.query, 'query');
    const container = app.container;
    const scope = await accessibleRepositoryIds(request);
    if (scope !== 'all' && scope.length === 0) {
      return { items: [], total: 0, take: query.pageSize, skip: (query.page - 1) * query.pageSize };
    }

    if (query.pullRequestId !== undefined) {
      const pullRequest = await getPullRequestById(container.prisma, query.pullRequestId);
      if (pullRequest === null) {
        throw new NotFoundError('pull request');
      }
      await assertRepositoryAccess(request, pullRequest.repositoryId, 'read');
    }
    if (query.repositoryId !== undefined) {
      await assertRepositoryAccess(request, query.repositoryId, 'read');
    }

    return listReviewRuns(container.prisma, {
      take: query.pageSize,
      skip: (query.page - 1) * query.pageSize,
      ...(query.repositoryId === undefined ? {} : { repositoryId: query.repositoryId }),
      ...(query.pullRequestId === undefined ? {} : { pullRequestId: query.pullRequestId }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.verdict === undefined ? {} : { verdict: query.verdict }),
      ...(scope === 'all' || query.repositoryId !== undefined ? {} : { repositoryIds: scope }),
    });
  });

  /** Queue a review by repository name, for callers that have neither internal id. */
  app.post('/reviews', { preHandler: [requireSession] }, async (request, reply) => {
    const body = parseOrThrow(CreateReviewSchema, request.body, 'review');
    const container = app.container;
    // Authorization happens before any GitHub read, review creation, or queue
    // dispatch: the same `triage` bar as POST /pull-requests/:id/review, which
    // also spends platform budget and writes to GitHub. Unknown names are 404
    // without touching GitHub, so a user without access can neither probe for
    // repositories nor bill the platform through this endpoint.
    const fullName = body.repository.trim().replace(/^\/+|\/+$/g, '');
    const record = await findRepositoryByFullName(container.prisma, fullName);
    if (record === null) {
      throw new NotFoundError(`repository ${body.repository}`);
    }
    await assertRepositoryAccess(request, record.id, 'triage');
    const result = await requestReview(container, {
      repository: body.repository,
      pullRequestNumber: body.pullRequestNumber,
      trigger: body.trigger,
      requestedBy: claimsOf(request).email,
    });
    if (!result.queued) {
      runReviewDetached(container, result.reviewRunId);
    }
    reply.status(result.created ? 202 : 200);
    return result;
  });

  app.get('/reviews/:id', { preHandler: [requireSession] }, async (request) => {
    const params = parseOrThrow(IdParams, request.params, 'params');
    return { review: await loadRunFor(request, params.id) };
  });

  app.get('/reviews/:id/findings', { preHandler: [requireSession] }, async (request) => {
    const params = parseOrThrow(IdParams, request.params, 'params');
    const query = parseOrThrow(FindingsQuery, request.query, 'query');
    await loadRunFor(request, params.id);
    const findings = await listReviewFindings(app.container.prisma, params.id, {
      ...(query.severity === undefined ? {} : { severity: query.severity }),
      ...(query.category === undefined ? {} : { category: query.category }),
      ...(query.status === undefined ? {} : { status: query.status }),
      publishableOnly:
        query.publishableOnly === undefined
          ? undefined
          : isPublishableOnly(query.publishableOnly),
    });
    return { findings };
  });

  app.get('/reviews/:id/approvals', { preHandler: [requireSession] }, async (request) => {
    const params = parseOrThrow(IdParams, request.params, 'params');
    await loadRunFor(request, params.id);
    return { approvals: await listApprovalsForRun(app.container.prisma, params.id) };
  });

  /**
   * A retry is a new run on the same head. The idempotency key must therefore
   * carry the attempt, or the previous run would be handed back.
   *
   * Like every other operation that starts work (POST /reviews and
   * POST /pull-requests/:id/review), it needs triage: a retry spends platform
   * budget and writes to GitHub, so read access alone must not reach it.
   */
  app.post('/reviews/:id/retry', { preHandler: [requireSession] }, async (request, reply) => {
    const params = parseOrThrow(IdParams, request.params, 'params');
    const container = app.container;
    const previous = await loadRunFor(request, params.id, 'triage');
    const repositoryId = repositoryIdOfRun(previous);
    const repository = await repositoryRefFor(container.prisma, repositoryId ?? '');
    if (repository === null) {
      throw new NotFoundError('repository');
    }
    const pullRequestNumber = pullRequestNumberOfRun(previous);
    if (pullRequestNumber === null) {
      throw new AppError('review run has no pull request number', { code: 'internal_error' });
    }

    const result = await requestReview(container, {
      repository: repository.fullName,
      pullRequestNumber,
      trigger: 'retry',
      requestedBy: claimsOf(request).email,
      idempotencyKey: `retry:${params.id}:${Date.now()}:${randomBytes(8).toString('hex')}`,
    });
    if (!result.queued) {
      runReviewDetached(container, result.reviewRunId);
    }
    reply.status(result.created ? 202 : 200);
    return result;
  });

  /**
   * Approving publishes the snapshot the reviewer read. That publish is queued
   * when a worker exists: GitHub calls are slow and retryable, and an HTTP
   * request should not wait on them.
   */
  app.post('/reviews/:id/publish', { preHandler: [requireSession] }, async (request, reply) => {
    const params = parseOrThrow(IdParams, request.params, 'params');
    const body = parseOrThrow(DecisionSchema, request.body ?? {}, 'decision');
    await loadRunFor(request, params.id, 'triage');
    const claims = claimsOf(request);

    const jobId = await enqueuePublish(app.container, {
      reviewRunId: params.id,
      requestedBy: claims.sub,
    });
    if (jobId !== null) {
      reply.status(202);
      return { status: 'publishing', reviewRunId: params.id, jobId };
    }

    const published = await approvePublish(app.container, {
      reviewRunId: params.id,
      decidedById: claims.sub,
      reason: body.reason,
    });
    return { status: 'published', published };
  });

  app.post('/reviews/:id/reject', { preHandler: [requireSession] }, async (request) => {
    const params = parseOrThrow(IdParams, request.params, 'params');
    const body = parseOrThrow(DecisionSchema, request.body ?? {}, 'decision');
    await loadRunFor(request, params.id, 'triage');
    await rejectPublish(app.container, {
      reviewRunId: params.id,
      decidedById: claimsOf(request).sub,
      reason: body.reason ?? 'rejected',
    });
    return { status: 'rejected' };
  });
}
