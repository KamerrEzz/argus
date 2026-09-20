import { AppError, UnauthorizedError } from '@acr/shared';
import {
  authenticateUser,
  bumpUserTokenVersion,
  createUser,
  findUserByEmail,
  findUserById,
  listUsers,
  recordUserLogin,
} from '@acr/database';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { claimsOf, requireAdmin, requireSession } from '../auth/guard';
import { sessionCookieOptions, signSession } from '../auth/session';
import { parseOrThrow } from '../errors';

const LoginSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
});

const CreateUserSchema = z.object({
  email: z.string().email().max(200),
  name: z.string().min(1).max(120),
  // A local account protects a real deployment, so weak passwords are refused.
  password: z.string().min(12).max(200),
  role: z.enum(['admin', 'member']).default('member'),
});

export const AccessSchema = z.object({
  userId: z.string().min(1).max(64),
  permission: z.enum(['read', 'triage', 'write', 'maintain', 'admin']),
});

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = parseOrThrow(LoginSchema, request.body, 'login');
      const container = app.container;
      const user = await authenticateUser(container.prisma, body.email, body.password);
      if (user === null) {
        // One answer for an unknown email and a wrong password: no user enumeration.
        throw new UnauthorizedError('Invalid email or password');
      }

      const { token, maxAgeSeconds } = await signSession(user, container.config);
      reply.setCookie(
        container.config.auth.cookieName,
        token,
        sessionCookieOptions(container.config, maxAgeSeconds),
      );
      await recordUserLogin(container.prisma, user.id);

      return { user: { id: user.id, email: user.email, name: user.name, role: user.role } };
    },
  );

  app.post('/auth/logout', async (_request, reply) => {
    reply.clearCookie(app.container.config.auth.cookieName, { path: '/' });
    return { status: 'logged_out' };
  });

  app.get('/auth/me', { preHandler: [requireSession] }, async (request) => {
    const claims = claimsOf(request);
    const fresh = await findUserById(app.container.prisma, claims.sub);
    if (fresh === null) {
      throw new UnauthorizedError('Account no longer exists');
    }
    return { user: { id: fresh.id, email: fresh.email, name: fresh.name, role: fresh.role } };
  });

  app.get('/auth/users', { preHandler: [requireSession, requireAdmin] }, async () => ({
    users: await listUsers(app.container.prisma),
  }));

  app.post(
    '/auth/users',
    { preHandler: [requireSession, requireAdmin] },
    async (request, reply) => {
      const body = parseOrThrow(CreateUserSchema, request.body, 'user');
      const existing = await findUserByEmail(app.container.prisma, body.email);
      if (existing !== null) {
        throw new AppError('a user with that email already exists', { code: 'conflict' });
      }
      const created = await createUser(app.container.prisma, body);
      reply.status(201);
      return { user: { id: created.id, email: created.email, name: created.name, role: created.role } };
    },
  );

  /** Kills every session the user holds, e.g. after a suspected credential leak. */
  app.post(
    '/auth/users/:userId/revoke-sessions',
    { preHandler: [requireSession, requireAdmin] },
    async (request) => {
      const params = parseOrThrow(z.object({ userId: z.string().min(1).max(64) }), request.params, 'params');
      const target = await findUserById(app.container.prisma, params.userId);
      if (target === null) {
        throw new AppError('user not found', { code: 'not_found' });
      }
      await bumpUserTokenVersion(app.container.prisma, params.userId);
      return { status: 'revoked', userId: params.userId };
    },
  );
}
