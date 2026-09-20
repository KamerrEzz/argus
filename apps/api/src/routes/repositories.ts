import {
  getRepositoryDetail,
  grantRepositoryAccess,
  listRepositories,
  revokeRepositoryAccess,
  setRepositorySettings,
  upsertRepository,
} from '@acr/database';
import { AppError, NotFoundError, parseRepositorySettings } from '@acr/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { accessibleRepositoryIds, assertRepositoryAccess, claimsOf, requireAdmin, requireSession } from '../auth/guard';
import { parseOrThrow } from '../errors';
import { AccessSchema } from './auth';

const PageQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().max(200).optional(),
  activeOnly: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .transform((value) => value === 'true' || value === true)
    .optional(),
});

const IdParams = z.object({ id: z.string().min(1).max(64) });
const OwnerNameSchema = z.object({
  owner: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
});
const UserParams = z.object({ id: z.string().min(1).max(64), userId: z.string().min(1).max(64) });

function pageArgs(parsed: { page: number; pageSize: number }): { take: number; skip: number } {
  return { take: parsed.pageSize, skip: (parsed.page - 1) * parsed.pageSize };
}

export async function registerRepositoryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/repositories', { preHandler: [requireSession] }, async (request) => {
    const query = parseOrThrow(PageQuery, request.query, 'query');
    const scope = await accessibleRepositoryIds(request);
    if (scope !== 'all' && scope.length === 0) {
      return { items: [], total: 0, take: query.pageSize, skip: (query.page - 1) * query.pageSize };
    }
    return listRepositories(app.container.prisma, {
      ...pageArgs(query),
      search: query.search,
      ...(query.activeOnly === undefined ? {} : { isActive: query.activeOnly }),
      ...(scope === 'all' ? {} : { repositoryIds: scope }),
    });
  });

  /**
   * Adds a repository the platform can already reach. GitHub is asked first, so
   * a typo is a clear 404 rather than a row nobody can install against.
   */
  app.post('/repositories', { preHandler: [requireSession, requireAdmin] }, async (request, reply) => {
    const body = parseOrThrow(OwnerNameSchema, request.body, 'repository');
    const remote = await app.container.github.read.getRepository({
      owner: body.owner,
      name: body.name,
      installationId: null,
    });
    const record = await upsertRepository(app.container.prisma, {
      githubId: remote.id,
      owner: remote.owner,
      name: remote.name,
      fullName: remote.fullName,
      installationId: null,
      defaultBranch: remote.defaultBranch,
      isPrivate: remote.isPrivate,
      language: remote.language,
    });
    const claims = claimsOf(request);
    await grantRepositoryAccess(app.container.prisma, {
      userId: claims.sub,
      repositoryId: record.id,
      level: 'admin',
    });
    reply.status(201);
    return { repository: record };
  });

  /** Mirrors everything the GitHub App is installed on. Admin-only by design. */
  app.post('/repositories/sync', { preHandler: [requireSession, requireAdmin] }, async () => {
    const container = app.container;
    const installations = await container.github.installations.listInstallations();
    const synced: string[] = [];
    const failures: { installation: number; error: string }[] = [];

    for (const installation of installations) {
      try {
        const repositories = await container.github.installations.listRepositories(installation.id);
        for (const repository of repositories) {
          await upsertRepository(container.prisma, {
            githubId: repository.id,
            owner: repository.owner,
            name: repository.name,
            fullName: repository.fullName,
            installationId: installation.id,
            defaultBranch: repository.defaultBranch,
            isPrivate: repository.private,
            language: repository.language,
          });
          synced.push(repository.fullName);
        }
      } catch (error) {
        failures.push({
          installation: installation.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { synced: synced.length, repositories: synced, failures };
  });

  app.get('/repositories/:id', { preHandler: [requireSession] }, async (request) => {
    const params = parseOrThrow(IdParams, request.params, 'params');
    await assertRepositoryAccess(request, params.id, 'read');
    const detail = await getRepositoryDetail(app.container.prisma, params.id);
    if (detail === null) {
      throw new NotFoundError('repository');
    }
    return { repository: detail };
  });

  app.patch(
    '/repositories/:id/settings',
    { preHandler: [requireSession] },
    async (request) => {
      const params = parseOrThrow(IdParams, request.params, 'params');
      await assertRepositoryAccess(request, params.id, 'admin');
      const settings = parseOrThrow(z.record(z.string(), z.unknown()), request.body, 'settings');
      const current = await getRepositoryDetail(app.container.prisma, params.id);
      if (current === null) {
        throw new NotFoundError('repository');
      }
      // Merge, then validate: callers send the fields they changed only.
      const merged = parseRepositorySettings({
        ...(current['settings'] as Record<string, unknown> | undefined),
        ...settings,
      });
      const updated = await setRepositorySettings(app.container.prisma, params.id, merged);
      if (updated === null) {
        throw new AppError('could not update repository settings', { code: 'database_error' });
      }
      return { repository: updated };
    },
  );

  app.get(
    '/repositories/:id/access',
    { preHandler: [requireSession] },
    async (request) => {
      const params = parseOrThrow(IdParams, request.params, 'params');
      await assertRepositoryAccess(request, params.id, 'read');
      const detail = await getRepositoryDetail(app.container.prisma, params.id);
      if (detail === null) {
        throw new NotFoundError('repository');
      }
      return { access: detail['access'] ?? [] };
    },
  );

  app.put(
    '/repositories/:id/access',
    { preHandler: [requireSession] },
    async (request, reply) => {
      const params = parseOrThrow(IdParams, request.params, 'params');
      await assertRepositoryAccess(request, params.id, 'admin');
      const body = parseOrThrow(AccessSchema, request.body, 'access');
      await grantRepositoryAccess(app.container.prisma, {
        userId: body.userId,
        repositoryId: params.id,
        level: body.permission,
        grantedById: claimsOf(request).sub,
      });
      reply.status(201);
      return { status: 'granted' };
    },
  );

  app.delete(
    '/repositories/:id/access/:userId',
    { preHandler: [requireSession] },
    async (request) => {
      const params = parseOrThrow(UserParams, request.params, 'params');
      await assertRepositoryAccess(request, params.id, 'admin');
      await revokeRepositoryAccess(
        app.container.prisma,
        params.userId,
        params.id,
      );
      return { status: 'revoked' };
    },
  );
}
