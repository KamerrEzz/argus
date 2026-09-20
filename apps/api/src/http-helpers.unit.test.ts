import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Side-effect import: loads the @fastify/cookie module augmentation that gives
// FastifyRequest its `cookies` property (used by auth/guard.ts).
import '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { createConfig, parseEnv, type AppConfig } from '@acr/config';
import type { RepositoryRecord, UserRecord } from '@acr/database';
import type { ApplicationContainer } from '@acr/pipeline';
import {
  AppError,
  DEFAULT_REPOSITORY_SETTINGS,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  type RepositoryPermissionLevel,
} from '@acr/shared';
import { signSession, type SessionClaims } from './auth/session';
import {
  accessibleRepositoryIds,
  assertRepositoryAccess,
  claimsOf,
  isAdmin,
  optionalSession,
  requireAdmin,
  requireSession,
  resolveSession,
} from './auth/guard';
import {
  loadRunFor,
  pullRequestNumberOfRun,
  repositoryIdOfRun,
  repositoryRefFor,
  runReviewDetached,
  splitFullName,
} from './http-helpers';

// ---------------------------------------------------------------------------
// Unit-only seams: the database module and the pipeline's executeReview are
// replaced wholesale; everything else (session JWTs, guards, config) is the
// real code. No server is ever constructed — fakes are cast through `unknown`.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => ({
  getReviewRunDetail: vi.fn(
    async (_prisma: unknown, _reviewRunId: string): Promise<Record<string, unknown> | null> => null,
  ),
  findRepositoryById: vi.fn(
    async (_prisma: unknown, _id: string): Promise<RepositoryRecord | null> => null,
  ),
  findUserById: vi.fn(async (_prisma: unknown, _id: string): Promise<UserRecord | null> => null),
  getRepositoryAccessLevel: vi.fn(
    async (_prisma: unknown, _userId: string, _repositoryId: string): Promise<RepositoryPermissionLevel | null> => null,
  ),
  listAccessibleRepositoryIds: vi.fn(
    async (_prisma: unknown, _userId: string): Promise<readonly string[]> => [],
  ),
}));

const pipeline = vi.hoisted(() => ({
  executeReview: vi.fn(async (_container: ApplicationContainer, _reviewRunId: string): Promise<void> => undefined),
}));

vi.mock('@acr/database', () => db);
vi.mock('@acr/pipeline', () => pipeline);

const SECRET = 'unit-test-http-secret-0123456789abcdef';

function sessionConfig(): AppConfig {
  return createConfig(parseEnv({ AUTH_SECRET: SECRET }), { workspaceRoot: '/acr-unit-test' });
}

const CONFIG = sessionConfig();

interface FakeContainer {
  readonly prisma: { id: 'fake-prisma' };
  readonly config: AppConfig;
  readonly logger: { error: (_obj: unknown, _msg?: string) => void };
}

function fakeContainer(): FakeContainer {
  return {
    prisma: { id: 'fake-prisma' },
    config: CONFIG,
    logger: { error: vi.fn((_obj: unknown, _msg?: string): void => undefined) },
  };
}

function asContainer(container: FakeContainer): ApplicationContainer {
  return container as unknown as ApplicationContainer;
}

function asPrisma(prisma: FakeContainer['prisma']): PrismaClient {
  return prisma as unknown as PrismaClient;
}

function fakeRequest(options: {
  readonly container: FakeContainer;
  readonly user?: SessionClaims | null;
  readonly cookies?: Record<string, string>;
}): FastifyRequest {
  const request: Record<string, unknown> = {
    server: { container: options.container },
    cookies: options.cookies ?? {},
  };
  if ('user' in options) {
    request['user'] = options.user;
  }
  return request as unknown as FastifyRequest;
}

const REPLY = {} as unknown as FastifyReply;

const MEMBER: SessionClaims = {
  sub: 'user-1',
  email: 'dev@acme.test',
  name: 'Dev',
  role: 'member',
  ver: 3,
  jti: 'jti-test',
};

const ADMIN: SessionClaims = { ...MEMBER, sub: 'admin-1', role: 'admin' };

function userRecord(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: 'user-1',
    email: 'dev@acme.test',
    name: 'Dev',
    role: 'member',
    isActive: true,
    tokenVersion: 3,
    passwordHash: 'x',
    ...overrides,
  };
}

function repositoryRecord(overrides: Partial<RepositoryRecord> = {}): RepositoryRecord {
  return {
    id: 'repo-1',
    githubId: '1234',
    fullName: 'acme/widget',
    installationId: 42,
    defaultBranch: 'main',
    isPrivate: true,
    settings: DEFAULT_REPOSITORY_SETTINGS,
    isActive: true,
    ...overrides,
  };
}

beforeEach(() => {
  db.getReviewRunDetail.mockReset();
  db.findRepositoryById.mockReset();
  db.findUserById.mockReset();
  db.getRepositoryAccessLevel.mockReset();
  db.listAccessibleRepositoryIds.mockReset();
  pipeline.executeReview.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('splitFullName', () => {
  it('splits owner and name at the first slash', () => {
    expect(splitFullName('acme/widget')).toEqual({ owner: 'acme', name: 'widget' });
  });

  it('AS-CODED: extra slashes are swallowed — only the first two segments survive', () => {
    expect(splitFullName('a/b/c')).toEqual({ owner: 'a', name: 'b' });
  });

  it('AS-CODED: no trimming or validation — whitespace and junk pass through', () => {
    expect(splitFullName(' acme /widget ')).toEqual({ owner: ' acme ', name: 'widget ' });
    expect(splitFullName('')).toEqual({ owner: '', name: '' });
    expect(splitFullName('solo')).toEqual({ owner: 'solo', name: '' });
    expect(splitFullName('/leading')).toEqual({ owner: '', name: 'leading' });
  });
});

describe('repositoryIdOfRun', () => {
  it('prefers the denormalized repositoryId', () => {
    expect(repositoryIdOfRun({ repositoryId: 'r-direct', repository: { id: 'r-nested' } })).toBe('r-direct');
  });

  it('falls back to the nested repository object', () => {
    expect(repositoryIdOfRun({ repository: { id: 'r-nested' } })).toBe('r-nested');
  });

  it('returns null for missing, non-string, or null-ish shapes', () => {
    expect(repositoryIdOfRun({})).toBeNull();
    expect(repositoryIdOfRun({ repositoryId: 7 })).toBeNull();
    expect(repositoryIdOfRun({ repository: null })).toBeNull();
    expect(repositoryIdOfRun({ repository: 'repo-1' })).toBeNull();
    expect(repositoryIdOfRun({ repository: { id: 9 } })).toBeNull();
  });
});

describe('pullRequestNumberOfRun', () => {
  it('extracts the PR number', () => {
    expect(pullRequestNumberOfRun({ pullRequest: { number: 77 } })).toBe(77);
  });

  it('returns null when the shape is off', () => {
    expect(pullRequestNumberOfRun({})).toBeNull();
    expect(pullRequestNumberOfRun({ pullRequest: null })).toBeNull();
    expect(pullRequestNumberOfRun({ pullRequest: { number: '77' } })).toBeNull();
    expect(pullRequestNumberOfRun({ pullRequest: {} })).toBeNull();
  });
});

describe('loadRunFor', () => {
  it('404s when the run does not exist', async () => {
    db.getReviewRunDetail.mockResolvedValueOnce(null);
    const container = fakeContainer();
    const request = fakeRequest({ container, user: ADMIN });
    const error = await loadRunFor(request, 'missing').catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).message).toBe('review run not found');
    expect(db.getReviewRunDetail).toHaveBeenCalledWith(container.prisma, 'missing');
  });

  it('500s when the run exists but has no repository id', async () => {
    db.getReviewRunDetail.mockResolvedValueOnce({ id: 'run-1' });
    const request = fakeRequest({ container: fakeContainer(), user: ADMIN });
    const error = await loadRunFor(request, 'run-1').catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('internal_error');
    expect((error as AppError).httpStatus).toBe(500);
  });

  it('returns the detail verbatim for admins without consulting the access table', async () => {
    const detail = { id: 'run-1', repositoryId: 'repo-1' };
    db.getReviewRunDetail.mockResolvedValueOnce(detail);
    const request = fakeRequest({ container: fakeContainer(), user: ADMIN });
    await expect(loadRunFor(request, 'run-1')).resolves.toBe(detail);
    expect(db.getRepositoryAccessLevel).not.toHaveBeenCalled();
  });

  it('lets a member through when the granted level covers what is needed', async () => {
    const detail = { id: 'run-1', repository: { id: 'repo-1' } };
    db.getReviewRunDetail.mockResolvedValueOnce(detail);
    db.getRepositoryAccessLevel.mockResolvedValueOnce('write');
    const container = fakeContainer();
    const request = fakeRequest({ container, user: MEMBER });
    await expect(loadRunFor(request, 'run-1', 'triage')).resolves.toBe(detail);
    expect(db.getRepositoryAccessLevel).toHaveBeenCalledWith(container.prisma, 'user-1', 'repo-1');
  });

  it('hides an under-privileged repository as a 404 (never 403)', async () => {
    db.getReviewRunDetail.mockResolvedValueOnce({ repositoryId: 'repo-secret' });
    db.getRepositoryAccessLevel.mockResolvedValueOnce('read');
    const request = fakeRequest({ container: fakeContainer(), user: MEMBER });
    const error = await loadRunFor(request, 'run-9', 'triage').catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).message).toBe('repository repo-secret not found');
  });

  it('404s identically when the member has no grant at all', async () => {
    db.getReviewRunDetail.mockResolvedValueOnce({ repositoryId: 'repo-x' });
    db.getRepositoryAccessLevel.mockResolvedValueOnce(null);
    const request = fakeRequest({ container: fakeContainer(), user: MEMBER });
    const error = await loadRunFor(request, 'run-x').catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).message).toBe('repository repo-x not found');
  });

  it('surfaces the guard 401 when the access check runs with no resolved user', async () => {
    db.getReviewRunDetail.mockResolvedValueOnce({ repositoryId: 'repo-1' });
    const request = fakeRequest({ container: fakeContainer(), user: null });
    const error = await loadRunFor(request, 'run-1').catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(UnauthorizedError);
  });

  it('AS-CODED: run existence is probed before authentication — an unknown run 404s even for a null user', async () => {
    db.getReviewRunDetail.mockResolvedValueOnce(null);
    const request = fakeRequest({ container: fakeContainer(), user: null });
    const error = await loadRunFor(request, 'ghost').catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).message).toBe('review run not found');
  });
});

describe('repositoryRefFor', () => {
  it('maps the record onto a RepositoryRef, renaming isPrivate to private', async () => {
    db.findRepositoryById.mockResolvedValueOnce(repositoryRecord());
    const container = fakeContainer();
    await expect(repositoryRefFor(asPrisma(container.prisma), 'repo-1')).resolves.toEqual({
      owner: 'acme',
      name: 'widget',
      fullName: 'acme/widget',
      installationId: 42,
      defaultBranch: 'main',
      private: true,
    });
  });

  it('returns null when the repository is gone', async () => {
    db.findRepositoryById.mockResolvedValueOnce(null);
    await expect(repositoryRefFor(asPrisma(fakeContainer().prisma), 'gone')).resolves.toBeNull();
  });

  it('AS-CODED: a malformed fullName leaks into the ref unvalidated', async () => {
    db.findRepositoryById.mockResolvedValueOnce(repositoryRecord({ fullName: 'broken' }));
    const ref = await repositoryRefFor(asPrisma(fakeContainer().prisma), 'repo-1');
    expect(ref).toMatchObject({ owner: 'broken', name: '', fullName: 'broken' });
  });
});

describe('runReviewDetached', () => {
  it('starts the review without waiting for it', async () => {
    let release: () => void = () => undefined;
    pipeline.executeReview.mockImplementationOnce(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );
    const container = fakeContainer();
    runReviewDetached(asContainer(container), 'run-1');
    expect(pipeline.executeReview).toHaveBeenCalledTimes(1);
    expect(pipeline.executeReview).toHaveBeenCalledWith(container, 'run-1');
    expect(container.logger.error).not.toHaveBeenCalled();
    release();
  });

  it('logs rejections with the run id and never rethrows', async () => {
    pipeline.executeReview.mockRejectedValueOnce(new Error('boom'));
    const container = fakeContainer();
    expect(() => runReviewDetached(asContainer(container), 'run-2')).not.toThrow();
    await vi.waitFor(() => {
      expect(container.logger.error).toHaveBeenCalledWith(
        { reviewRunId: 'run-2', error: 'boom' },
        'detached review failed',
      );
    });
  });

  it('stringifies non-Error rejections', async () => {
    pipeline.executeReview.mockImplementationOnce(async () => {
      throw 'kaboom';
    });
    const container = fakeContainer();
    runReviewDetached(asContainer(container), 'run-3');
    await vi.waitFor(() => {
      expect(container.logger.error).toHaveBeenCalledWith(
        { reviewRunId: 'run-3', error: 'kaboom' },
        'detached review failed',
      );
    });
  });

  it('stays silent on success', async () => {
    const container = fakeContainer();
    runReviewDetached(asContainer(container), 'run-4');
    await Promise.resolve();
    await Promise.resolve();
    expect(container.logger.error).not.toHaveBeenCalled();
  });

  it('AS-CODED: there is no queue branch here — the queue-vs-inline choice lives in the pipeline enqueue helpers', () => {
    // This pins the as-coded contract: runReviewDetached ALWAYS executes the
    // review in-process regardless of container.queue being present or absent.
    const container = fakeContainer();
    runReviewDetached(asContainer(container), 'run-5');
    expect(pipeline.executeReview).toHaveBeenCalledWith(container, 'run-5');
  });
});

describe('claimsOf', () => {
  it('returns the resolved user', () => {
    const request = fakeRequest({ container: fakeContainer(), user: MEMBER });
    expect(claimsOf(request)).toBe(MEMBER);
  });

  it('401s for null or absent user', () => {
    expect(() => claimsOf(fakeRequest({ container: fakeContainer(), user: null }))).toThrow(UnauthorizedError);
    expect(() => claimsOf(fakeRequest({ container: fakeContainer() }))).toThrow('Authentication required');
  });
});

describe('resolveSession', () => {
  async function validToken(): Promise<string> {
    const { token } = await signSession(
      { id: 'user-1', email: MEMBER.email, name: MEMBER.name, role: 'member', tokenVersion: 3 },
      CONFIG,
    );
    return token;
  }

  it('returns null when the cookie is missing or empty', async () => {
    const container = fakeContainer();
    await expect(resolveSession(fakeRequest({ container }), asContainer(container))).resolves.toBeNull();
    await expect(
      resolveSession(fakeRequest({ container, cookies: { acr_session: '' } }), asContainer(container)),
    ).resolves.toBeNull();
    expect(db.findUserById).not.toHaveBeenCalled();
  });

  it('returns null for a garbage cookie instead of throwing', async () => {
    const container = fakeContainer();
    const request = fakeRequest({ container, cookies: { acr_session: 'not.a.jwt' } });
    await expect(resolveSession(request, asContainer(container))).resolves.toBeNull();
    expect(db.findUserById).not.toHaveBeenCalled();
  });

  it('returns claims when the token and the database user agree', async () => {
    db.findUserById.mockResolvedValueOnce(userRecord());
    const container = fakeContainer();
    const request = fakeRequest({ container, cookies: { [CONFIG.auth.cookieName]: await validToken() } });
    const claims = await resolveSession(request, asContainer(container));
    expect(claims).toMatchObject({ sub: 'user-1', role: 'member', ver: 3 });
    expect(db.findUserById).toHaveBeenCalledWith(container.prisma, 'user-1');
  });

  it('returns null when the user was deactivated', async () => {
    db.findUserById.mockResolvedValueOnce(userRecord({ isActive: false }));
    const container = fakeContainer();
    const request = fakeRequest({ container, cookies: { [CONFIG.auth.cookieName]: await validToken() } });
    await expect(resolveSession(request, asContainer(container))).resolves.toBeNull();
  });

  it('returns null when the token version no longer matches (revoked sessions)', async () => {
    db.findUserById.mockResolvedValueOnce(userRecord({ tokenVersion: 4 }));
    const container = fakeContainer();
    const request = fakeRequest({ container, cookies: { [CONFIG.auth.cookieName]: await validToken() } });
    await expect(resolveSession(request, asContainer(container))).resolves.toBeNull();
  });

  it('returns null when the user row disappeared', async () => {
    db.findUserById.mockResolvedValueOnce(null);
    const container = fakeContainer();
    const request = fakeRequest({ container, cookies: { [CONFIG.auth.cookieName]: await validToken() } });
    await expect(resolveSession(request, asContainer(container))).resolves.toBeNull();
  });
});

describe('session hooks', () => {
  it('requireSession attaches claims to the request', async () => {
    db.findUserById.mockResolvedValueOnce(userRecord());
    const { token } = await signSession(
      { id: 'user-1', email: MEMBER.email, name: MEMBER.name, role: 'member', tokenVersion: 3 },
      CONFIG,
    );
    const request = fakeRequest({ container: fakeContainer(), cookies: { acr_session: token } });
    await expect(requireSession(request, REPLY)).resolves.toBeUndefined();
    expect(request.user).toMatchObject({ sub: 'user-1' });
  });

  it('requireSession throws 401 when nothing resolves', async () => {
    const request = fakeRequest({ container: fakeContainer() });
    await expect(requireSession(request, REPLY)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(request.user).toBeUndefined();
  });

  it('optionalSession sets user to null for anonymous callers', async () => {
    const request = fakeRequest({ container: fakeContainer() });
    await expect(optionalSession(request, REPLY)).resolves.toBeUndefined();
    expect(request.user).toBeNull();
  });

  it('optionalSession keeps a cookie-less request off the database', async () => {
    const request = fakeRequest({ container: fakeContainer() });
    await optionalSession(request, REPLY);
    expect(db.findUserById).not.toHaveBeenCalled();
  });
});

describe('requireAdmin / isAdmin', () => {
  it('requireAdmin passes admins through', async () => {
    const request = fakeRequest({ container: fakeContainer(), user: ADMIN });
    await expect(requireAdmin(request, REPLY)).resolves.toBeUndefined();
  });

  it('requireAdmin 403s members', async () => {
    const request = fakeRequest({ container: fakeContainer(), user: MEMBER });
    const error = await requireAdmin(request, REPLY).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as ForbiddenError).httpStatus).toBe(403);
  });

  it('requireAdmin 401s (not 403s) when no session was resolved', async () => {
    const request = fakeRequest({ container: fakeContainer() });
    await expect(requireAdmin(request, REPLY)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('isAdmin is a total predicate over the resolved user', () => {
    expect(isAdmin(fakeRequest({ container: fakeContainer(), user: ADMIN }))).toBe(true);
    expect(isAdmin(fakeRequest({ container: fakeContainer(), user: MEMBER }))).toBe(false);
    expect(isAdmin(fakeRequest({ container: fakeContainer() }))).toBe(false);
  });
});

describe('accessibleRepositoryIds', () => {
  it('admins see everything without a query', async () => {
    const request = fakeRequest({ container: fakeContainer(), user: ADMIN });
    await expect(accessibleRepositoryIds(request)).resolves.toBe('all');
    expect(db.listAccessibleRepositoryIds).not.toHaveBeenCalled();
  });

  it('members get exactly their grants', async () => {
    db.listAccessibleRepositoryIds.mockResolvedValueOnce(['repo-a', 'repo-b']);
    const container = fakeContainer();
    const request = fakeRequest({ container, user: MEMBER });
    await expect(accessibleRepositoryIds(request)).resolves.toEqual(['repo-a', 'repo-b']);
    expect(db.listAccessibleRepositoryIds).toHaveBeenCalledWith(container.prisma, 'user-1');
  });
});

describe('assertRepositoryAccess rank table', () => {
  it('admin short-circuits before any lookup', async () => {
    const request = fakeRequest({ container: fakeContainer(), user: ADMIN });
    await expect(assertRepositoryAccess(request, 'repo-1', 'admin')).resolves.toBeUndefined();
    expect(db.getRepositoryAccessLevel).not.toHaveBeenCalled();
  });

  it.each([
    ['read', 'read', true],
    ['read', 'triage', false],
    ['triage', 'read', true],
    ['write', 'triage', true],
    ['maintain', 'admin', false],
    ['admin', 'admin', true],
  ] as const)('granted %s vs needed %s -> %s', async (granted, needed, allowed) => {
    db.getRepositoryAccessLevel.mockResolvedValueOnce(granted);
    const request = fakeRequest({ container: fakeContainer(), user: MEMBER });
    const outcome = await assertRepositoryAccess(request, 'repo-1', needed).then(
      () => 'ok' as const,
      (thrown: unknown) => thrown,
    );
    if (allowed) {
      expect(outcome).toBe('ok');
    } else {
      expect(outcome).toBeInstanceOf(NotFoundError);
    }
  });
});
