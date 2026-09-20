import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createConfig, parseEnv } from '@acr/config';
import { ScriptedProvider } from '@acr/ai';
import {
  createUser,
  grantRepositoryAccess,
  upsertRepository,
  type UserRecord,
} from '@acr/database';
import type { GithubIntegration } from '@acr/github';
import type { PullRequestInfo } from '@acr/shared';
import { createContainer, type ApplicationContainer } from '@acr/pipeline';
import { buildApp } from '../src/app';
import { signSession } from '../src/auth/session';

/**
 * Regression for: POST /reviews accepted any authenticated caller for any
 * `owner/name` without checking repository access, while the equivalent
 * POST /pull-requests/:id/review requires `triage`.
 *
 * A member with no grant on repository A must be denied BEFORE any GitHub
 * read, ReviewRun creation, or queue dispatch happens.
 */
describe('POST /reviews authorization', () => {
  let container: ApplicationContainer | null = null;
  let app: FastifyInstance | null = null;
  let repoFullName = '';
  let outsider: UserRecord | null = null;
  let insider: UserRecord | null = null;
  let reader: UserRecord | null = null;
  let retryRunId = '';

  const githubCalls = { getRepository: 0, getPullRequest: 0 };
  let prNumber = 0;
  // Per-run base for fake pull-request GitHub ids: a fixed base collides with
  // the rows earlier runs created (githubId is globally unique).
  let prIdBase = 0;

  function fakePullRequest(number: number): PullRequestInfo {
    return {
      id: prIdBase + number,
      number,
      title: 'Authz fixture PR',
      body: 'fixture',
      author: 'fixture-author',
      state: 'open',
      draft: false,
      baseRef: 'main',
      baseSha: 'a'.repeat(40),
      headRef: 'feature/authz',
      headSha: 'b'.repeat(40),
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      url: `https://github.com/${repoFullName}/pull/${number}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      mergedAt: null,
      labels: [],
    };
  }

  async function cookieFor(user: UserRecord): Promise<string> {
    if (container === null) {
      throw new Error('test container not initialised');
    }
    const { token } = await signSession(
      {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        tokenVersion: user.tokenVersion,
      },
      container.config,
    );
    return `${container.config.auth.cookieName}=${token}`;
  }

  beforeAll(async () => {
    const config = createConfig(parseEnv());
    // The provider is never called: denied requests stop before the pipeline
    // and the allowed control only queues (a worker would execute it).
    const scripted = new ScriptedProvider(() => ({
      text: 'authz test: no model output needed',
      inputTokens: 1,
      outputTokens: 1,
    }));
    const created = await createContainer({ config, provider: scripted, requireRedis: true, loggerName: 'api-authz-test' });
    container = created;

    const suffix = randomUUID().slice(0, 8);
    repoFullName = `authz-org/authz-repo-${suffix}`;
    const [owner = '', name = ''] = repoFullName.split('/');
    // One per-run GitHub id shared by the fake port and the local repository:
    // requestReview re-reads the repo from GitHub and upserts by this id, so a
    // fixed id makes every run share one local repo and its old pull requests,
    // which collide on (repositoryId, number).
    const githubRepoId = Number(
      `${Date.now() % 100_000_000}${Math.floor(Math.random() * 1_000)
        .toString()
        .padStart(3, '0')}`,
    );
    prIdBase = githubRepoId;

    const fakeGithub = {
      ...created.github,
      auth: { resolveToken: () => Promise.resolve('authz-test-token') },
      read: {
        ...created.github.read,
        getRepository: (input: { readonly owner: string; readonly name: string }) => {
          githubCalls.getRepository += 1;
          return Promise.resolve({
            id: githubRepoId,
            fullName: `${input.owner}/${input.name}`,
            owner: input.owner,
            name: input.name,
            defaultBranch: 'main',
            isPrivate: true,
            language: 'TypeScript',
          });
        },
        getPullRequest: () => {
          githubCalls.getPullRequest += 1;
          prNumber += 1;
          return Promise.resolve(fakePullRequest(prNumber));
        },
      },
    } as unknown as GithubIntegration;
    (created as unknown as { github: GithubIntegration }).github = fakeGithub;

    const repo = await upsertRepository(created.prisma, {
      githubId: githubRepoId,
      owner,
      name,
      fullName: repoFullName,
      installationId: null,
      defaultBranch: 'main',
      isPrivate: true,
      language: 'TypeScript',
    });

    outsider = await createUser(created.prisma, {
      email: `authz-outsider-${suffix}@example.com`,
      name: 'Authz Outsider',
      password: 'authz-password-123',
      role: 'member',
    });
    insider = await createUser(created.prisma, {
      email: `authz-insider-${suffix}@example.com`,
      name: 'Authz Insider',
      password: 'authz-password-123',
      role: 'member',
    });
    await grantRepositoryAccess(created.prisma, {
      userId: insider.id,
      repositoryId: repo.id,
      level: 'triage',
    });
    reader = await createUser(created.prisma, {
      email: `authz-reader-${suffix}@example.com`,
      name: 'Authz Reader',
      password: 'authz-password-123',
      role: 'member',
    });
    await grantRepositoryAccess(created.prisma, {
      userId: reader.id,
      repositoryId: repo.id,
      level: 'read',
    });

    // A finished run to retry, created directly: retry authorization must be
    // testable without spending a real review on the positive path.
    const pullRequest = await created.prisma.pullRequest.create({
      data: {
        githubId: `authz-retry-${suffix}`,
        repositoryId: repo.id,
        number: 77,
        title: 'Authz retry fixture',
        author: 'fixture-author',
        baseRef: 'main',
        baseSha: 'a'.repeat(40),
        headRef: 'feature/retry',
        headSha: 'c'.repeat(40),
        url: `https://github.com/${repoFullName}/pull/77`,
      },
    });
    const run = await created.prisma.reviewRun.create({
      data: {
        repositoryId: repo.id,
        pullRequestId: pullRequest.id,
        status: 'COMPLETED',
        trigger: 'MANUAL',
        headSha: 'c'.repeat(40),
        baseSha: 'a'.repeat(40),
        model: 'authz-test',
        idempotencyKey: `authz-retry-${suffix}`,
      },
    });
    retryRunId = run.id;

    app = await buildApp({ container: created, disableRateLimit: true });
  }, 120_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    await container?.close().catch(() => undefined);
  });

  it('denies a member with no grant before touching GitHub or creating a run', async () => {
    expect(app).not.toBeNull();
    expect(container).not.toBeNull();
    expect(outsider).not.toBeNull();
    if (app === null || container === null || outsider === null) {
      throw new Error('authz fixture not initialised');
    }
    const active = container;
    const runsBefore = await active.prisma.reviewRun.count();
    const readsBefore = githubCalls.getPullRequest;
    const reposBefore = githubCalls.getRepository;

    const response = await app.inject({
      method: 'POST',
      url: '/reviews',
      headers: { cookie: await cookieFor(outsider) },
      payload: { repository: repoFullName, pullRequestNumber: 41 },
    });

    expect(response.statusCode).toBe(404);
    // No work started: no ReviewRun row, no queue dispatch side effects, and
    // crucially no GitHub reads issued on behalf of an unauthorized caller.
    expect(await active.prisma.reviewRun.count()).toBe(runsBefore);
    expect(githubCalls.getPullRequest).toBe(readsBefore);
    expect(githubCalls.getRepository).toBe(reposBefore);
  });

  it('does not probe GitHub for unknown repository names', async () => {
    expect(app).not.toBeNull();
    expect(outsider).not.toBeNull();
    if (app === null || outsider === null) {
      throw new Error('authz fixture not initialised');
    }
    const reposBefore = githubCalls.getRepository;
    const response = await app.inject({
      method: 'POST',
      url: '/reviews',
      headers: { cookie: await cookieFor(outsider) },
      payload: { repository: `authz-org/does-not-exist-${randomUUID().slice(0, 8)}`, pullRequestNumber: 1 },
    });
    expect(response.statusCode).toBe(404);
    expect(githubCalls.getRepository).toBe(reposBefore);
  });

  it('allows a member with triage access (positive control)', async () => {
    expect(app).not.toBeNull();
    expect(insider).not.toBeNull();
    if (app === null || insider === null) {
      throw new Error('authz fixture not initialised');
    }
    const response = await app.inject({
      method: 'POST',
      url: '/reviews',
      headers: { cookie: await cookieFor(insider) },
      payload: { repository: repoFullName, pullRequestNumber: 42 },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().created).toBe(true);
  });

  it('denies retry to a read-only member before creating a run or touching GitHub', async () => {
    expect(app).not.toBeNull();
    expect(container).not.toBeNull();
    expect(reader).not.toBeNull();
    if (app === null || container === null || reader === null || retryRunId.length === 0) {
      throw new Error('authz fixture not initialised');
    }
    const active = container;
    const runsBefore = await active.prisma.reviewRun.count();
    const readsBefore = githubCalls.getPullRequest;

    // Retry starts a brand-new run (LLM budget + GitHub writes), so read access
    // must not be enough: it needs the same triage bar as triggering a review.
    const response = await app.inject({
      method: 'POST',
      url: `/reviews/${retryRunId}/retry`,
      headers: { cookie: await cookieFor(reader) },
      payload: {},
    });

    expect(response.statusCode).toBe(404);
    expect(await active.prisma.reviewRun.count()).toBe(runsBefore);
    expect(githubCalls.getPullRequest).toBe(readsBefore);
  });

  it('lets a triage member retry (positive control)', async () => {
    expect(app).not.toBeNull();
    expect(insider).not.toBeNull();
    if (app === null || insider === null || retryRunId.length === 0) {
      throw new Error('authz fixture not initialised');
    }
    const response = await app.inject({
      method: 'POST',
      url: `/reviews/${retryRunId}/retry`,
      headers: { cookie: await cookieFor(insider) },
      payload: {},
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().created).toBe(true);
  });
});
