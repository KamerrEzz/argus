import { findRepositoryById, getReviewRunDetail } from '@acr/database';
import { executeReview, type ApplicationContainer } from '@acr/pipeline';
import type { PrismaClient } from '@prisma/client';
import { AppError, NotFoundError, type RepositoryRef } from '@acr/shared';
import type { FastifyRequest } from 'fastify';
import { assertRepositoryAccess } from './auth/guard';

export function splitFullName(fullName: string): { owner: string; name: string } {
  const [owner = '', name = ''] = fullName.split('/');
  return { owner, name };
}

export function repositoryIdOfRun(detail: Record<string, unknown>): string | null {
  const direct = detail['repositoryId'];
  if (typeof direct === 'string') {
    return direct;
  }
  const repository = detail['repository'];
  if (typeof repository === 'object' && repository !== null) {
    const id = (repository as Record<string, unknown>)['id'];
    return typeof id === 'string' ? id : null;
  }
  return null;
}

export function pullRequestNumberOfRun(detail: Record<string, unknown>): number | null {
  const pullRequest = detail['pullRequest'];
  if (typeof pullRequest !== 'object' || pullRequest === null) {
    return null;
  }
  const number = (pullRequest as Record<string, unknown>)['number'];
  return typeof number === 'number' ? number : null;
}

/** Loads a run and asserts access in one step, so no route can forget either. */
export async function loadRunFor(
  request: FastifyRequest,
  reviewRunId: string,
  needed: 'read' | 'triage' = 'read',
): Promise<Record<string, unknown>> {
  const container = request.server.container;
  const detail = await getReviewRunDetail(container.prisma, reviewRunId);
  if (detail === null) {
    throw new NotFoundError('review run');
  }
  const repositoryId = repositoryIdOfRun(detail);
  if (repositoryId === null) {
    throw new AppError('review run has no repository', { code: 'internal_error' });
  }
  await assertRepositoryAccess(request, repositoryId, needed);
  return detail;
}

/** Rebuilds the GitHub reference the read and publish ports need. */
export async function repositoryRefFor(
  prisma: PrismaClient,
  repositoryId: string,
): Promise<RepositoryRef | null> {
  const record = await findRepositoryById(prisma, repositoryId);
  if (record === null) {
    return null;
  }
  const { owner, name } = splitFullName(record.fullName);
  return {
    owner,
    name,
    fullName: record.fullName,
    installationId: record.installationId,
    defaultBranch: record.defaultBranch,
    private: record.isPrivate,
  };
}

/**
 * Start a review without holding the HTTP request open. The caller has already
 * been told the run exists, and the run records its own progress.
 */
export function runReviewDetached(
  container: ApplicationContainer,
  reviewRunId: string,
): void {
  void executeReview(container, reviewRunId).catch((error: unknown) => {
    container.logger.error(
      { reviewRunId, error: error instanceof Error ? error.message : String(error) },
      'detached review failed',
    );
  });
}
