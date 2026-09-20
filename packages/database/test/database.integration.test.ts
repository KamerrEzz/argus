import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_REPOSITORY_SETTINGS, type RepositorySettings } from '@acr/shared';
import {
  authenticateUser,
  createUser,
  decideApproval,
  disconnectPrismaClient,
  findApprovalById,
  findRepositoryByFullName,
  findRepositoryById,
  getPrismaClient,
  hashPassword,
  listApprovalsForRun,
  listPullRequests,
  listRepositories,
  listReviewFindings,
  listReviewRuns,
  listUsers,
  listWebhookEvents,
  recordWebhookEvent,
  requestApproval,
  seedDatabase,
  setRepositorySettings,
  updateWebhookEvent,
  upsertRepository,
  verifyPassword,
  PUBLISH_ACTION,
  type UpsertRepositoryInput,
} from '@acr/database';

let prisma: ReturnType<typeof getPrismaClient>;

/** Seed IDs (packages/database/src/seed.ts). Approvals and settings tests must
 * reference rows that really exist: ReviewApproval.reviewRunId is a foreign key. */
const SEEDED_RUN_COMPLETED = '88888888-8888-4888-8888-888888888888';
const SEEDED_RUN_FAILED = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SEEDED_ADMIN = '11111111-1111-4111-8111-111111111111';
const SEEDED_REVIEWER = '22222222-2222-4222-8222-222222222222';

beforeAll(() => {
  prisma = getPrismaClient();
});

afterAll(async () => {
  await disconnectPrismaClient();
});

describe('seedDatabase idempotency', () => {
  const FOREIGN_EMAIL = 'seed-adoption-check@example.com';

  it('adopts an account that already owns the admin email instead of failing on it', async () => {
    const foreignId = randomUUID();
    await prisma.repositoryAccess.deleteMany({ where: { userId: foreignId } });
    await prisma.user.deleteMany({ where: { email: FOREIGN_EMAIL } });
    await prisma.user.create({
      data: {
        id: foreignId,
        email: FOREIGN_EMAIL,
        name: 'Bootstrap Admin',
        passwordHash: 'not-a-real-hash',
        role: 'ADMIN',
        isActive: true,
      },
    });

    try {
      // Before the fix this threw P2002 on user.email: the seed upserted by its
      // own fixed id while the API bootstrap had created the same email already.
      const summary = await seedDatabase(prisma, {
        adminEmail: FOREIGN_EMAIL,
        adminPassword: 'seed-password-123',
        adminName: 'Bootstrap Admin',
      });

      expect(summary.credentials.email).toBe(FOREIGN_EMAIL);
      const adopted = await prisma.user.findUnique({ where: { email: FOREIGN_EMAIL } });
      expect(adopted?.id).toBe(foreignId);
    } finally {
      // The run moved the demo access rows onto the stand-in account; seeding
      // with the default email puts them back before the stand-in is removed.
      await seedDatabase(prisma).catch(() => undefined);
      await prisma.repositoryAccess.deleteMany({ where: { userId: foreignId } });
      await prisma.user.deleteMany({ where: { id: foreignId } });
    }
  });

  it('runs twice in a row without throwing', async () => {
    await expect(seedDatabase(prisma)).resolves.toBeDefined();
    await expect(seedDatabase(prisma)).resolves.toBeDefined();
  });
});

describe('Prisma client', () => {
  it('connects to the live database', async () => {
    const result = await prisma.$queryRaw<{ value: bigint }[]>`SELECT 1 as value`;
    expect(result).toBeDefined();
  });

  it('can query the users table', async () => {
    const users = await prisma.user.findMany({ take: 1 });
    expect(Array.isArray(users)).toBe(true);
    expect(users.length).toBeGreaterThanOrEqual(1);
  });
});

describe('listReviewRuns', () => {
  it('returns a paginated result with items and totals', async () => {
    const result = await listReviewRuns(prisma, { take: 10, skip: 0 });
    expect(result.items).toBeDefined();
    expect(typeof result.total).toBe('number');
    expect(result.total).toBeGreaterThanOrEqual(result.items.length);
  });

  it('supports pagination with a stable total', async () => {
    const full = await listReviewRuns(prisma, { take: 100, skip: 0 });
    const small = await listReviewRuns(prisma, { take: 5, skip: 0 });
    expect(small.items.length).toBeLessThanOrEqual(5);
    expect(full.total).toBe(small.total);
  });

  it('filters by status', async () => {
    const completed = await listReviewRuns(prisma, { take: 100, skip: 0, status: 'completed' });
    expect(completed.total).toBeGreaterThan(0);
    for (const item of completed.items) {
      expect(String(item['status'])).toBe('completed');
    }
  });
});

describe('listRepositories', () => {
  it('returns a paginated result', async () => {
    const result = await listRepositories(prisma, { take: 100, skip: 0 });
    expect(result.items).toBeDefined();
    expect(typeof result.total).toBe('number');
    expect(result.total).toBeGreaterThanOrEqual(result.items.length);
  });

  it('supports case-insensitive search', async () => {
    // Seed repositories are acme/api-gateway and acme/web-console.
    const result = await listRepositories(prisma, { take: 100, skip: 0, search: 'API-GATEWAY' });
    expect(result.total).toBeGreaterThan(0);
    for (const item of result.items) {
      expect(item.fullName.toLowerCase()).toContain('api-gateway');
    }
  });
});

describe('listPullRequests', () => {
  it('returns a paginated result', async () => {
    const result = await listPullRequests(prisma, { take: 100, skip: 0 });
    expect(result.items).toBeDefined();
    expect(typeof result.total).toBe('number');
  });

  it('filters by state', async () => {
    // All three seeded pull requests are OPEN.
    const result = await listPullRequests(prisma, { take: 100, skip: 0, state: 'open' });
    expect(result.total).toBeGreaterThan(0);
    for (const item of result.items) {
      expect(String(item['state'])).toBe('open');
    }
  });
});

describe('listReviewFindings', () => {
  it('returns findings for the seeded completed run', async () => {
    const results = await listReviewFindings(prisma, SEEDED_RUN_COMPLETED, {});
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  });

  it('filters by severity', async () => {
    const criticalFindings = await listReviewFindings(prisma, SEEDED_RUN_COMPLETED, {
      severity: 'critical',
    });
    expect(criticalFindings.length).toBeGreaterThan(0);
    for (const finding of criticalFindings) {
      expect(String(finding['severity'])).toBe('critical');
    }
  });

  it('filters by publishableOnly without exceeding the unfiltered set', async () => {
    const all = await listReviewFindings(prisma, SEEDED_RUN_COMPLETED, {});
    const publishable = await listReviewFindings(prisma, SEEDED_RUN_COMPLETED, {
      publishableOnly: true,
    });
    expect(publishable.length).toBeLessThanOrEqual(all.length);
  });
});

describe('approval workflow', () => {
  it('creates a pending approval and finds it by id', async () => {
    const result = await requestApproval(prisma, {
      reviewRunId: SEEDED_RUN_COMPLETED,
      action: PUBLISH_ACTION,
      payload: { comment: 'Integration test approval' },
    });

    expect(result).toBeDefined();
    expect(result.status).toBe('pending');
    expect(result.reviewRunId).toBe(SEEDED_RUN_COMPLETED);

    const found = await findApprovalById(prisma, result.id);
    expect(found).toBeDefined();
    expect(found?.status).toBe('pending');
  });

  it('decides an approval (approve)', async () => {
    const created = await requestApproval(prisma, {
      reviewRunId: SEEDED_RUN_COMPLETED,
      action: 'integration:approve',
      payload: { comment: 'Will be approved' },
    });

    const decided = await decideApproval(prisma, {
      approvalId: created.id,
      decidedById: SEEDED_REVIEWER,
      status: 'approved',
      reason: 'looks good',
    });

    expect(decided?.status).toBe('approved');
    expect(decided?.decidedById).toBe(SEEDED_REVIEWER);
  });

  it('decides an approval (reject)', async () => {
    const created = await requestApproval(prisma, {
      reviewRunId: SEEDED_RUN_COMPLETED,
      action: 'integration:reject',
      payload: { comment: 'Will be rejected' },
    });

    const decided = await decideApproval(prisma, {
      approvalId: created.id,
      decidedById: SEEDED_REVIEWER,
      status: 'rejected',
      reason: 'not safe',
    });

    expect(decided?.status).toBe('rejected');
  });

  it('re-deciding overwrites the previous decision (as-coded: no throw)', async () => {
    const created = await requestApproval(prisma, {
      reviewRunId: SEEDED_RUN_COMPLETED,
      action: 'integration:redecide',
      payload: { comment: 'Decided twice' },
    });

    await decideApproval(prisma, {
      approvalId: created.id,
      decidedById: SEEDED_REVIEWER,
      status: 'approved',
      reason: 'approved',
    });

    // decideApproval updates unconditionally and returns null only when the row
    // is gone, so a second decision overwrites instead of throwing.
    const second = await decideApproval(prisma, {
      approvalId: created.id,
      decidedById: SEEDED_ADMIN,
      status: 'rejected',
      reason: 'changed my mind',
    });
    expect(second?.status).toBe('rejected');
    expect(second?.decidedById).toBe(SEEDED_ADMIN);
  });
});

describe('listApprovalsForRun', () => {
  it('returns approvals for the seeded run', async () => {
    await requestApproval(prisma, {
      reviewRunId: SEEDED_RUN_COMPLETED,
      action: 'integration:list',
      payload: { comment: 'Listed' },
    });

    const results = await listApprovalsForRun(prisma, SEEDED_RUN_COMPLETED);
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const approval of results) {
      expect(approval.reviewRunId).toBe(SEEDED_RUN_COMPLETED);
    }
  });

  it('returns an empty array for a run that was never gated', async () => {
    const results = await listApprovalsForRun(prisma, SEEDED_RUN_FAILED);
    expect(results).toBeDefined();
    expect(results.length).toBe(0);
  });
});

describe('repository CRUD', () => {
  it('upserts and finds by fullName', async () => {
    const input: UpsertRepositoryInput = {
      githubId: 999001,
      owner: 'test-org',
      name: 'integration-test',
      fullName: 'test-org/integration-test',
      installationId: null,
      defaultBranch: 'main',
      isPrivate: true,
      language: null,
    };
    const created = await upsertRepository(prisma, input);
    expect(created).toBeDefined();
    expect(created.fullName).toBe('test-org/integration-test');

    const found = await findRepositoryByFullName(prisma, 'test-org/integration-test');
    expect(found).toBeDefined();
    expect(found?.fullName).toBe('test-org/integration-test');
  });

  it('returns null for a non-existent repository', async () => {
    expect(await findRepositoryById(prisma, '00000000-0000-4000-8000-000000000000')).toBeNull();
    expect(await findRepositoryByFullName(prisma, 'unknown/unknown')).toBeNull();
  });
});

describe('setRepositorySettings', () => {
  it('updates settings for an existing repo by id', async () => {
    const created = await upsertRepository(prisma, {
      githubId: 999002,
      owner: 'test-org',
      name: 'settings-repo',
      fullName: 'test-org/settings-repo',
      installationId: null,
      defaultBranch: 'main',
      isPrivate: true,
      language: null,
    });

    const settings: RepositorySettings = {
      ...DEFAULT_REPOSITORY_SETTINGS,
      enableLint: false,
      minPublishConfidence: 0.75,
      maxFiles: 25,
      ignorePaths: ['tests/**'],
      agentPermissions: {
        granted: ['repository:read', 'pull_request:read', 'comments:write'],
        denied: ['review:publish'],
      },
    };

    const updated = await setRepositorySettings(prisma, created.id, settings);
    expect(updated).toBeDefined();
    expect(updated?.fullName).toBe('test-org/settings-repo');
    expect(updated?.settings.minPublishConfidence).toBe(0.75);
    expect(updated?.settings.enableLint).toBe(false);
  });
});

describe('webhook events', () => {
  it('records a webhook event and updates its status', async () => {
    const deliveryId = `it-${randomUUID()}`;
    const result = await recordWebhookEvent(prisma, {
      deliveryId,
      event: 'pull_request',
      action: 'opened',
      repositoryId: null,
      repositoryFullName: null,
      installationId: null,
      pullRequestNumber: 7,
      headSha: 'abc123',
      payloadSummary: { test: true },
    });

    expect(result).toBeDefined();
    expect(typeof result.id).toBe('string');
    expect(result.duplicate).toBe(false);

    await updateWebhookEvent(prisma, result.id, { status: 'processed' });

    const events = await listWebhookEvents(prisma, { take: 100, skip: 0 });
    const found = events.items.find((event) => String(event['deliveryId']) === deliveryId);
    expect(found).toBeDefined();
    expect(String(found?.['status'])).toBe('processed');
  });

  it('deduplicates webhook events by deliveryId', async () => {
    const deliveryId = `it-${randomUUID()}`;
    const input = {
      deliveryId,
      event: 'push',
      action: null,
      repositoryId: null,
      repositoryFullName: null,
      installationId: null,
      pullRequestNumber: null,
      headSha: null,
      payloadSummary: { test: true },
    } as const;
    const first = await recordWebhookEvent(prisma, input);
    const second = await recordWebhookEvent(prisma, input);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(first.id).toBe(second.id);
  });

  it('handles concurrent duplicate deliveries without a 500-class error', async () => {
    // Regression: recordWebhookEvent was find-then-create, so two deliveries
    // racing past findUnique collided on the UNIQUE(deliveryId) constraint and
    // the loser threw P2002. Exactly one attempt must win; the rest must
    // report duplicate, and none may reject.
    const deliveryId = `it-race-${randomUUID()}`;
    const input = {
      deliveryId,
      event: 'pull_request',
      action: 'synchronize',
      repositoryId: null,
      repositoryFullName: null,
      installationId: null,
      pullRequestNumber: 9,
      headSha: 'deadbeef',
      payloadSummary: { test: true },
    } as const;
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => recordWebhookEvent(prisma, input)),
    );
    const created = attempts.filter((attempt) => !attempt.duplicate);
    const duplicates = attempts.filter((attempt) => attempt.duplicate);
    expect(created).toHaveLength(1);
    expect(duplicates).toHaveLength(7);
    for (const duplicate of duplicates) {
      expect(duplicate.id).toBe(created[0]?.id);
    }
  });
});

describe('authentication', () => {
  it('authenticates the seeded admin', async () => {
    const user = await authenticateUser(prisma, 'admin@example.com', 'change-me-please');
    expect(user).toBeDefined();
    expect(user?.email).toBe('admin@example.com');
  });

  it('returns null for a wrong password', async () => {
    expect(await authenticateUser(prisma, 'admin@example.com', 'wrong-password')).toBeNull();
  });

  it('returns null for a non-existent user', async () => {
    expect(await authenticateUser(prisma, 'non-existent@example.com', 'some-password')).toBeNull();
  });
});

describe('password hashing', () => {
  it('hashes and verifies correctly', async () => {
    const hash = await hashPassword('test-password-123');
    expect(await verifyPassword('test-password-123', hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct-password');
    expect(await verifyPassword('wrong-password', hash)).toBe(false);
  });

  it('produces different hashes (bcrypt salt)', async () => {
    const first = await hashPassword('same-password');
    const second = await hashPassword('same-password');
    expect(first).not.toBe(second);
    expect(await verifyPassword('same-password', first)).toBe(true);
    expect(await verifyPassword('same-password', second)).toBe(true);
  });
});

describe('createUser', () => {
  it('creates a new user and lists it', async () => {
    const email = `it-${randomUUID()}@example.com`;
    const created = await createUser(prisma, {
      email,
      name: 'Integration Test User',
      password: 'test-password-123',
      role: 'member',
    });

    expect(created).toBeDefined();
    expect(created.email).toBe(email);

    const users = await listUsers(prisma, 100);
    expect(users.some((user) => user.email === email)).toBe(true);
  });
});

describe('listWebhookEvents', () => {
  it('returns a paginated result', async () => {
    const result = await listWebhookEvents(prisma, { take: 100, skip: 0 });
    expect(result.items).toBeDefined();
    expect(typeof result.total).toBe('number');
    expect(result.total).toBeGreaterThanOrEqual(result.items.length);
  });
});
