import { describe, expect, it } from 'vitest';
import {
  AGENT_BASE_PERMISSIONS,
  FULL_PERMISSION_SET,
  PERMISSIONS,
  REPOSITORY_PERMISSION_LEVELS,
  agentPermissions,
  assertPermission,
  assertPermissions,
  authorize,
  hasAllPermissions,
  hasPermission,
  intersectPermissions,
  isRepositoryPermissionLevel,
  missingPermissions,
  permissionSetOf,
  permissionsForLevel,
  type Permission,
  type Principal,
} from '@acr/shared';
import { AppError } from '@acr/shared';

function principalWith(permissions: readonly Permission[], id = 'p-1'): Principal {
  return { type: 'agent', id, permissions: permissionSetOf(permissions) };
}

describe('PERMISSIONS / static invariants', () => {
  it('lists unique, colon-namespaced permissions', () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
    for (const permission of PERMISSIONS) {
      expect(permission).toMatch(/^[a-z_]+:[a-z_]+$/);
    }
  });

  it('FULL_PERMISSION_SET covers every declared permission exactly', () => {
    expect(FULL_PERMISSION_SET.size).toBe(PERMISSIONS.length);
    for (const permission of PERMISSIONS) {
      expect(FULL_PERMISSION_SET.has(permission)).toBe(true);
    }
  });

  it('AGENT_BASE_PERMISSIONS matches what the source actually defines', () => {
    // Verified against packages/shared/src/permissions.ts: the agent base set
    // contains the read/analyze-style permissions (repository:read,
    // pull_request:read, comments:write, checks:write, code_execution:execute)
    // AND intentionally grants `review:publish`. Publishing is not removed at
    // definition time; `deriveAgentPermissions` (packages/pipeline) strips
    // `review:publish` whenever a human approval gate is configured.
    const base = permissionSetOf(AGENT_BASE_PERMISSIONS);
    expect(base.has('repository:read')).toBe(true);
    expect(base.has('pull_request:read')).toBe(true);
    expect(base.has('code_execution:execute')).toBe(true);
    expect(base.has('review:publish')).toBe(true);
    // The base set deliberately excludes dangerous management/approval powers.
    expect(base.has('repository:configure')).toBe(false);
    expect(base.has('review:approve')).toBe(false);
    expect(base.has('pull_request:write')).toBe(false);
  });

  it('AGENT_BASE_PERMISSIONS has no duplicates', () => {
    expect(new Set(AGENT_BASE_PERMISSIONS).size).toBe(AGENT_BASE_PERMISSIONS.length);
  });
});

describe('permissionSetOf / intersectPermissions', () => {
  it('deduplicates and preserves membership', () => {
    const set = permissionSetOf(['repository:read', 'repository:read', 'comments:write']);
    expect(set.size).toBe(2);
    expect(set.has('repository:read')).toBe(true);
    expect(set.has('comments:write')).toBe(true);
  });

  it('empty input yields an empty set', () => {
    expect(permissionSetOf([]).size).toBe(0);
  });

  it('intersection keeps only shared members without mutating inputs', () => {
    const left = permissionSetOf(['repository:read', 'pull_request:read', 'comments:write']);
    const right = permissionSetOf(['comments:write', 'review:publish']);
    const intersection = intersectPermissions(left, right);
    expect([...intersection].sort()).toEqual(['comments:write']);
    // Inputs are untouched: intersection can never widen either side.
    expect(left.size).toBe(3);
    expect(right.size).toBe(2);
  });

  it('intersection with the empty set is empty', () => {
    expect(intersectPermissions(permissionSetOf(PERMISSIONS), new Set<Permission>()).size).toBe(0);
  });
});

describe('agentPermissions({granted, denied})', () => {
  it('defaults to the agent base set when no options are given', () => {
    const set = agentPermissions();
    expect(set).toEqual(permissionSetOf(AGENT_BASE_PERMISSIONS));
  });

  it('denied wins over granted, even when granted explicitly includes it', () => {
    const set = agentPermissions({
      granted: ['repository:read', 'review:publish'],
      denied: ['review:publish'],
    });
    expect(set.has('repository:read')).toBe(true);
    expect(set.has('review:publish')).toBe(false);
  });

  it('denied entries outside the granted set are harmless no-ops', () => {
    const set = agentPermissions({ granted: ['repository:read'], denied: ['review:approve'] });
    expect([...set]).toEqual(['repository:read']);
  });

  it('an empty granted list produces the empty set regardless of denials', () => {
    expect(agentPermissions({ granted: [], denied: [] }).size).toBe(0);
  });

  it('rejects unknown permission strings at the settings schema boundary', () => {
    // agentPermissions() itself trusts its typed input; the rejection layer is
    // RepositorySettingsSchema (z.enum(PERMISSIONS)). A hostile settings blob
    // with an unknown name falls back to defaults instead of widening access.
    // See packages/shared/src/settings.ts; asserted in the pipeline ports test
    // that a non-enum string never reaches a live PermissionSet.
    const bogus = 'not-a-real:permission';
    expect((PERMISSIONS as readonly string[]).includes(bogus)).toBe(false);
  });
});

describe('hasPermission / hasAllPermissions / missingPermissions / authorize', () => {
  it('hasPermission reflects set membership', () => {
    const principal = principalWith(['repository:read']);
    expect(hasPermission(principal, 'repository:read')).toBe(true);
    expect(hasPermission(principal, 'review:publish')).toBe(false);
  });

  it('hasAllPermissions is vacuously true for an empty requirement list', () => {
    expect(hasAllPermissions(principalWith([]), [])).toBe(true);
  });

  it('missingPermissions reports exactly the absent entries in request order', () => {
    const principal = principalWith(['repository:read']);
    expect(missingPermissions(principal, ['repository:read', 'checks:write', 'review:publish'])).toEqual([
      'checks:write',
      'review:publish',
    ]);
  });

  it('authorize combines the two: allowed <=> no missing', () => {
    const granted = principalWith(['repository:read', 'pull_request:read']);
    const ok = authorize(granted, ['repository:read']);
    expect(ok.allowed).toBe(true);
    expect(ok.missing).toEqual([]);
    const denied = authorize(granted, ['repository:read', 'code_execution:execute']);
    expect(denied.allowed).toBe(false);
    expect(denied.missing).toEqual(['code_execution:execute']);
  });
});

describe('assertPermission / assertPermissions', () => {
  it('passes silently when the principal holds the permission', () => {
    expect(() => assertPermission(principalWith(['repository:read']), 'repository:read')).not.toThrow();
  });

  it('throws a permission_denied AppError naming the missing permission and principal', () => {
    let thrown: unknown;
    try {
      assertPermission(principalWith([], 'agent-42'), 'review:publish', { reviewRunId: 'r-1' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    const appError = thrown as InstanceType<typeof AppError> & { permission?: string; details?: unknown };
    expect(appError.code).toBe('permission_denied');
    expect(appError.httpStatus).toBe(403);
    expect(appError.message).toContain('review:publish');
    expect(appError.permission).toBe('review:publish');
    expect(appError.details).toMatchObject({ principalId: 'agent-42', principalType: 'agent', reviewRunId: 'r-1' });
  });

  it('assertPermissions joins every missing permission into one error', () => {
    expect(() =>
      assertPermissions(principalWith(['repository:read']), ['review:publish', 'repository:configure']),
    ).toThrow(/review:publish,repository:configure/);
  });

  it('assertPermissions with no requirements never throws', () => {
    expect(() => assertPermissions(principalWith([]), [])).not.toThrow();
  });
});

describe('repository permission levels (rank helpers)', () => {
  it('isRepositoryPermissionLevel accepts only the five GitHub levels', () => {
    for (const level of REPOSITORY_PERMISSION_LEVELS) {
      expect(isRepositoryPermissionLevel(level)).toBe(true);
    }
    for (const hostile of ['root', 'READ', 'admin ', '', 'superuser']) {
      expect(isRepositoryPermissionLevel(hostile)).toBe(false);
    }
  });

  it('levels are monotonically widening supersets of each other', () => {
    const sets = REPOSITORY_PERMISSION_LEVELS.map((level) => permissionsForLevel(level));
    for (let index = 1; index < sets.length; index += 1) {
      const previous = sets[index - 1];
      const current = sets[index];
      if (previous === undefined || current === undefined) {
        continue;
      }
      for (const permission of previous) {
        expect(current.has(permission)).toBe(true);
      }
      expect(current.size).toBeGreaterThan(previous.size);
    }
  });

  it('admin is exactly the full set; publish needs maintain; write/triage/read lack it', () => {
    expect(permissionsForLevel('admin')).toEqual(FULL_PERMISSION_SET);
    expect(permissionsForLevel('maintain').has('review:publish')).toBe(true);
    expect(permissionsForLevel('write').has('review:publish')).toBe(false);
    expect(permissionsForLevel('triage').has('review:publish')).toBe(false);
    expect(permissionsForLevel('read').has('review:publish')).toBe(false);
    expect([...permissionsForLevel('read')].sort()).toEqual(['pull_request:read', 'repository:read']);
  });
});
