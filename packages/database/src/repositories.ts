import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import {
  parseRepositorySettings,
  type PullRequestInfo,
  type RepositorySettings,
} from '@acr/shared';
import type { RepositoryRow } from './mappers';

export interface RepositoryRecord {
  readonly id: string;
  readonly githubId: string;
  readonly fullName: string;
  readonly installationId: number | null;
  readonly defaultBranch: string;
  readonly isPrivate: boolean;
  readonly settings: RepositorySettings;
  readonly isActive: boolean;
}

function toRecord(row: RepositoryRow & { settings: unknown; isActive: boolean }): RepositoryRecord {
  return {
    id: row.id,
    githubId: row.githubId,
    fullName: row.fullName,
    installationId: row.installationId === null ? null : Number(row.installationId),
    defaultBranch: row.defaultBranch,
    isPrivate: row.isPrivate,
    settings: parseRepositorySettings(row.settings),
    isActive: row.isActive,
  };
}

export interface UpsertRepositoryInput {
  readonly githubId: number | string;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly installationId: number | string | null;
  readonly defaultBranch: string;
  readonly isPrivate: boolean;
  readonly language: string | null;
  /** Only applied on create; existing settings are maintained through the API. */
  readonly settings?: RepositorySettings;
}

export async function upsertRepository(
  client: PrismaClient,
  input: UpsertRepositoryInput,
): Promise<RepositoryRecord> {
  const row = await client.repository.upsert({
    where: { githubId: String(input.githubId) },
    create: {
      githubId: String(input.githubId),
      owner: input.owner,
      name: input.name,
      fullName: input.fullName,
      installationId: input.installationId === null ? null : String(input.installationId),
      defaultBranch: input.defaultBranch,
      isPrivate: input.isPrivate,
      language: input.language,
      settings: input.settings === undefined ? {} : (input.settings as object),
      lastSyncedAt: new Date(),
    },
    update: {
      owner: input.owner,
      name: input.name,
      fullName: input.fullName,
      installationId: input.installationId === null ? null : String(input.installationId),
      defaultBranch: input.defaultBranch,
      isPrivate: input.isPrivate,
      language: input.language,
      isActive: true,
      lastSyncedAt: new Date(),
    },
  });
  return toRecord(row);
}

export async function findRepositoryByFullName(
  client: PrismaClient,
  fullName: string,
): Promise<RepositoryRecord | null> {
  const row = await client.repository.findUnique({ where: { fullName } });
  return row === null ? null : toRecord(row);
}

export async function findRepositoryById(
  client: PrismaClient,
  id: string,
): Promise<RepositoryRecord | null> {
  const row = await client.repository.findUnique({ where: { id } });
  return row === null ? null : toRecord(row);
}

export async function setRepositorySettings(
  client: PrismaClient,
  id: string,
  settings: RepositorySettings,
): Promise<RepositoryRecord | null> {
  const row = await client.repository
    .update({ where: { id }, data: { settings: settings as object } })
    .catch(() => null);
  return row === null ? null : toRecord(row);
}

export interface PullRequestRecord {
  readonly id: string;
  readonly repositoryId: string;
  readonly number: number;
  readonly headSha: string;
}

/** Keeps the local copy of a pull request current without duplicating rows. */
export async function upsertPullRequest(
  client: PrismaClient,
  repositoryId: string,
  info: PullRequestInfo,
): Promise<PullRequestRecord> {
  const state =
    info.state === 'merged' ? ('MERGED' as const) : info.state === 'closed' ? ('CLOSED' as const) : ('OPEN' as const);
  const fields = {
    repositoryId,
    number: info.number,
    title: info.title,
    body: info.body,
    author: info.author,
    state,
    draft: info.draft,
    baseRef: info.baseRef,
    baseSha: info.baseSha,
    headRef: info.headRef,
    headSha: info.headSha,
    additions: info.additions,
    deletions: info.deletions,
    changedFiles: info.changedFiles,
    url: info.url,
    labels: [...info.labels],
    openedAt: new Date(info.createdAt),
    mergedAt: info.mergedAt === null ? null : new Date(info.mergedAt),
  };

  const row = await client.pullRequest.upsert({
    where: { repositoryId_number: { repositoryId, number: info.number } },
    create: { githubId: String(info.id), ...fields },
    // githubId is identity-as-first-seen; re-writing it could collide with another row.
    update: fields,
  });
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    number: row.number,
    headSha: row.headSha,
  };
}

export async function getPullRequestById(
  client: PrismaClient,
  id: string,
): Promise<{ repositoryId: string; number: number; headSha: string } | null> {
  const row = await client.pullRequest.findUnique({ where: { id } });
  return row === null
    ? null
    : { repositoryId: row.repositoryId, number: row.number, headSha: row.headSha };
}

export type WebhookEventStatus = 'received' | 'processed' | 'ignored' | 'failed';

export interface WebhookEventInput {
  readonly deliveryId: string;
  readonly event: string;
  readonly action: string | null;
  readonly repositoryFullName: string | null;
  readonly repositoryId: string | null;
  readonly installationId: number | null;
  readonly pullRequestNumber: number | null;
  readonly headSha: string | null;
  readonly payloadSummary: Record<string, unknown>;
}

/**
 * Webhook deliveries are recorded before they are handled, so a duplicate
 * delivery is visible and a crash mid-handler leaves an audit trail.
 *
 * Two deliveries with the same id can pass the `findUnique` check
 * concurrently. The UNIQUE constraint on `deliveryId` is the arbiter: a P2002
 * conflict on create means the other delivery won, so the loser reports
 * `duplicate` instead of surfacing a 500 that makes GitHub retry a webhook
 * that already succeeded. Only that exact conflict is swallowed; every other
 * database error still throws.
 */
export async function recordWebhookEvent(
  client: PrismaClient,
  input: WebhookEventInput,
): Promise<{ id: string; duplicate: boolean }> {
  const existing = await client.webhookEvent.findUnique({ where: { deliveryId: input.deliveryId } });
  if (existing !== null) {
    return { id: existing.id, duplicate: true };
  }
  let row;
  try {
    row = await client.webhookEvent.create({
      data: {
        deliveryId: input.deliveryId,
        event: input.event,
        action: input.action,
        status: 'RECEIVED',
        repositoryId: input.repositoryId,
        repositoryFullName: input.repositoryFullName,
        installationId: input.installationId === null ? null : String(input.installationId),
        pullRequestNumber: input.pullRequestNumber,
        headSha: input.headSha,
        payloadSummary: input.payloadSummary as object,
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      targetIncludes(error, 'deliveryId')
    ) {
      const raced = await client.webhookEvent.findUnique({ where: { deliveryId: input.deliveryId } });
      if (raced !== null) {
        return { id: raced.id, duplicate: true };
      }
    }
    throw error;
  }
  return { id: row.id, duplicate: false };
}

function targetIncludes(error: Prisma.PrismaClientKnownRequestError, field: string): boolean {
  const meta = error.meta as { target?: unknown } | undefined;
  const target = meta?.target;
  if (typeof target === 'string') {
    return target.includes(field);
  }
  if (Array.isArray(target)) {
    return target.some((entry) => typeof entry === 'string' && entry.includes(field));
  }
  // Some drivers omit the target; the deliveryId unique is the only one on
  // this table's create path, so a bare P2002 here is still the duplicate case.
  return true;
}

export async function updateWebhookEvent(
  client: PrismaClient,
  id: string,
  patch: { readonly status: WebhookEventStatus; readonly reviewRunId?: string | null; readonly error?: string | null },
): Promise<void> {
  const status =
    patch.status === 'processed'
      ? 'PROCESSED'
      : patch.status === 'ignored'
        ? 'IGNORED'
        : patch.status === 'failed'
          ? 'FAILED'
          : 'RECEIVED';
  await client.webhookEvent.update({
    where: { id },
    data: {
      status,
      processedAt: status === 'RECEIVED' ? null : new Date(),
      ...(patch.reviewRunId === undefined ? {} : { reviewRunId: patch.reviewRunId }),
      ...(patch.error === undefined ? {} : { error: patch.error }),
    },
  });
}
