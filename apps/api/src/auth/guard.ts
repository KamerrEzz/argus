import type { ApplicationContainer } from '@acr/pipeline';
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  type RepositoryPermissionLevel,
} from '@acr/shared';
import { findUserById, getRepositoryAccessLevel, listAccessibleRepositoryIds } from '@acr/database';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifySession, type SessionClaims } from './session';

declare module 'fastify' {
  interface FastifyRequest {
    /** Absent until a guard has resolved it, so a route can never be "half authenticated". */
    user?: SessionClaims | null;
    /** Exact bytes of a JSON body, kept for webhook signature verification. */
    rawBody?: Buffer;
  }
  interface FastifyInstance {
    container: ApplicationContainer;
  }
}

export function claimsOf(request: FastifyRequest): SessionClaims {
  if (request.user === null || request.user === undefined) {
    throw new UnauthorizedError('Authentication required');
  }
  return request.user;
}

/** Reads the cookie, verifies it and checks the user is still valid in the database. */
export async function resolveSession(
  request: FastifyRequest,
  container: ApplicationContainer,
): Promise<SessionClaims | null> {
  const token = request.cookies?.[container.config.auth.cookieName];
  if (typeof token !== 'string' || token.length === 0) {
    return null;
  }
  let claims: SessionClaims;
  try {
    claims = await verifySession(token, container.config);
  } catch {
    return null;
  }

  const user = await findUserById(container.prisma, claims.sub);
  if (user === null || !user.isActive || user.tokenVersion !== claims.ver) {
    return null;
  }
  return claims;
}

export async function requireSession(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const container = request.server.container;
  const claims = await resolveSession(request, container);
  if (claims === null) {
    throw new UnauthorizedError('Authentication required');
  }
  request.user = claims;
}

export async function optionalSession(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  request.user = await resolveSession(request, request.server.container);
}

/**
 * Async on purpose: Fastify inspects a hook's arity, and a synchronous two-argument
 * hook is never resumed — the request hangs instead of answering 403.
 */
export async function requireAdmin(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (claimsOf(request).role !== 'admin') {
    throw new ForbiddenError('Administrator role required');
  }
}

export function isAdmin(request: FastifyRequest): boolean {
  return request.user?.role === 'admin';
}

/** Admins see everything; members only see repositories they were granted. */
export async function accessibleRepositoryIds(
  request: FastifyRequest,
): Promise<readonly string[] | 'all'> {
  const claims = claimsOf(request);
  const container = request.server.container;
  if (claims.role === 'admin') {
    return 'all';
  }
  return listAccessibleRepositoryIds(container.prisma, claims.sub);
}

/**
 * A repository id that the caller may not touch is reported as "not found":
 * existence itself is information.
 */
export async function assertRepositoryAccess(
  request: FastifyRequest,
  repositoryId: string,
  needed: RepositoryPermissionLevel,
): Promise<void> {
  const claims = claimsOf(request);
  const container = request.server.container;
  if (claims.role === 'admin') {
    return;
  }
  const level = await getRepositoryAccessLevel(container.prisma, claims.sub, repositoryId);
  const rank: Readonly<Record<RepositoryPermissionLevel, number>> = {
    read: 0,
    triage: 1,
    write: 2,
    maintain: 3,
    admin: 4,
  };
  if (level === null || rank[level] < rank[needed]) {
    throw new NotFoundError(`repository ${repositoryId}`);
  }
}
