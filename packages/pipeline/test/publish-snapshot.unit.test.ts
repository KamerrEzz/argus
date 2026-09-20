import { describe, expect, it, vi } from 'vitest';
import type { ReviewOutcome } from '@acr/ai';
import { createConfig, parseEnv, type AppConfig } from '@acr/config';
import {
  AppError,
  FindingDraftSchema,
  RepositorySettingsSchema,
  validateFinding,
  REVIEW_COMMENT_MARKER,
  type CheckRunRef,
  type FindingDraft,
  type LoggerPort,
  type RepositoryRef,
  type ReviewCommentRef,
  type ReviewEvent,
} from '@acr/shared';
import {
  CHECK_RUN_NAME,
  approvePublish,
  buildPublishArtifacts,
  enqueuePublish,
  enqueueReview,
  reconcileStaleReviews,
  parsePublishArtifacts,
  publishArtifacts,
  publishReview,
  rejectPublish,
  requestPublishGate,
  type ApplicationContainer,
  type PublishArtifacts,
  type ReviewRenderContext,
} from '@acr/pipeline';
import { QUEUES } from '@acr/queue';

// ---------------------------------------------------------------------------
// Fixtures — every artifact is built through the real schemas/renderers, so
// the snapshot guard is tested against exactly what the pipeline stores.
// ---------------------------------------------------------------------------

function testConfig(overrides: { features?: Partial<AppConfig['features']> } = {}): AppConfig {
  const base = createConfig(parseEnv({}), { workspaceRoot: '/acr-unit-test' });
  return {
    ...base,
    api: { ...base.api, publicUrl: 'https://acr.test.example/' },
    features: { ...base.features, ...overrides.features },
  };
}

const REPO_A: RepositoryRef = {
  owner: 'acme',
  name: 'widgets',
  fullName: 'acme/widgets',
  installationId: 77,
  defaultBranch: 'main',
  private: false,
};

const REPO_B: RepositoryRef = {
  owner: 'globex',
  name: 'secret-sauce',
  fullName: 'globex/secret-sauce',
  installationId: 88,
  defaultBranch: 'trunk',
  private: true,
};

function draft(overrides: Partial<FindingDraft> = {}): FindingDraft {
  return FindingDraftSchema.parse({
    severity: 'high',
    category: 'bug',
    title: 'Refund path double-charges on retry',
    description: 'A retried webhook re-runs the refund because no idempotency key is checked.',
    file: 'src/pay/refund.ts',
    line: 42,
    endLine: null,
    suggestion: null,
    confidence: 0.92,
    evidence: 'handleRefund(id) — no dedupe guard around the loop',
    source: 'agent',
    ruleId: null,
    metadata: null,
    ...overrides,
  });
}

function outcomeFixture(): ReviewOutcome {
  const actionable = validateFinding(draft(), {
    minPublishConfidence: 0.6,
    allowedFiles: ['src/pay/refund.ts'],
  });
  // Confidence 0.5 keeps the finding but suppresses publishing (< 0.6), so the
  // header must read "1 actionable finding(s) of 2 kept".
  const suppressed = validateFinding(draft({ title: 'Stale cache hides tenant rows', confidence: 0.5 }), {
    minPublishConfidence: 0.6,
    allowedFiles: ['src/pay/refund.ts'],
  });
  return {
    status: 'completed',
    verdict: 'failed',
    summary: 'one blocking refund bug',
    // The narrative is PR-derived prose: it must land sanitized in the body.
    narrative: 'Ship the guard. See [this](https://evil.example/x) and <script>steal()</script>.',
    findings: [actionable.finding, suppressed.finding],
    publishableFindings: [actionable.finding],
    validated: [actionable, suppressed],
    plan: null,
    classification: null,
    pullRequest: null,
    commands: [],
    analyses: [],
    nodeTrace: [],
    warnings: [],
    skipped: [],
    injectionSignals: [],
    usage: { tokensIn: 100, tokensOut: 50, estimatedCostUsd: 0 },
    iterations: 1,
    toolCalls: 0,
    stoppedReason: null,
    budgetExhausted: false,
    error: null,
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    workspaceDir: '/w/run-77',
  };
}

function renderContext(): ReviewRenderContext {
  return {
    outcome: outcomeFixture(),
    reviewRunId: 'run-77',
    repositoryFullName: REPO_A.fullName,
    pullRequestNumber: 7,
    headSha: 'a'.repeat(40),
    model: 'test-model',
    // 3_723_400ms -> "1h 2m 3s": exercises the hours bucket in formatDuration.
    durationMs: 3_723_400,
    dashboardUrl: 'https://acr.test.example/reviews/run-77',
  };
}

function fakeLogger(): LoggerPort {
  const logger: LoggerPort = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => logger),
  };
  return logger;
}

function fakePublishPort() {
  return {
    findSummaryComment: vi.fn(
      async (_input: { repository: RepositoryRef; pullRequestNumber: number }): Promise<ReviewCommentRef | null> =>
        null,
    ),
    createComment: vi.fn(
      async (_input: { repository: RepositoryRef; pullRequestNumber: number; body: string }) => ({
        id: 101,
        url: 'https://github.com/acme/widgets/pull/7#issuecomment-101',
        body: 'stored',
        author: 'acr-bot',
        createdAt: '2026-01-01T00:00:00Z',
      }),
    ),
    updateComment: vi.fn(
      async (_input: { repository: RepositoryRef; commentId: number; body: string }) => ({
        id: 101,
        url: 'https://github.com/acme/widgets/pull/7#issuecomment-101',
        body: 'stored',
        author: 'acr-bot',
        createdAt: '2026-01-01T00:00:00Z',
      }),
    ),
    createReviewComment: vi.fn(
      async (input: { path: string; line: number; body: string }) => ({
        id: 500 + input.line,
        url: `https://github.com/acme/widgets/pull/7#discussion_r${500 + input.line}`,
        body: input.body,
        author: 'acr-bot',
        createdAt: '2026-01-01T00:00:00Z',
      }),
    ),
    createCheckRun: vi.fn(
      async (_input: {
        repository: RepositoryRef;
        headSha: string;
        name: string;
        conclusion: 'success' | 'neutral' | 'failure' | 'cancelled' | 'skipped';
        title: string;
        summary: string;
        text: string;
        detailsUrl: string | null;
      }): Promise<CheckRunRef> => ({ id: 202, url: 'https://github.com/checks/202' }),
    ),
    updateCheckRun: vi.fn(
      async (_input: {
        repository: RepositoryRef;
        checkRunId: number;
        conclusion: 'success' | 'neutral' | 'failure' | 'cancelled' | 'skipped';
        title: string;
        summary: string;
        text: string;
      }): Promise<CheckRunRef> => ({ id: 202, url: 'https://github.com/checks/202' }),
    ),
  };
}

function fakeEvents() {
  return { publish: vi.fn(async (_event: ReviewEvent) => undefined) };
}

interface FakeContainerOptions {
  readonly config?: AppConfig;
  readonly prisma?: Record<string, unknown>;
  readonly persistence?: Record<string, unknown>;
  readonly publish?: ReturnType<typeof fakePublishPort>;
  readonly events?: ReturnType<typeof fakeEvents>;
  readonly queue?: Record<string, unknown> | null;
}

function fakeContainer(options: FakeContainerOptions = {}): ApplicationContainer {
  const publish = options.publish ?? fakePublishPort();
  const container = {
    config: options.config ?? testConfig(),
    logger: fakeLogger(),
    prisma: options.prisma ?? {},
    persistence: options.persistence ?? {},
    github: { read: {}, publish, auth: { resolveToken: vi.fn() } },
    events: options.events ?? fakeEvents(),
    queue: options.queue === undefined ? null : options.queue,
    checksQueued: false,
    sandboxUnavailable: null,
  };
  return container as unknown as ApplicationContainer;
}

function artifactsFixture(container?: ApplicationContainer): PublishArtifacts {
  return buildPublishArtifacts(container ?? fakeContainer(), {
    repository: REPO_A,
    pullRequestNumber: 7,
    headSha: 'a'.repeat(40),
    settings: RepositorySettingsSchema.parse({}),
    renderContext: renderContext(),
  });
}

function storedRow(payload: unknown) {
  return {
    id: 'appr-1',
    reviewRunId: 'run-77',
    action: 'publish_review',
    status: 'PENDING',
    payload,
    requestedAt: new Date('2026-01-01T00:00:00.000Z'),
    decidedAt: null,
    decidedById: null,
    reason: null,
  };
}

function fakeApprovalPrisma(row: ReturnType<typeof storedRow> | null) {
  return {
    reviewApproval: {
      findFirst: vi.fn(async () => row),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
        id: 'appr-new',
        status: 'PENDING',
        requestedAt: new Date('2026-01-02T00:00:00.000Z'),
        decidedAt: null,
        decidedById: null,
        reason: null,
        ...args.data,
      })),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => ({
        reviewRunId: 'run-77',
        action: 'publish_review',
        payload: {},
        requestedAt: new Date('2026-01-01T00:00:00.000Z'),
        decidedAt: null,
        decidedById: null,
        reason: null,
        id: args.where.id,
        ...args.data,
      })),
    },
    reviewRun: {
      update: vi.fn(async (_args: { where: { id: string }; data: { status: string } }) => undefined),
    },
  };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function artifactsJson(mutate: (copy: Record<string, unknown>) => void): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(artifactsFixture())) as Record<string, unknown>;
  mutate(copy);
  return copy;
}

// ---------------------------------------------------------------------------

describe('buildPublishArtifacts', () => {
  it('renders once at review time and carries the repository ref through', () => {
    const artifacts = artifactsFixture();
    expect(artifacts.reviewRunId).toBe('run-77');
    expect(artifacts.repository).toEqual(REPO_A);
    expect(artifacts.pullRequestNumber).toBe(7);
    expect(artifacts.headSha).toBe('a'.repeat(40));
    expect(artifacts.comment.startsWith(REVIEW_COMMENT_MARKER)).toBe(true);
    expect(artifacts.checkRun.conclusion).toBe('failure');
    expect(artifacts.checkRun.title).toBe('Review failed');
  });

  it('embeds the current comment shape: counts line, severity breakdown, hours bucket, sanitized narrative', () => {
    const { comment } = artifactsFixture();
    expect(comment).toContain('1 actionable finding(s) of 2 kept');
    expect(comment).toContain('1 high');
    expect(comment).toContain('1h 2m 3s');
    expect(comment).toContain('this (https://evil.example/x)');
    expect(comment).not.toContain('<script>');
    expect(comment).not.toContain('[this](https://evil.example/x)');
  });

  it('derives createComment/createCheckRun from settings AND the feature flag', () => {
    const cases: readonly (readonly [boolean, boolean, boolean])[] = [
      [true, true, true],
      [true, false, false],
      [false, true, false],
      [false, false, false],
    ];
    for (const [settingFlag, featureFlag, expected] of cases) {
      const container = fakeContainer({
        config: testConfig({ features: { checkRunEnabled: featureFlag } }),
      });
      const artifacts = buildPublishArtifacts(container, {
        repository: REPO_A,
        pullRequestNumber: 7,
        headSha: 'a'.repeat(40),
        settings: RepositorySettingsSchema.parse({
          publishSummaryComment: settingFlag,
          createCheckRun: settingFlag,
        }),
        renderContext: renderContext(),
      });
      expect(artifacts.createComment).toBe(settingFlag);
      expect(artifacts.createCheckRun).toBe(expected);
    }
  });
});

describe('parsePublishArtifacts (snapshot guard)', () => {
  it('round-trips a valid snapshot field-for-field through JSON storage', () => {
    const artifacts = artifactsFixture();
    const fromStorage = JSON.parse(JSON.stringify(artifacts)) as unknown;
    const parsed = parsePublishArtifacts(fromStorage);
    expect(parsed).toEqual(artifacts);
    if (parsed !== null) {
      // Named explicitly per the spec: comment body, check-run payload, repo ref.
      expect(parsed.comment).toBe(artifacts.comment);
      expect(parsed.checkRun).toEqual(artifacts.checkRun);
      expect(parsed.repository).toEqual(REPO_A);
      expect(parsed.repository.installationId).toBe(77);
    }
  });

  it('strips unknown extra keys instead of rejecting (the schema is not strict)', () => {
    const parsed = parsePublishArtifacts(
      artifactsJson((copy) => {
        copy['sneakyExtra'] = 'ignore me';
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual(artifactsFixture());
    expect(Object.keys(parsed ?? {})).not.toContain('sneakyExtra');
  });

  it('returns null when a required key is missing', () => {
    expect(
      parsePublishArtifacts(
        artifactsJson((copy) => {
          delete copy['comment'];
        }),
      ),
    ).toBeNull();
  });

  it('returns null for wrong types on scalars and nested fields', () => {
    expect(
      parsePublishArtifacts(
        artifactsJson((copy) => {
          copy['pullRequestNumber'] = '7';
        }),
      ),
    ).toBeNull();
    expect(
      parsePublishArtifacts(
        artifactsJson((copy) => {
          copy['headSha'] = 'ab';
        }),
      ),
    ).toBeNull();
    expect(
      parsePublishArtifacts(
        artifactsJson((copy) => {
          const repo = copy['repository'] as Record<string, unknown>;
          repo['private'] = 'yes';
        }),
      ),
    ).toBeNull();
    expect(
      parsePublishArtifacts(
        artifactsJson((copy) => {
          const checkRun = copy['checkRun'] as Record<string, unknown>;
          checkRun['conclusion'] = 'oops';
        }),
      ),
    ).toBeNull();
    expect(
      parsePublishArtifacts(
        artifactsJson((copy) => {
          copy['createComment'] = 1;
        }),
      ),
    ).toBeNull();
  });

  it('returns null for null, non-JSON strings, and arrays instead of objects', () => {
    expect(parsePublishArtifacts(null)).toBeNull();
    expect(parsePublishArtifacts(undefined)).toBeNull();
    expect(parsePublishArtifacts('this is not json')).toBeNull();
    expect(parsePublishArtifacts([artifactsFixture()])).toBeNull();
    expect(parsePublishArtifacts(42)).toBeNull();
    expect(parsePublishArtifacts({})).toBeNull();
  });
});

describe('approvePublish with a rejected snapshot', () => {
  const malformed: readonly (readonly [string, unknown, string])[] = [
    [
      'missing comment key',
      artifactsJson((copy) => {
        delete copy['comment'];
      }),
      'comment',
    ],
    [
      'wrong-typed PR number',
      artifactsJson((copy) => {
        copy['pullRequestNumber'] = '7';
      }),
      'pullRequestNumber',
    ],
    [
      'nested bad conclusion',
      artifactsJson((copy) => {
        const checkRun = copy['checkRun'] as Record<string, unknown>;
        checkRun['conclusion'] = 'oops';
      }),
      'checkRun.conclusion',
    ],
    [
      'nested bad repository field',
      artifactsJson((copy) => {
        const repo = copy['repository'] as Record<string, unknown>;
        repo['owner'] = '';
      }),
      'repository.owner',
    ],
    // A null JSON column arrives as {} after the record mapper's `?? {}` —
    // so the gate reports it as missing keys, not as a bad root type.
    ['empty object payload', {}, 'comment'],
    ['non-JSON string payload', 'nope {', '<root>'],
    ['array instead of object', [artifactsFixture()], '<root>'],
  ];

  for (const [label, payload, offendingPath] of malformed) {
    it(`${label}: throws AppError naming the path and never reaches the publisher`, async () => {
      const publish = fakePublishPort();
      const events = fakeEvents();
      const prisma = fakeApprovalPrisma(storedRow(payload));
      const container = fakeContainer({ prisma, publish, events });

      const error = await caught(
        approvePublish(container, { reviewRunId: 'run-77', decidedById: 'decider-1' }),
      );

      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe('conflict');
      expect(appError.httpStatus).toBe(409);
      expect(appError.message).toContain(offendingPath);
      const details = appError.details as { invalidPaths?: readonly string[] };
      expect(details.invalidPaths).toContain(offendingPath);

      // A rejected snapshot cannot reach the publisher in any shape:
      expect(publish.findSummaryComment).not.toHaveBeenCalled();
      expect(publish.createComment).not.toHaveBeenCalled();
      expect(publish.updateComment).not.toHaveBeenCalled();
      expect(publish.createCheckRun).not.toHaveBeenCalled();
      // nor close the approval, move the run, or emit an event.
      expect(prisma.reviewApproval.update).not.toHaveBeenCalled();
      expect(prisma.reviewRun.update).not.toHaveBeenCalled();
      expect(events.publish).not.toHaveBeenCalled();
    });
  }

  it('throws a not_found AppError (404) when there is no pending approval', async () => {
    const publish = fakePublishPort();
    const prisma = fakeApprovalPrisma(null);
    const error = await caught(
      approvePublish(fakeContainer({ prisma, publish }), {
        reviewRunId: 'run-77',
        decidedById: 'decider-1',
      }),
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('not_found');
    expect((error as AppError).httpStatus).toBe(404);
    expect(publish.findSummaryComment).not.toHaveBeenCalled();
  });
});

describe('requestPublishGate (the serialization side)', () => {
  it('stores the exact rendered snapshot, including the repository ref, and parks the run', async () => {
    const prisma = fakeApprovalPrisma(null);
    const container = fakeContainer({ prisma });
    const artifacts = artifactsFixture(container);

    const gate = await requestPublishGate(container, artifacts);

    expect(gate).toEqual({ approvalId: 'appr-new' });
    const create = prisma.reviewApproval.create.mock.calls[0]?.[0];
    expect(create?.data['reviewRunId']).toBe('run-77');
    expect(create?.data['action']).toBe('publish_review');
    expect(create?.data['status']).toBe('PENDING');
    const payload = create?.data['payload'] as Record<string, unknown>;
    expect(payload['comment']).toBe(artifacts.comment);
    expect(payload['repository']).toEqual(REPO_A);
    expect(payload['checkRun']).toEqual(artifacts.checkRun);
    expect(payload['headSha']).toBe(artifacts.headSha);

    const statusUpdate = prisma.reviewRun.update.mock.calls[0]?.[0];
    expect(statusUpdate?.where.id).toBe('run-77');
    expect(statusUpdate?.data.status).toBe('AWAITING_APPROVAL');
  });

  it('the stored payload re-reads to an identical artifact set (the approval publishes what a human read)', async () => {
    const prisma = fakeApprovalPrisma(null);
    const container = fakeContainer({ prisma });
    const artifacts = artifactsFixture(container);
    await requestPublishGate(container, artifacts);
    const create = prisma.reviewApproval.create.mock.calls[0]?.[0];
    const asJson = JSON.parse(JSON.stringify(create?.data['payload'])) as unknown;
    expect(parsePublishArtifacts(asJson)).toEqual(artifacts);
  });
});

describe('approvePublish with a valid snapshot', () => {
  function approvedSetup(payload: unknown) {
    const publish = fakePublishPort();
    const events = fakeEvents();
    const prisma = fakeApprovalPrisma(storedRow(payload));
    const container = fakeContainer({ prisma, publish, events });
    return { publish, events, prisma, container };
  }

  it('publishes exactly the stored comment and closes the approval and the run', async () => {
    const artifacts = artifactsFixture();
    const { publish, prisma, container, events } = approvedSetup(JSON.parse(JSON.stringify(artifacts)));

    const published = await approvePublish(container, {
      reviewRunId: 'run-77',
      decidedById: 'decider-1',
      reason: 'lgtm',
    });

    expect(published).toEqual({
      commentUrl: 'https://github.com/acme/widgets/pull/7#issuecomment-101',
      checkRunUrl: 'https://github.com/checks/202',
      skippedReason: null,
    });
    const created = publish.createComment.mock.calls[0]?.[0];
    expect(created?.body).toBe(artifacts.comment);
    expect(created?.repository).toEqual(REPO_A);

    const approvalUpdate = prisma.reviewApproval.update.mock.calls[0]?.[0];
    expect(approvalUpdate?.data['status']).toBe('APPROVED');
    expect(approvalUpdate?.data['decidedById']).toBe('decider-1');
    expect(approvalUpdate?.data['reason']).toBe('lgtm');
    const runUpdate = prisma.reviewRun.update.mock.calls[0]?.[0];
    expect(runUpdate?.data.status).toBe('COMPLETED');

    const event = events.publish.mock.calls[0]?.[0];
    expect(event?.type).toBe('log');
    expect(event?.message).toBe('review approved and published');
  });

  it('updates an existing summary comment instead of duplicating it', async () => {
    const artifacts = artifactsFixture();
    const { publish, container } = approvedSetup(JSON.parse(JSON.stringify(artifacts)));
    publish.findSummaryComment.mockResolvedValueOnce({
      id: 555,
      url: 'https://github.com/acme/widgets/pull/7#issuecomment-555',
      body: 'stale',
      author: 'acr-bot',
      createdAt: '2025-12-01T00:00:00Z',
    });

    await approvePublish(container, { reviewRunId: 'run-77', decidedById: 'decider-1' });

    expect(publish.createComment).not.toHaveBeenCalled();
    const update = publish.updateComment.mock.calls[0]?.[0];
    expect(update?.commentId).toBe(555);
    expect(update?.body).toBe(artifacts.comment);
  });

  it('a repo-A snapshot is published to repo A only: the ref travels untouched to every port call', async () => {
    const artifacts = artifactsFixture();
    const { publish, container } = approvedSetup(JSON.parse(JSON.stringify(artifacts)));

    await approvePublish(container, { reviewRunId: 'run-77', decidedById: 'decider-1' });

    // The snapshot carries the ref; publishArtifacts receives no repository from
    // anywhere else. Assert what the code actually checks: every GitHub call is
    // made against the snapshot's repository, and never another one.
    const everyCall = JSON.stringify([
      publish.findSummaryComment.mock.calls,
      publish.createComment.mock.calls,
      publish.updateComment.mock.calls,
      publish.createCheckRun.mock.calls,
    ]);
    expect(everyCall).toContain(REPO_A.fullName);
    expect(everyCall).not.toContain(REPO_B.fullName);
    expect(everyCall).not.toContain('"secret-sauce"');
    const checkRun = publish.createCheckRun.mock.calls[0]?.[0];
    expect(checkRun?.repository).toEqual(REPO_A);
  });

  it('rejectPublish on the same row decides without publishing anything', async () => {
    const artifacts = artifactsFixture();
    const { publish, prisma, container } = approvedSetup(JSON.parse(JSON.stringify(artifacts)));

    await expect(
      rejectPublish(container, { reviewRunId: 'run-77', decidedById: 'decider-2', reason: 'nope' }),
    ).resolves.toBeUndefined();

    expect(publish.findSummaryComment).not.toHaveBeenCalled();
    expect(publish.createCheckRun).not.toHaveBeenCalled();
    const approvalUpdate = prisma.reviewApproval.update.mock.calls[0]?.[0];
    expect(approvalUpdate?.data['status']).toBe('REJECTED');
    const runUpdate = prisma.reviewRun.update.mock.calls[0]?.[0];
    expect(runUpdate?.data.status).toBe('CANCELLED');
  });
});

describe('publishArtifacts (best-effort per artifact)', () => {
  it('does nothing when publishing is disabled globally', async () => {
    const publish = fakePublishPort();
    const container = fakeContainer({
      config: testConfig({ features: { publishEnabled: false } }),
      publish,
    });

    const result = await publishArtifacts(container, artifactsFixture(container));
    expect(result).toEqual({
      commentUrl: null,
      checkRunUrl: null,
      skippedReason: 'publishing_disabled',
    });
    expect(publish.findSummaryComment).not.toHaveBeenCalled();
    expect(publish.createCheckRun).not.toHaveBeenCalled();
  });

  it('reports comment_disabled_by_settings when the repository opted out of the comment', async () => {
    const publish = fakePublishPort();
    const container = fakeContainer({ publish });
    const artifacts = { ...artifactsFixture(container), createComment: false };

    const result = await publishArtifacts(container, artifacts);
    expect(result.skippedReason).toBe('comment_disabled_by_settings');
    expect(publish.createComment).not.toHaveBeenCalled();
    expect(publish.findSummaryComment).not.toHaveBeenCalled();
    // The check run is independent and still lands.
    expect(result.checkRunUrl).toBe('https://github.com/checks/202');
  });

  it('a rejected comment does not hide a check run that did land', async () => {
    const publish = fakePublishPort();
    publish.findSummaryComment.mockRejectedValueOnce(new Error('403 resource locked'));
    const container = fakeContainer({ publish });

    const result = await publishArtifacts(container, artifactsFixture(container));
    expect(result.commentUrl).toBeNull();
    expect(result.skippedReason).toContain('comment_failed');
    expect(result.skippedReason).toContain('403 resource locked');
    expect(result.checkRunUrl).toBe('https://github.com/checks/202');
  });

  it('a failing check run is swallowed; the comment survives', async () => {
    const publish = fakePublishPort();
    publish.createCheckRun.mockRejectedValueOnce(new Error('boom'));
    const container = fakeContainer({ publish });

    const result = await publishArtifacts(container, artifactsFixture(container));
    expect(result.commentUrl).toBe('https://github.com/acme/widgets/pull/7#issuecomment-101');
    expect(result.checkRunUrl).toBeNull();
  });

  it('points the check run at the dashboard URL built from api.publicUrl (trailing slash trimmed)', async () => {
    const publish = fakePublishPort();
    const container = fakeContainer({ publish });
    await publishArtifacts(container, artifactsFixture(container));
    const call = publish.createCheckRun.mock.calls[0]?.[0];
    expect(call?.detailsUrl).toBe('https://acr.test.example/reviews/run-77');
    expect(call?.name).toBe(CHECK_RUN_NAME);
  });
});

describe('publishReview', () => {
  it('renders fresh at call time and publishes that render (no snapshot involved)', async () => {
    const publish = fakePublishPort();
    const container = fakeContainer({ publish });
    const result = await publishReview(container, {
      repository: REPO_A,
      pullRequestNumber: 7,
      headSha: 'a'.repeat(40),
      settings: RepositorySettingsSchema.parse({}),
      renderContext: renderContext(),
    });
    expect(result.commentUrl).toBe('https://github.com/acme/widgets/pull/7#issuecomment-101');
    const created = publish.createComment.mock.calls[0]?.[0];
    expect(created?.body).toContain('1 actionable finding(s) of 2 kept');
  });
});

describe('enqueueReview / enqueuePublish prefer the queue, fall back to inline', () => {
  it('dispatches to the process-review queue when one exists', async () => {
    const dispatch = vi.fn(
      async (_name: string, _payload: unknown, _options: unknown) => ({ jobId: 'job-1', deduplicated: false }),
    );
    const container = fakeContainer({ queue: { dispatch } });

    const jobId = await enqueueReview(container, { reviewRunId: 'run-77', trigger: 'manual' });
    expect(jobId).toBe('job-1');
    expect(dispatch).toHaveBeenCalledTimes(1);
    const call = dispatch.mock.calls[0];
    expect(call?.[0]).toBe(QUEUES.processReview);
    expect(call?.[1]).toEqual({ reviewRunId: 'run-77', trigger: 'manual' });
    expect(call?.[2]).toEqual({ jobId: 'review-run-77' });
  });

  it('returns null when container.queue === null so the caller runs inline', async () => {
    const container = fakeContainer({ queue: null });
    await expect(
      enqueueReview(container, { reviewRunId: 'run-77', trigger: 'webhook' }),
    ).resolves.toBeNull();
    await expect(enqueuePublish(container, { reviewRunId: 'run-77' })).resolves.toBeNull();
  });

  it('dispatches publish-review with its own dedup key, and surfaces dedup as null', async () => {
    const dispatch = vi.fn(
      async (_name: string, _payload: unknown, _options: unknown) => ({ jobId: null, deduplicated: true }),
    );
    const container = fakeContainer({ queue: { dispatch } });
    const jobId = await enqueuePublish(container, { reviewRunId: 'run-77', requestedBy: 'u-1' });
    expect(jobId).toBeNull();
    const call = dispatch.mock.calls[0];
    expect(call?.[0]).toBe(QUEUES.publishReview);
    expect(call?.[2]).toEqual({ jobId: 'publish-run-77' });
  });
});

describe('reconcileStaleReviews', () => {
  function prismaWithStale(rows: readonly { id: string; trigger: string }[]) {
    return { reviewRun: { findMany: vi.fn().mockResolvedValue(rows) } };
  }

  it('re-dispatches a QUEUED run that has no live job', async () => {
    const dispatch = vi.fn().mockResolvedValue({ jobId: 'review-run-1', deduplicated: false });
    const hasLiveJob = vi.fn().mockResolvedValue(false);
    const container = fakeContainer({
      prisma: prismaWithStale([{ id: 'run-1', trigger: 'MANUAL' }]),
      queue: { dispatch, hasLiveJob },
    });

    const outcome = await reconcileStaleReviews(container);

    expect(outcome).toEqual({ scanned: 1, requeued: 1, alive: 0 });
    expect(hasLiveJob).toHaveBeenCalledWith(QUEUES.processReview, 'review-run-1');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[2]).toEqual({ jobId: 'review-run-1' });
  });

  it('leaves a run alone while its job is still alive, so a backlog is never doubled', async () => {
    const dispatch = vi.fn();
    const container = fakeContainer({
      prisma: prismaWithStale([{ id: 'run-2', trigger: 'MANUAL' }]),
      queue: { dispatch, hasLiveJob: vi.fn().mockResolvedValue(true) },
    });

    const outcome = await reconcileStaleReviews(container);

    expect(outcome).toEqual({ scanned: 1, requeued: 0, alive: 1 });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does nothing when the process runs inline without a queue', async () => {
    const container = fakeContainer({ queue: null });
    await expect(reconcileStaleReviews(container)).resolves.toEqual({
      scanned: 0,
      requeued: 0,
      alive: 0,
    });
  });
});

describe('inline findings', () => {
  function withInlineSetting(publishFindingsAsComments: boolean) {
    const publish = fakePublishPort();
    const markFindingsPublished = vi.fn().mockResolvedValue(undefined);
    const container = fakeContainer({ publish, persistence: { markFindingsPublished } });
    const artifacts = buildPublishArtifacts(container, {
      repository: REPO_A,
      pullRequestNumber: 7,
      headSha: 'a'.repeat(40),
      settings: RepositorySettingsSchema.parse({ publishFindingsAsComments }),
      renderContext: renderContext(),
    });
    return { container, publish, markFindingsPublished, artifacts };
  }

  it('anchors one comment per publishable finding when the setting is on', () => {
    const { artifacts } = withInlineSetting(true);

    expect(artifacts.createInlineComments).toBe(true);
    // The suppressed finding (confidence 0.5) must not be anchored.
    expect(artifacts.inline).toHaveLength(1);
    expect(artifacts.inline[0]).toMatchObject({
      path: 'src/pay/refund.ts',
      line: 42,
      startLine: null,
    });
    expect(artifacts.inline[0]?.body).toContain('Refund path double-charges on retry');
  });

  it('is the setting the thing that decides, so off means nothing inline', () => {
    const { artifacts } = withInlineSetting(false);

    expect(artifacts.createInlineComments).toBe(false);
    expect(artifacts.inline).toEqual([]);
  });

  it('publishes the inline comments and records the comment id per fingerprint', async () => {
    const { container, publish, markFindingsPublished, artifacts } = withInlineSetting(true);

    await publishArtifacts(container, artifacts);

    expect(publish.createReviewComment).toHaveBeenCalledTimes(1);
    expect(publish.createReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'src/pay/refund.ts', line: 42, commitId: 'a'.repeat(40) }),
    );
    expect(markFindingsPublished).toHaveBeenCalledWith('run-77', [
      { fingerprint: artifacts.inline[0]?.fingerprint, commentId: 542 },
    ]);
  });

  it('keeps the rest of the publish working when one inline comment is rejected', async () => {
    const { container, publish, markFindingsPublished, artifacts } = withInlineSetting(true);
    publish.createReviewComment.mockRejectedValueOnce(new Error('422 line must be part of the diff'));

    const refs = await publishArtifacts(container, artifacts);

    expect(refs.commentUrl).toContain('#issuecomment-101');
    expect(markFindingsPublished).toHaveBeenCalledWith('run-77', [
      { fingerprint: artifacts.inline[0]?.fingerprint, commentId: null },
    ]);
  });
});
