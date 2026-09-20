import {
  findRepositoryByFullName,
  getPullRequestById,
  getPullRequestDetail,
  listPullRequests,
  upsertPullRequest,
} from '@acr/database';
import { NotFoundError } from '@acr/shared';
import { requestReview } from '@acr/pipeline';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { accessibleRepositoryIds, assertRepositoryAccess, claimsOf, requireSession } from '../auth/guard';
import { parseOrThrow } from '../errors';
import { repositoryRefFor, runReviewDetached } from '../http-helpers';

const ListQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  repositoryId: z.string().min(1).max(64).optional(),
  /** `owner/name`, for callers that know the repository but not its internal id. */
  repository: z.string().min(3).max(200).optional(),
  state: z.enum(['open', 'closed', 'merged']).optional(),
  search: z.string().max(200).optional(),
});

const IdParams = z.object({ id: z.string().min(1).max(64) });

export async function registerPullRequestRoutes(app: FastifyInstance): Promise<void> {
  app.get('/pull-requests', { preHandler: [requireSession] }, async (request) => {
    const query = parseOrThrow(ListQuery, request.query, 'query');
    const container = app.container;
    const scope = await accessibleRepositoryIds(request);
    if (scope !== 'all' && scope.length === 0) {
      return { items: [], total: 0, take: query.pageSize, skip: (query.page - 1) * query.pageSize };
    }

    let repositoryId = query.repositoryId;
    if (repositoryId === undefined && query.repository !== undefined) {
      const record = await findRepositoryByFullName(container.prisma, query.repository);
      if (record === null) {
        throw new NotFoundError(`repository ${query.repository}`);
      }
      repositoryId = record.id;
    }
    if (repositoryId !== undefined) {
      await assertRepositoryAccess(request, repositoryId, 'read');
    }

    return listPullRequests(container.prisma, {
      take: query.pageSize,
      skip: (query.page - 1) * query.pageSize,
      ...(repositoryId === undefined ? {} : { repositoryId }),
      ...(query.state === undefined ? {} : { state: query.state }),
      ...(query.search === undefined ? {} : { search: query.search }),
      ...(scope === 'all' || repositoryId !== undefined ? {} : { repositoryIds: scope }),
    });
  });

  app.get('/pull-requests/:id', { preHandler: [requireSession] }, async (request) => {
    const params = parseOrThrow(IdParams, request.params, 'params');
    const container = app.container;
    const local = await getPullRequestById(container.prisma, params.id);
    if (local === null) {
      throw new NotFoundError('pull request');
    }
    await assertRepositoryAccess(request, local.repositoryId, 'read');
    const detail = await getPullRequestDetail(container.prisma, params.id);
    if (detail === null) {
      throw new NotFoundError('pull request');
    }
    return { pullRequest: detail };
  });

  /** Pulls the current title, head and counts straight from GitHub. */
  app.post('/pull-requests/:id/sync', { preHandler: [requireSession] }, async (request) => {
    const params = parseOrThrow(IdParams, request.params, 'params');
    const container = app.container;
    const local = await getPullRequestById(container.prisma, params.id);
    if (local === null) {
      throw new NotFoundError('pull request');
    }
    await assertRepositoryAccess(request, local.repositoryId, 'read');
    const repository = await repositoryRefFor(container.prisma, local.repositoryId);
    if (repository === null) {
      throw new NotFoundError('repository');
    }

    const info = await container.github.read.getPullRequest({
      repository,
      number: local.number,
    });
    const updated = await upsertPullRequest(container.prisma, local.repositoryId, info);
    return { pullRequest: updated };
  });

  /** Triggering a review needs triage: it spends platform budget and writes to GitHub. */
  app.post('/pull-requests/:id/review', { preHandler: [requireSession] }, async (request, reply) => {
    const params = parseOrThrow(IdParams, request.params, 'params');
    const container = app.container;
    const local = await getPullRequestById(container.prisma, params.id);
    if (local === null) {
      throw new NotFoundError('pull request');
    }
    await assertRepositoryAccess(request, local.repositoryId, 'triage');
    const repository = await repositoryRefFor(container.prisma, local.repositoryId);
    if (repository === null) {
      throw new NotFoundError('repository');
    }

    const result = await requestReview(container, {
      repository: repository.fullName,
      pullRequestNumber: local.number,
      trigger: 'manual',
      requestedBy: claimsOf(request).email,
    });

    if (!result.queued) {
      runReviewDetached(container, result.reviewRunId);
    }

    reply.status(result.created ? 202 : 200);
    return result;
  });
}
