import {
  findRepositoryByFullName,
  recordWebhookEvent,
  updateWebhookEvent,
  upsertRepository,
} from '@acr/database';
import {
  actionablePullRequestAction,
  deriveReviewIdempotencyKey,
  parseWebhookEnvelope,
  requireWebhookHeaders,
  verifyWebhookSignature,
} from '@acr/github';
import { AppError, ConfigurationError, type WebhookEnvelope } from '@acr/shared';
import { requestReview, type ApplicationContainer } from '@acr/pipeline';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { describeError } from '../errors';
import { runReviewDetached } from '../http-helpers';

const PayloadSchema = z.record(z.string(), z.unknown());

/** A header may arrive as a single string or a repeated list. */
function headerValue(headers: FastifyRequest['headers'], name: string): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }
  return typeof value === 'string' ? value : undefined;
}

/**
 * GitHub retries a hook for 24 hours when it does not like the answer, so this
 * route must answer fast: verify, record, queue, and let a worker do the work.
 */
export async function registerWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/github/webhooks',
    { config: { rateLimit: false } },
    async (request, reply) => {
      const container = app.container;
      const secret = container.config.github.webhookSecret;
      if (secret.length === 0) {
        throw new ConfigurationError('GITHUB_WEBHOOK_SECRET is not configured');
      }

      const signature = headerValue(request.headers, 'x-hub-signature-256');
      // The signature covers the exact bytes GitHub sent, never a re-serialised body.
      const raw = request.rawBody ?? Buffer.alloc(0);
      const { deliveryId, event } = requireWebhookHeaders({
        deliveryId: headerValue(request.headers, 'x-github-delivery'),
        event: headerValue(request.headers, 'x-github-event'),
        signature,
      });

      verifyWebhookSignature({ payload: raw, signatureHeader: signature, secret });

      if (event === 'ping') {
        return { status: 'ok' };
      }

      const parsed = PayloadSchema.safeParse(JSON.parse(raw.toString('utf8')));
      if (!parsed.success) {
        throw new AppError('webhook payload is not a JSON object', { code: 'validation_error' });
      }
      const envelope = parseWebhookEnvelope({ deliveryId, event, payload: parsed.data });

      const known =
        envelope.repositoryFullName === null
          ? null
          : await findRepositoryByFullName(container.prisma, envelope.repositoryFullName);

      const recorded = await recordWebhookEvent(container.prisma, {
        deliveryId,
        event,
        action: envelope.action,
        repositoryFullName: envelope.repositoryFullName,
        repositoryId: known?.id ?? null,
        installationId: envelope.installationId,
        pullRequestNumber: envelope.pullRequestNumber,
        headSha: envelope.headSha,
        payloadSummary: payloadSummary(envelope),
      });
      if (recorded.duplicate) {
        return { status: 'duplicate', deliveryId };
      }

      try {
        const outcome = await handleEnvelope(container, envelope, known?.id ?? null);
        await updateWebhookEvent(container.prisma, recorded.id, {
          status: outcome.status,
          reviewRunId: outcome.reviewRunId,
        });
        reply.status(outcome.status === 'ignored' ? 200 : 202);
        return { status: outcome.status, reviewRunId: outcome.reviewRunId };
      } catch (error) {
        await updateWebhookEvent(container.prisma, recorded.id, {
          status: 'failed',
          error: describeError(error),
        }).catch(() => undefined);
        throw error;
      }
    },
  );
}

function payloadSummary(envelope: WebhookEnvelope): Record<string, unknown> {
  return {
    event: envelope.event,
    action: envelope.action,
    repository: envelope.repositoryFullName,
    pullRequestNumber: envelope.pullRequestNumber,
    sender: envelope.sender,
  };
}

async function handleEnvelope(
  container: ApplicationContainer,
  envelope: WebhookEnvelope,
  repositoryId: string | null,
): Promise<{ status: 'processed' | 'ignored'; reviewRunId: string | null }> {
  if (envelope.event !== 'pull_request') {
    return { status: 'ignored', reviewRunId: null };
  }
  const action = actionablePullRequestAction(envelope.action);
  if (action === null || envelope.repositoryFullName === null || envelope.pullRequestNumber === null) {
    return { status: 'ignored', reviewRunId: null };
  }
  if (envelope.headSha === null) {
    return { status: 'ignored', reviewRunId: null };
  }

  let knownId = repositoryId;
  if (knownId === null) {
    // A repository installed while the platform was down still needs a row.
    const created = await upsertFromEnvelope(container, envelope);
    knownId = created?.id ?? null;
  }
  if (knownId === null) {
    return { status: 'ignored', reviewRunId: null };
  }

  const result = await requestReview(container, {
    repository: envelope.repositoryFullName,
    pullRequestNumber: envelope.pullRequestNumber,
    trigger: 'webhook',
    requestedBy: envelope.sender ?? 'github-webhook',
    idempotencyKey: deriveReviewIdempotencyKey({
      repositoryId: knownId,
      pullRequestNumber: envelope.pullRequestNumber,
      headSha: envelope.headSha,
      trigger: 'webhook',
    }),
  });

  if (!result.queued) {
    runReviewDetached(container, result.reviewRunId);
  }
  return { status: 'processed', reviewRunId: result.reviewRunId };
}

async function upsertFromEnvelope(
  container: ApplicationContainer,
  envelope: WebhookEnvelope,
) {
  const fullName = envelope.repositoryFullName ?? '';
  const [owner = '', name = ''] = fullName.split('/');
  if (owner.length === 0 || name.length === 0) {
    return null;
  }
  const remote = await container.github.read.getRepository({
    owner,
    name,
    installationId: envelope.installationId,
  });
  return upsertRepository(container.prisma, {
    githubId: remote.id,
    owner: remote.owner,
    name: remote.name,
    fullName: remote.fullName,
    installationId: envelope.installationId,
    defaultBranch: remote.defaultBranch,
    isPrivate: remote.isPrivate,
    language: remote.language,
  });
}
