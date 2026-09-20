import type { PrismaClient } from '@prisma/client';

export const PUBLISH_ACTION = 'publish_review';

export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'expired';
export type ReviewRunState = 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';

export interface ApprovalRecord {
  readonly id: string;
  readonly reviewRunId: string;
  readonly action: string;
  readonly status: ApprovalState;
  readonly payload: Record<string, unknown>;
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  readonly decidedById: string | null;
  readonly reason: string | null;
}

const STATUS_FROM_DB: Readonly<Record<string, ApprovalState>> = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
};

const STATUS_TO_DB: Readonly<Record<ApprovalState, 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED'>> = {
  pending: 'PENDING',
  approved: 'APPROVED',
  rejected: 'REJECTED',
  expired: 'EXPIRED',
};

const RUN_STATUS_TO_DB: Readonly<Record<ReviewRunState, string>> = {
  queued: 'QUEUED',
  running: 'RUNNING',
  awaiting_approval: 'AWAITING_APPROVAL',
  completed: 'COMPLETED',
  failed: 'FAILED',
  cancelled: 'CANCELLED',
};

interface ApprovalRow {
  readonly id: string;
  readonly reviewRunId: string;
  readonly action: string;
  readonly status: keyof typeof STATUS_FROM_DB;
  readonly payload: unknown;
  readonly requestedAt: Date;
  readonly decidedAt: Date | null;
  readonly decidedById: string | null;
  readonly reason: string | null;
}

function toApproval(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    reviewRunId: row.reviewRunId,
    action: row.action,
    status: STATUS_FROM_DB[row.status] ?? 'pending',
    payload: (row.payload ?? {}) as Record<string, unknown>,
    requestedAt: row.requestedAt.toISOString(),
    decidedAt: row.decidedAt === null ? null : row.decidedAt.toISOString(),
    decidedById: row.decidedById,
    reason: row.reason,
  };
}

/**
 * A publish approval snapshots the artifacts to be published. Approval then
 * means "send exactly this", never "re-render whatever the row says now".
 */
export async function requestApproval(
  prisma: PrismaClient,
  input: {
    readonly reviewRunId: string;
    readonly action: string;
    readonly payload: Record<string, unknown>;
  },
): Promise<ApprovalRecord> {
  const existing = await prisma.reviewApproval.findFirst({
    where: { reviewRunId: input.reviewRunId, action: input.action, status: 'PENDING' },
    orderBy: { requestedAt: 'desc' },
  });
  if (existing !== null) {
    return toApproval(existing);
  }
  const created = await prisma.reviewApproval.create({
    data: {
      reviewRunId: input.reviewRunId,
      action: input.action,
      status: 'PENDING',
      payload: input.payload as object,
    },
  });
  return toApproval(created);
}

export async function requestPublishApproval(
  prisma: PrismaClient,
  reviewRunId: string,
  payload: Record<string, unknown>,
): Promise<ApprovalRecord> {
  return requestApproval(prisma, { reviewRunId, action: PUBLISH_ACTION, payload });
}

export async function findApprovalById(
  prisma: PrismaClient,
  id: string,
): Promise<ApprovalRecord | null> {
  const row = await prisma.reviewApproval.findUnique({ where: { id } });
  return row === null ? null : toApproval(row);
}

export async function findPendingPublishApproval(
  prisma: PrismaClient,
  reviewRunId: string,
): Promise<ApprovalRecord | null> {
  const row = await prisma.reviewApproval.findFirst({
    where: { reviewRunId, action: PUBLISH_ACTION, status: 'PENDING' },
    orderBy: { requestedAt: 'desc' },
  });
  return row === null ? null : toApproval(row);
}

export async function listApprovalsForRun(
  prisma: PrismaClient,
  reviewRunId: string,
): Promise<readonly ApprovalRecord[]> {
  const rows = await prisma.reviewApproval.findMany({
    where: { reviewRunId },
    orderBy: { requestedAt: 'asc' },
  });
  return rows.map(toApproval);
}

export async function decideApproval(
  prisma: PrismaClient,
  input: {
    readonly approvalId: string;
    readonly decidedById: string;
    readonly status: Extract<ApprovalState, 'approved' | 'rejected' | 'expired'>;
    readonly reason?: string;
  },
): Promise<ApprovalRecord | null> {
  const row = await prisma.reviewApproval
    .update({
      where: { id: input.approvalId },
      data: {
        status: STATUS_TO_DB[input.status],
        decidedAt: new Date(),
        decidedById: input.decidedById,
        reason: input.reason ?? null,
      },
    })
    .catch(() => null);
  return row === null ? null : toApproval(row);
}

export async function setReviewRunStatus(
  prisma: PrismaClient,
  reviewRunId: string,
  status: ReviewRunState,
): Promise<void> {
  await prisma.reviewRun.update({
    where: { id: reviewRunId },
    data: { status: RUN_STATUS_TO_DB[status] as 'QUEUED' },
  });
}
