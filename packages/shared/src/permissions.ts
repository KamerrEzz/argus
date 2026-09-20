import { PermissionDeniedError } from './errors';

export const PERMISSIONS = [
  'repository:read',
  'pull_request:read',
  'pull_request:write',
  'checks:write',
  'comments:write',
  'code_execution:execute',
  'review:publish',
  'repository:configure',
  'review:approve',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export type PermissionSet = ReadonlySet<Permission>;

export type PrincipalType = 'user' | 'agent' | 'system';

export interface Principal {
  readonly type: PrincipalType;
  readonly id: string;
  readonly permissions: PermissionSet;
}

export const REPOSITORY_PERMISSION_LEVELS = ['read', 'triage', 'write', 'maintain', 'admin'] as const;
export type RepositoryPermissionLevel = (typeof REPOSITORY_PERMISSION_LEVELS)[number];

const READ_ONLY: readonly Permission[] = ['repository:read', 'pull_request:read'];

const LEVEL_PERMISSIONS: Record<RepositoryPermissionLevel, readonly Permission[]> = {
  read: READ_ONLY,
  triage: [...READ_ONLY, 'comments:write'],
  write: [...READ_ONLY, 'comments:write', 'pull_request:write', 'checks:write'],
  maintain: [...READ_ONLY, 'comments:write', 'pull_request:write', 'checks:write', 'review:publish'],
  admin: [...PERMISSIONS],
};

export const AGENT_BASE_PERMISSIONS: readonly Permission[] = [
  'repository:read',
  'pull_request:read',
  'comments:write',
  'checks:write',
  'code_execution:execute',
  'review:publish',
];

export const FULL_PERMISSION_SET: PermissionSet = new Set<Permission>(PERMISSIONS);

export function permissionSetOf(permissions: readonly Permission[]): PermissionSet {
  return new Set<Permission>(permissions);
}

export function permissionsForLevel(level: RepositoryPermissionLevel): PermissionSet {
  return permissionSetOf(LEVEL_PERMISSIONS[level]);
}

export function intersectPermissions(left: PermissionSet, right: PermissionSet): PermissionSet {
  const output = new Set<Permission>();
  for (const permission of left) {
    if (right.has(permission)) {
      output.add(permission);
    }
  }
  return output;
}

export function agentPermissions(options: {
  granted?: readonly Permission[];
  denied?: readonly Permission[];
} = {}): PermissionSet {
  const base = options.granted ?? AGENT_BASE_PERMISSIONS;
  const output = new Set<Permission>(base);
  for (const permission of options.denied ?? []) {
    output.delete(permission);
  }
  return output;
}

export function hasPermission(principal: Principal, permission: Permission): boolean {
  return principal.permissions.has(permission);
}

export function hasAllPermissions(principal: Principal, permissions: readonly Permission[]): boolean {
  return permissions.every((permission) => principal.permissions.has(permission));
}

export function missingPermissions(principal: Principal, permissions: readonly Permission[]): Permission[] {
  return permissions.filter((permission) => !principal.permissions.has(permission));
}

export function isRepositoryPermissionLevel(value: string): value is RepositoryPermissionLevel {
  return (REPOSITORY_PERMISSION_LEVELS as readonly string[]).includes(value);
}

export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly missing: readonly Permission[];
}

export function authorize(principal: Principal, permissions: readonly Permission[]): AuthorizationDecision {
  const missing = missingPermissions(principal, permissions);
  return { allowed: missing.length === 0, missing };
}

export function assertPermission(
  principal: Principal,
  permission: Permission,
  context: Record<string, unknown> = {},
): void {
  if (!hasPermission(principal, permission)) {
    throw new PermissionDeniedError(permission, {
      principalId: principal.id,
      principalType: principal.type,
      ...context,
    });
  }
}

export function assertPermissions(
  principal: Principal,
  permissions: readonly Permission[],
  context: Record<string, unknown> = {},
): void {
  const decision = authorize(principal, permissions);
  if (!decision.allowed) {
    throw new PermissionDeniedError(decision.missing.join(','), {
      principalId: principal.id,
      principalType: principal.type,
      ...context,
    });
  }
}
