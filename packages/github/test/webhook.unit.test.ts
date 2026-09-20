import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  actionablePullRequestAction,
  computeWebhookSignature,
  deriveReviewIdempotencyKey,
  parsePullRequestWebhook,
  parseWebhookEnvelope,
  requireWebhookHeaders,
  verifyWebhookSignature,
} from '@acr/github';
import { ValidationError, WebhookVerificationError } from '@acr/shared';

const SECRET = 'webhook-top-secret';

function signatureFor(payload: Buffer | string, secret = SECRET): string {
  // Independent oracle: recompute GitHub's scheme with node:crypto directly.
  const digest = createHmac('sha256', secret).update(payload).digest('hex');
  return `sha256=${digest}`;
}

function canonicalPrPayload(
  action: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    action,
    number: 42,
    repository: { id: 1234, name: 'demo', full_name: 'acme/demo', private: false },
    installation: { id: 99 },
    sender: { login: 'octocat' },
    pull_request: {
      number: 42,
      title: 'Add caching layer',
      draft: false,
      head: { ref: 'feature/cache', sha: 'abc123headsha' },
      base: { ref: 'main', sha: 'def456basesha' },
    },
    ...overrides,
  };
}

describe('verifyWebhookSignature — HMAC verification', () => {
  const body = Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8');

  it('accepts a correctly signed Buffer payload', () => {
    expect(() =>
      verifyWebhookSignature({ payload: body, signatureHeader: signatureFor(body), secret: SECRET }),
    ).not.toThrow();
  });

  it('accepts a correctly signed string payload', () => {
    const text = '{"hello":"world"}';
    expect(() =>
      verifyWebhookSignature({
        payload: text,
        signatureHeader: signatureFor(text),
        secret: SECRET,
      }),
    ).not.toThrow();
  });

  it('computeWebhookSignature matches the independent oracle', () => {
    expect(computeWebhookSignature(body, SECRET)).toBe(signatureFor(body));
    expect(computeWebhookSignature(body, SECRET)).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('rejects a signature produced with the wrong secret', () => {
    expect(() =>
      verifyWebhookSignature({
        payload: body,
        signatureHeader: signatureFor(body, 'attacker-secret'),
        secret: SECRET,
      }),
    ).toThrow(WebhookVerificationError);
  });

  it('rejects a body mutated by a single byte', () => {
    const header = signatureFor(body);
    const mutated = Buffer.from(body);
    mutated[mutated.length - 1] = (mutated[mutated.length - 1] ?? 0) ^ 0x01;
    expect(mutated.equals(body)).toBe(false);
    const error = catchWebhookError(() =>
      verifyWebhookSignature({ payload: mutated, signatureHeader: header, secret: SECRET }),
    );
    expect(error).toBeInstanceOf(WebhookVerificationError);
    expect(error?.message).toBe('Webhook signature mismatch');
  });

  it('rejects a header missing the sha256= prefix', () => {
    const raw = signatureFor(body).slice('sha256='.length);
    for (const header of [raw, `sha1=${'0'.repeat(40)}`, `SHA256=${raw}`, ` ${raw}`]) {
      expect(() =>
        verifyWebhookSignature({ payload: body, signatureHeader: header, secret: SECRET }),
      ).toThrow(WebhookVerificationError);
    }
  });

  it('rejects empty and undefined signature headers', () => {
    for (const header of ['', undefined]) {
      const error = catchWebhookError(() =>
        verifyWebhookSignature({ payload: body, signatureHeader: header, secret: SECRET }),
      );
      expect(error).toBeInstanceOf(WebhookVerificationError);
      expect(error?.message).toBe('Missing or malformed webhook signature header');
    }
  });

  it('rejects non-hex and truncated digests', () => {
    for (const header of [`sha256=${'z'.repeat(64)}`, 'sha256=abc', 'sha256=', 'sha256=zz']) {
      expect(() =>
        verifyWebhookSignature({ payload: body, signatureHeader: header, secret: SECRET }),
      ).toThrow(WebhookVerificationError);
    }
  });

  it('fails closed when no webhook secret is configured', () => {
    // An empty secret must reject every delivery rather than verify against
    // a known HMAC key (or, worse, skip verification).
    expect(() =>
      verifyWebhookSignature({ payload: body, signatureHeader: signatureFor(body, ''), secret: '' }),
    ).toThrow('Webhook secret is not configured');
  });

  it('signs the raw bytes, not a re-serialised body', () => {
    // GitHub signs exact bytes; a proxy that re-serialises JSON (extra space)
    // must fail verification even though the parsed object is identical.
    const raw = Buffer.from('{"hello":"world"}', 'utf8');
    const header = signatureFor(raw);
    const reserialised = Buffer.from('{"hello": "world"}', 'utf8');
    expect(JSON.parse(reserialised.toString('utf8'))).toEqual(JSON.parse(raw.toString('utf8')));
    expect(() =>
      verifyWebhookSignature({ payload: reserialised, signatureHeader: header, secret: SECRET }),
    ).toThrow('Webhook signature mismatch');
  });

  it('accepts an empty body signed over zero bytes', () => {
    const empty = Buffer.alloc(0);
    expect(() =>
      verifyWebhookSignature({
        payload: empty,
        signatureHeader: signatureFor(empty),
        secret: SECRET,
      }),
    ).not.toThrow();
  });

  it('accepts a unicode body byte-for-byte', () => {
    const unicode = Buffer.from('{"msg":"✓ ünïcode 🚀 — listo"}', 'utf8');
    expect(() =>
      verifyWebhookSignature({
        payload: unicode,
        signatureHeader: signatureFor(unicode),
        secret: SECRET,
      }),
    ).not.toThrow();
  });

  it('rejects every attempt when the secret is not configured', () => {
    const error = catchWebhookError(() =>
      verifyWebhookSignature({ payload: body, signatureHeader: signatureFor(body, ''), secret: '' }),
    );
    expect(error).toBeInstanceOf(WebhookVerificationError);
    expect(error?.message).toBe('Webhook secret is not configured');
  });

  it('carries the stable webhook_signature_invalid code', () => {
    const error = catchWebhookError(() =>
      verifyWebhookSignature({ payload: body, signatureHeader: 'sha256=nope', secret: SECRET }),
    );
    expect(error?.code).toBe('webhook_signature_invalid');
  });
});

function catchWebhookError(fn: () => void): WebhookVerificationError | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof WebhookVerificationError ? error : null;
  }
}

describe('requireWebhookHeaders', () => {
  it('returns deliveryId and event when both are present', () => {
    expect(
      requireWebhookHeaders({
        deliveryId: 'd-1',
        event: 'pull_request',
        signature: 'sha256=whatever',
      }),
    ).toEqual({ deliveryId: 'd-1', event: 'pull_request' });
  });

  it('names the missing X-GitHub-Delivery header first', () => {
    const error = catchHeaderError(() =>
      requireWebhookHeaders({ deliveryId: undefined, event: undefined, signature: 'sha256=x' }),
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect(error?.message).toBe('Missing X-GitHub-Delivery header');
  });

  it('treats a whitespace-only delivery id as missing', () => {
    expect(() =>
      requireWebhookHeaders({ deliveryId: '  ', event: 'pull_request', signature: 'sha256=x' }),
    ).toThrow('Missing X-GitHub-Delivery header');
  });

  it('names the missing X-GitHub-Event header when only the event is absent', () => {
    const error = catchHeaderError(() =>
      requireWebhookHeaders({ deliveryId: 'd-1', event: ' ', signature: 'sha256=x' }),
    );
    expect(error?.message).toBe('Missing X-GitHub-Event header');
  });

  it('ignores the signature header value (verified elsewhere)', () => {
    expect(
      requireWebhookHeaders({ deliveryId: 'd-1', event: 'ping', signature: undefined }),
    ).toEqual({ deliveryId: 'd-1', event: 'ping' });
  });
});

function catchHeaderError(fn: () => unknown): ValidationError | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof ValidationError ? error : null;
  }
}

describe('parseWebhookEnvelope', () => {
  function envelopeFor(payload: Record<string, unknown>, event = 'pull_request') {
    return parseWebhookEnvelope({ deliveryId: 'del-1', event, payload });
  }

  it('maps a pull_request opened delivery exactly to the fields the API route consumes', () => {
    const envelope = envelopeFor(canonicalPrPayload('opened'));
    expect(envelope).toEqual({
      deliveryId: 'del-1',
      event: 'pull_request',
      action: 'opened',
      installationId: 99,
      repositoryFullName: 'acme/demo',
      repositoryGithubId: 1234,
      pullRequestNumber: 42,
      headSha: 'abc123headsha',
      sender: 'octocat',
    });
  });

  it('carries synchronize, closed, and labeled actions through unchanged', () => {
    for (const action of ['synchronize', 'closed', 'labeled'] as const) {
      const envelope = envelopeFor(canonicalPrPayload(action));
      expect(envelope.event).toBe('pull_request');
      expect(envelope.action).toBe(action);
      expect(envelope.pullRequestNumber).toBe(42);
      expect(envelope.headSha).toBe('abc123headsha');
    }
  });

  it('reads the PR number from the top-level number when pull_request is absent', () => {
    const payload = canonicalPrPayload('opened');
    delete payload['pull_request'];
    const envelope = envelopeFor(payload);
    expect(envelope.pullRequestNumber).toBe(42);
    expect(envelope.headSha).toBeNull();
  });

  it('maps a non-PR push delivery with null PR fields', () => {
    const envelope = envelopeFor(
      {
        ref: 'refs/heads/main',
        before: 'aaa',
        after: 'bbb',
        repository: { id: 7, name: 'demo', full_name: 'acme/demo' },
        sender: { login: 'bot' },
        head_commit: { id: 'bbb' },
      },
      'push',
    );
    expect(envelope).toEqual({
      deliveryId: 'del-1',
      event: 'push',
      action: null,
      installationId: null,
      repositoryFullName: 'acme/demo',
      repositoryGithubId: 7,
      pullRequestNumber: null,
      headSha: null,
      sender: 'bot',
    });
  });

  it('nulls out every field whose type is wrong instead of trusting GitHub', () => {
    const envelope = envelopeFor({
      action: 7,
      repository: { id: '1234', full_name: 55 },
      installation: { id: '99' },
      pull_request: { number: '42', head: { sha: 999 } },
      sender: { login: true },
    });
    expect(envelope.action).toBeNull();
    expect(envelope.repositoryGithubId).toBeNull();
    expect(envelope.repositoryFullName).toBeNull();
    expect(envelope.installationId).toBeNull();
    expect(envelope.pullRequestNumber).toBeNull();
    expect(envelope.headSha).toBeNull();
    expect(envelope.sender).toBeNull();
  });

  it('tolerates a completely empty payload object', () => {
    const envelope = envelopeFor({});
    expect(envelope).toEqual({
      deliveryId: 'del-1',
      event: 'pull_request',
      action: null,
      installationId: null,
      repositoryFullName: null,
      repositoryGithubId: null,
      pullRequestNumber: null,
      headSha: null,
      sender: null,
    });
  });
});

describe('actionablePullRequestAction truth table', () => {
  const cases: ReadonlyArray<readonly [string | null, string | null]> = [
    ['opened', 'opened'],
    ['synchronize', 'synchronize'],
    ['reopened', 'reopened'],
    ['ready_for_review', 'ready_for_review'],
    ['closed', null],
    ['labeled', null],
    ['unlabeled', null],
    ['edited', null],
    ['assigned', null],
    ['review_requested', null],
    ['', null],
    ['Opened', null],
    ['SYNCHRONIZE', null],
    ['bogus', null],
    [null, null],
  ];

  for (const [input, expected] of cases) {
    it(`maps ${JSON.stringify(input)} to ${JSON.stringify(expected)}`, () => {
      expect(actionablePullRequestAction(input)).toBe(expected);
    });
  }
});

describe('deriveReviewIdempotencyKey', () => {
  const base = {
    repositoryId: 'repo-1',
    pullRequestNumber: 42,
    headSha: 'abc123',
    trigger: 'webhook',
  };

  it('is stable for identical inputs', () => {
    expect(deriveReviewIdempotencyKey(base)).toBe(deriveReviewIdempotencyKey({ ...base }));
  });

  it('equals an independent sha256 over the documented join format', () => {
    const expected = createHash('sha256')
      .update(`review:${base.repositoryId}:${base.pullRequestNumber}:${base.headSha}:${base.trigger}`)
      .digest('hex');
    expect(deriveReviewIdempotencyKey(base)).toBe(expected);
  });

  it('produces a lowercase 64-char hex digest', () => {
    expect(deriveReviewIdempotencyKey(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is sensitive to the repository id', () => {
    expect(deriveReviewIdempotencyKey({ ...base, repositoryId: 'repo-2' })).not.toBe(
      deriveReviewIdempotencyKey(base),
    );
  });

  it('is sensitive to the PR number', () => {
    expect(deriveReviewIdempotencyKey({ ...base, pullRequestNumber: 43 })).not.toBe(
      deriveReviewIdempotencyKey(base),
    );
  });

  it('is sensitive to the head sha', () => {
    expect(deriveReviewIdempotencyKey({ ...base, headSha: 'def999' })).not.toBe(
      deriveReviewIdempotencyKey(base),
    );
  });

  it('is sensitive to the trigger', () => {
    expect(deriveReviewIdempotencyKey({ ...base, trigger: 'manual' })).not.toBe(
      deriveReviewIdempotencyKey(base),
    );
  });
});

describe('parsePullRequestWebhook — payload schema guard', () => {
  it('accepts the canonical opened payload produced by GitHub', () => {
    const parsed = parsePullRequestWebhook(canonicalPrPayload('opened'));
    expect(parsed.action).toBe('opened');
    expect(parsed.pull_request.head.sha).toBe('abc123headsha');
  });

  it('rejects a payload missing the head sha with path-carrying details', () => {
    try {
      parsePullRequestWebhook({
        action: 'opened',
        repository: { id: 1, name: 'r', full_name: 'a/r' },
        pull_request: { number: 1, head: {} },
      });
      expect.unreachable('expected ValidationError');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const details = (error as ValidationError).details;
      expect(Array.isArray(details)).toBe(true);
      expect((details as string[]).join('\n')).toContain('pull_request.head.sha');
    }
  });

  it('rejects an action that is not a non-empty string', () => {
    expect(() =>
      parsePullRequestWebhook({
        action: '',
        repository: { id: 1, name: 'r', full_name: 'a/r' },
        pull_request: { number: 1, head: { sha: 'a' }, base: { sha: 'b' } },
      }),
    ).toThrow(ValidationError);
  });
});
