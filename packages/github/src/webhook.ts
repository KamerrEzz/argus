import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  ValidationError,
  WebhookVerificationError,
  isReviewTriggerAction,
  sha256Hex,
  type PullRequestAction,
  type WebhookEnvelope,
} from '@acr/shared';
import {
  PullRequestWebhookSchema,
  type PullRequestWebhookPayload,
} from '@acr/shared';

const SIGNATURE_PREFIX = 'sha256=';

export function computeWebhookSignature(payload: Buffer | string, secret: string): string {
  const digest = createHmac('sha256', secret).update(payload).digest('hex');
  return `${SIGNATURE_PREFIX}${digest}`;
}

export interface VerifyWebhookInput {
  readonly payload: Buffer | string;
  readonly signatureHeader: string | undefined;
  readonly secret: string;
}

/**
 * GitHub signs the raw request body. The comparison is timing-safe and the raw
 * body must be the exact bytes received, never a re-serialised object.
 */
export function verifyWebhookSignature(input: VerifyWebhookInput): void {
  if (input.secret.length === 0) {
    throw new WebhookVerificationError('Webhook secret is not configured');
  }
  if (input.signatureHeader === undefined || !input.signatureHeader.startsWith(SIGNATURE_PREFIX)) {
    throw new WebhookVerificationError('Missing or malformed webhook signature header');
  }
  const provided = Buffer.from(input.signatureHeader.slice(SIGNATURE_PREFIX.length), 'utf8');
  const expected = Buffer.from(computeWebhookSignature(input.payload, input.secret).slice(SIGNATURE_PREFIX.length), 'utf8');
  if (provided.length !== expected.length) {
    throw new WebhookVerificationError('Webhook signature mismatch');
  }
  if (!timingSafeEqual(provided, expected)) {
    throw new WebhookVerificationError('Webhook signature mismatch');
  }
}

export interface WebhookHeaders {
  readonly deliveryId: string | undefined;
  readonly event: string | undefined;
  readonly signature: string | undefined;
}

export function requireWebhookHeaders(headers: WebhookHeaders): {
  readonly deliveryId: string;
  readonly event: string;
} {
  if (headers.deliveryId === undefined || headers.deliveryId.trim().length === 0) {
    throw new ValidationError('Missing X-GitHub-Delivery header');
  }
  if (headers.event === undefined || headers.event.trim().length === 0) {
    throw new ValidationError('Missing X-GitHub-Event header');
  }
  return { deliveryId: headers.deliveryId, event: headers.event };
}

export function parsePullRequestWebhook(payload: unknown): PullRequestWebhookPayload {
  const parsed = PullRequestWebhookSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError(
      'Unsupported pull_request webhook payload',
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  return parsed.data;
}

export function parseWebhookEnvelope(input: {
  readonly deliveryId: string;
  readonly event: string;
  readonly payload: Record<string, unknown>;
}): WebhookEnvelope {
  const repository = input.payload['repository'] as
    | { id?: unknown; full_name?: unknown }
    | undefined;
  const installation = input.payload['installation'] as { id?: unknown } | undefined;
  const pullRequest = input.payload['pull_request'] as
    | { number?: unknown; head?: { sha?: unknown } }
    | undefined;
  const sender = input.payload['sender'] as { login?: unknown } | undefined;
  const action = input.payload['action'];

  const repositoryGithubId =
    typeof repository?.id === 'number' ? repository.id : null;

  return {
    deliveryId: input.deliveryId,
    event: input.event,
    action: typeof action === 'string' ? action : null,
    installationId: typeof installation?.id === 'number' ? installation.id : null,
    repositoryFullName: typeof repository?.full_name === 'string' ? repository.full_name : null,
    repositoryGithubId,
    pullRequestNumber:
      typeof pullRequest?.number === 'number'
        ? pullRequest.number
        : typeof input.payload['number'] === 'number'
          ? (input.payload['number'] as number)
          : null,
    headSha: typeof pullRequest?.head?.sha === 'string' ? pullRequest.head.sha : null,
    sender: typeof sender?.login === 'string' ? sender.login : null,
  };
}

export function actionablePullRequestAction(action: string | null): PullRequestAction | null {
  if (action === null || !isReviewTriggerAction(action)) {
    return null;
  }
  return action;
}

export function deriveWebhookIdempotencyKey(input: {
  readonly deliveryId: string;
  readonly event: string;
  readonly action: string | null;
}): string {
  return sha256Hex(`webhook:${input.deliveryId}:${input.event}:${input.action ?? 'none'}`);
}

export function deriveReviewIdempotencyKey(input: {
  readonly repositoryId: string;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly trigger: string;
}): string {
  return sha256Hex(
    `review:${input.repositoryId}:${input.pullRequestNumber}:${input.headSha}:${input.trigger}`,
  );
}

export function derivePublishIdempotencyKey(reviewRunId: string): string {
  return sha256Hex(`publish:${reviewRunId}`);
}
