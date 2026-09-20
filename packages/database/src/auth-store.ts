import bcrypt from 'bcryptjs';
import type { PrismaClient } from '@prisma/client';
import {
  isRepositoryPermissionLevel,
  type RepositoryPermissionLevel,
} from '@acr/shared';
import { fromDbRepositoryPermission, fromDbUserRole } from './mappers';

export const PASSWORD_HASH_ROUNDS = 12;

export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: 'admin' | 'member';
  readonly isActive: boolean;
  readonly tokenVersion: number;
  readonly passwordHash: string;
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, PASSWORD_HASH_ROUNDS);
}

export function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(password, passwordHash);
}

function toUserRecord(row: {
  id: string;
  email: string;
  name: string;
  role: 'ADMIN' | 'MEMBER';
  isActive: boolean;
  tokenVersion: number;
  passwordHash: string;
}): UserRecord {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: fromDbUserRole(row.role),
    isActive: row.isActive,
    tokenVersion: row.tokenVersion,
    passwordHash: row.passwordHash,
  };
}

export async function findUserByEmail(
  prisma: PrismaClient,
  email: string,
): Promise<UserRecord | null> {
  const row = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  return row === null ? null : toUserRecord(row);
}

export async function findUserById(prisma: PrismaClient, id: string): Promise<UserRecord | null> {
  const row = await prisma.user.findUnique({ where: { id } });
  return row === null ? null : toUserRecord(row);
}

export async function countUsers(prisma: PrismaClient): Promise<number> {
  return prisma.user.count();
}

export interface UserSummary {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: 'admin' | 'member';
  readonly isActive: boolean;
  readonly createdAt: string;
  readonly lastLoginAt: string | null;
}

/** Never leaks the password hash: this is the shape the API returns. */
export async function listUsers(prisma: PrismaClient, take = 100): Promise<readonly UserSummary[]> {
  const rows = await prisma.user.findMany({ orderBy: { createdAt: 'asc' }, take });
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role === 'ADMIN' ? ('admin' as const) : ('member' as const),
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    lastLoginAt: row.lastLoginAt === null ? null : row.lastLoginAt.toISOString(),
  }));
}

export async function authenticateUser(
  prisma: PrismaClient,
  email: string,
  password: string,
): Promise<UserRecord | null> {
  const user = await findUserByEmail(prisma, email);
  if (user === null || !user.isActive) {
    return null;
  }
  const valid = await verifyPassword(password, user.passwordHash);
  return valid ? user : null;
}

export interface CreateUserInput {
  readonly email: string;
  readonly name: string;
  readonly password: string;
  readonly role?: 'admin' | 'member';
}

export async function createUser(prisma: PrismaClient, input: CreateUserInput): Promise<UserRecord> {
  const passwordHash = await hashPassword(input.password);
  const row = await prisma.user.upsert({
    where: { email: input.email.trim().toLowerCase() },
    update: { name: input.name, passwordHash, role: input.role === 'admin' ? 'ADMIN' : 'MEMBER' },
    create: {
      email: input.email.trim().toLowerCase(),
      name: input.name,
      passwordHash,
      role: input.role === 'admin' ? 'ADMIN' : 'MEMBER',
    },
  });
  return toUserRecord(row);
}

export async function ensureBootstrapAdmin(
  prisma: PrismaClient,
  input: { email: string; password: string; name: string },
): Promise<UserRecord> {
  return createUser(prisma, {
    email: input.email,
    name: input.name,
    password: input.password,
    role: 'admin',
  });
}

export async function recordUserLogin(prisma: PrismaClient, userId: string): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
}

export async function bumpUserTokenVersion(prisma: PrismaClient, userId: string): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } });
}

export async function getRepositoryAccessLevel(
  prisma: PrismaClient,
  userId: string,
  repositoryId: string,
): Promise<RepositoryPermissionLevel | null> {
  const access = await prisma.repositoryAccess.findUnique({
    where: { userId_repositoryId: { userId, repositoryId } },
    select: { permission: true },
  });
  if (access === null) {
    return null;
  }
  const level = fromDbRepositoryPermission(access.permission);
  return isRepositoryPermissionLevel(level) ? level : null;
}

export async function listAccessibleRepositoryIds(
  prisma: PrismaClient,
  userId: string,
): Promise<string[]> {
  const rows = await prisma.repositoryAccess.findMany({
    where: { userId },
    select: { repositoryId: true },
  });
  return rows.map((row) => row.repositoryId);
}

export async function grantRepositoryAccess(
  prisma: PrismaClient,
  input: {
    readonly userId: string;
    readonly repositoryId: string;
    readonly level: RepositoryPermissionLevel;
    readonly grantedById?: string | null;
  },
): Promise<void> {
  const permission =
    input.level === 'admin'
      ? 'ADMIN'
      : input.level === 'maintain'
        ? 'MAINTAIN'
        : input.level === 'write'
          ? 'WRITE'
          : input.level === 'triage'
            ? 'TRIAGE'
            : 'READ';
  await prisma.repositoryAccess.upsert({
    where: { userId_repositoryId: { userId: input.userId, repositoryId: input.repositoryId } },
    update: { permission, grantedById: input.grantedById ?? null },
    create: {
      userId: input.userId,
      repositoryId: input.repositoryId,
      permission,
      grantedById: input.grantedById ?? null,
    },
  });
}

export async function revokeRepositoryAccess(
  prisma: PrismaClient,
  userId: string,
  repositoryId: string,
): Promise<void> {
  await prisma.repositoryAccess.deleteMany({ where: { userId, repositoryId } });
}
