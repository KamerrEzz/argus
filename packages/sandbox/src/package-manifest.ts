import { ValidationError, type RepoWorkspace } from '@acr/shared';

export type PackageManagerId = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'unknown';

export interface PackageManifest {
  readonly name: string | null;
  readonly packageManager: PackageManagerId;
  readonly scripts: Readonly<Record<string, string>>;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly engines: Readonly<Record<string, string>>;
  readonly workspaces: readonly string[];
}

export interface AvailableScripts {
  readonly test: boolean;
  readonly lint: boolean;
  readonly typecheck: boolean;
  readonly build: boolean;
}

const TEST_ALIASES = ['test', 'tests', 'test:unit', 'test:ci'];
const LINT_ALIASES = ['lint', 'eslint', 'lint:ci'];
const TYPECHECK_ALIASES = ['typecheck', 'type-check', 'tsc', 'check:types'];
const BUILD_ALIASES = ['build', 'compile'];

const LOCKFILE_MANAGERS: ReadonlyArray<{ readonly file: string; readonly manager: PackageManagerId }> = [
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'yarn.lock', manager: 'yarn' },
  { file: 'bun.lockb', manager: 'bun' },
  { file: 'package-lock.json', manager: 'npm' },
];

function asStringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      output[key] = entry;
    }
  }
  return output;
}

export function detectPackageManager(
  manifest: unknown,
  files: readonly string[],
  declared: unknown,
): PackageManagerId {
  if (typeof declared === 'string' && declared.length > 0) {
    const name = declared.split('@')[0] ?? '';
    if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') {
      return name;
    }
  }
  for (const entry of LOCKFILE_MANAGERS) {
    if (files.includes(entry.file)) {
      return entry.manager;
    }
  }
  if (typeof manifest === 'object' && manifest !== null && 'name' in manifest) {
    return 'npm';
  }
  return 'unknown';
}

export async function readPackageManifest(
  workspace: RepoWorkspace,
  files?: readonly string[],
): Promise<PackageManifest | null> {
  const raw = await workspace.readFile('package.json').catch(() => null);
  if (raw === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationError('Repository package.json is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ValidationError('Repository package.json is not an object');
  }
  const record = parsed as Record<string, unknown>;
  const fileList = files ?? (await workspace.fileList());
  const workspacesRaw = record['workspaces'];

  return {
    name: typeof record['name'] === 'string' ? record['name'] : null,
    packageManager: detectPackageManager(record, fileList, record['packageManager']),
    scripts: asStringRecord(record['scripts']),
    dependencies: asStringRecord(record['dependencies']),
    devDependencies: asStringRecord(record['devDependencies']),
    engines: asStringRecord(record['engines']),
    workspaces: Array.isArray(workspacesRaw)
      ? workspacesRaw.filter((entry): entry is string => typeof entry === 'string')
      : [],
  };
}

function pickScript(
  scripts: Readonly<Record<string, string>>,
  aliases: readonly string[],
): string | null {
  for (const alias of aliases) {
    const value = scripts[alias];
    if (typeof value === 'string' && value.trim().length > 0) {
      return alias;
    }
  }
  return null;
}

export function availableScripts(manifest: PackageManifest | null): AvailableScripts {
  if (manifest === null) {
    return { test: false, lint: false, typecheck: false, build: false };
  }
  return {
    test: pickScript(manifest.scripts, TEST_ALIASES) !== null,
    lint: pickScript(manifest.scripts, LINT_ALIASES) !== null,
    typecheck: pickScript(manifest.scripts, TYPECHECK_ALIASES) !== null,
    build: pickScript(manifest.scripts, BUILD_ALIASES) !== null,
  };
}

export function resolveScriptName(
  manifest: PackageManifest | null,
  kind: 'test' | 'lint' | 'typecheck' | 'build',
): string | null {
  if (manifest === null) {
    return null;
  }
  const aliases =
    kind === 'test'
      ? TEST_ALIASES
      : kind === 'lint'
        ? LINT_ALIASES
        : kind === 'typecheck'
          ? TYPECHECK_ALIASES
          : BUILD_ALIASES;
  return pickScript(manifest.scripts, aliases);
}

export function describeDependencySummary(manifest: PackageManifest): string {
  const runtime = Object.keys(manifest.dependencies);
  const dev = Object.keys(manifest.devDependencies);
  const runtimePreview = runtime.slice(0, 10).join(', ');
  return [
    `${runtime.length} runtime dependencies${runtimePreview.length > 0 ? `: ${runtimePreview}` : ''}`,
    `${dev.length} development dependencies`,
    `package manager: ${manifest.packageManager}`,
  ].join(' | ');
}
