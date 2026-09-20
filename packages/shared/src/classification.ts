import { extensionOfRepoPath, normalizeRepoPath } from './paths';
import type { ChangedFile } from './github-types';

export interface ChangeClassification {
  readonly totalFiles: number;
  readonly totalAdditions: number;
  readonly totalDeletions: number;
  readonly sourceFiles: readonly string[];
  readonly testFiles: readonly string[];
  readonly documentationFiles: readonly string[];
  readonly configFiles: readonly string[];
  readonly ciFiles: readonly string[];
  readonly sqlFiles: readonly string[];
  readonly migrationFiles: readonly string[];
  readonly dependencyFiles: readonly string[];
  readonly lockFiles: readonly string[];
  readonly infrastructureFiles: readonly string[];
  readonly unknownFiles: readonly string[];
  readonly languageCounts: Readonly<Record<string, number>>;
  readonly touchesAuthentication: boolean;
  readonly touchesDatabase: boolean;
  readonly touchesHttpApi: boolean;
  readonly touchesUi: boolean;
  readonly touchesDependencies: boolean;
  readonly touchesSecuritySensitive: boolean;
  readonly touchesPerformanceSensitive: boolean;
  readonly touchesBuildConfiguration: boolean;
  readonly documentationOnly: boolean;
}

export type FileKind =
  | 'source'
  | 'test'
  | 'documentation'
  | 'config'
  | 'ci'
  | 'sql'
  | 'migration'
  | 'dependency'
  | 'lockfile'
  | 'infrastructure'
  | 'unknown';

const DOCUMENTATION_EXTENSIONS = new Set(['.md', '.mdx', '.rst', '.adoc', '.txt']);
const TEST_PATH_PATTERN = /(^|\/)(tests?|__tests__|spec|specs|e2e)(\/|$)|\.(test|spec)\./i;
const CI_PATH_PATTERN = /^\.github\/|^\.gitlab-ci|^\.circleci\/|^azure-pipelines|^\.buildkite\//i;
const MIGRATION_PATH_PATTERN = /(^|\/)(migrations?|migrate)(\/|$)/i;
const INFRA_PATH_PATTERN =
  /(^|\/)(docker|k8s|kubernetes|helm|terraform|ansible|infra|infrastructure)(\/|$)|\.tf$|Dockerfile/i;
const DEPENDENCY_FILES = new Set(['package.json', 'requirements.txt', 'pyproject.toml', 'go.mod', 'cargo.toml', 'composer.json', 'gemfile', 'pom.xml', 'build.gradle']);
const LOCK_FILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'cargo.lock', 'poetry.lock', 'composer.lock', 'go.sum']);
const CONFIG_EXTENSIONS = new Set(['.json', '.yaml', '.yml', '.toml', '.ini', '.env', '.properties', '.conf']);
const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.php',
  '.cs',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.swift',
  '.scala',
  '.lua',
  '.sh',
  '.sql',
  '.vue',
  '.svelte',
]);

const AUTH_PATH_PATTERN = /(^|\/)(auth|authn|authz|authentication|authorization|login|session|oauth|jwt|tokens?|passwords?|permissions?|rbac|acl)(\/|\.|$)/i;
const SECURITY_PATH_PATTERN = /(^|\/)(crypto|encryption|secrets?|cipher|sanitize|validation|middleware|guards?)(\/|\.|$)/i;
const DATABASE_PATH_PATTERN = /(^|\/)(db|database|models?|schema|entities|repositories|queries|orm)(\/|\.|$)|\.sql$/i;
const API_PATH_PATTERN = /(^|\/)(api|routes?|controllers?|handlers?|endpoints?|graphql|rest)(\/|\.|$)/i;
const UI_PATH_PATTERN = /\.(tsx|jsx|vue|svelte|css|scss|html)$|(^|\/)(components?|pages?|views?|app|ui|styles?)(\/|\.|$)/i;
const PERFORMANCE_PATH_PATTERN = /(^|\/)(cache|performance|workers?|queues?|streams?|pools?|indexes?)(\/|\.|$)|\.(wasm|worker)\./i;
const BUILD_CONFIG_FILES = new Set(['tsconfig.json', 'dockerfile', 'makefile', 'webpack.config.js', 'vite.config.ts', 'next.config.js', 'rollup.config.js', 'babel.config.js']);

export function classifyFileKind(path: string): FileKind {
  const normalized = normalizeRepoPath(path);
  const lower = normalized.toLowerCase();
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  const extension = extensionOfRepoPath(lower);

  if (LOCK_FILES.has(base)) {
    return 'lockfile';
  }
  if (DEPENDENCY_FILES.has(base)) {
    return 'dependency';
  }
  if (CI_PATH_PATTERN.test(normalized)) {
    return 'ci';
  }
  if (MIGRATION_PATH_PATTERN.test(normalized)) {
    return 'migration';
  }
  if (INFRA_PATH_PATTERN.test(normalized) || BUILD_CONFIG_FILES.has(base)) {
    return 'infrastructure';
  }
  if (extension === '.sql') {
    return 'sql';
  }
  if (TEST_PATH_PATTERN.test(normalized)) {
    return 'test';
  }
  if (DOCUMENTATION_EXTENSIONS.has(extension)) {
    return 'documentation';
  }
  if (SOURCE_EXTENSIONS.has(extension)) {
    return 'source';
  }
  if (CONFIG_EXTENSIONS.has(extension)) {
    return 'config';
  }
  return 'unknown';
}

export function classifyChanges(files: readonly ChangedFile[]): ChangeClassification {
  const buckets: Record<FileKind, string[]> = {
    source: [],
    test: [],
    documentation: [],
    config: [],
    ci: [],
    sql: [],
    migration: [],
    dependency: [],
    lockfile: [],
    infrastructure: [],
    unknown: [],
  };
  const languageCounts: Record<string, number> = {};
  let totalAdditions = 0;
  let totalDeletions = 0;
  let touchesAuthentication = false;
  let touchesDatabase = false;
  let touchesHttpApi = false;
  let touchesUi = false;
  let touchesDependencies = false;
  let touchesSecuritySensitive = false;
  let touchesPerformanceSensitive = false;
  let touchesBuildConfiguration = false;

  for (const file of files) {
    const normalized = normalizeRepoPath(file.path);
    const kind = classifyFileKind(normalized);
    buckets[kind].push(normalized);
    totalAdditions += file.additions;
    totalDeletions += file.deletions;

    if (kind === 'source' || kind === 'test') {
      const extension = extensionOfRepoPath(normalized);
      if (extension.length > 0) {
        languageCounts[extension] = (languageCounts[extension] ?? 0) + 1;
      }
    }
    if (kind === 'dependency' || kind === 'lockfile') {
      touchesDependencies = true;
    }
    if (kind === 'infrastructure' || kind === 'ci') {
      touchesBuildConfiguration = true;
    }
    if (AUTH_PATH_PATTERN.test(normalized)) {
      touchesAuthentication = true;
    }
    if (SECURITY_PATH_PATTERN.test(normalized)) {
      touchesSecuritySensitive = true;
    }
    if (DATABASE_PATH_PATTERN.test(normalized) || kind === 'sql' || kind === 'migration') {
      touchesDatabase = true;
    }
    if (API_PATH_PATTERN.test(normalized)) {
      touchesHttpApi = true;
    }
    if (UI_PATH_PATTERN.test(normalized)) {
      touchesUi = true;
    }
    if (PERFORMANCE_PATH_PATTERN.test(normalized)) {
      touchesPerformanceSensitive = true;
    }
  }

  const codeBearingKinds: FileKind[] = ['source', 'test', 'sql', 'migration', 'config', 'ci', 'infrastructure', 'dependency'];
  const hasCodeBearingChange = codeBearingKinds.some((kind) => buckets[kind].length > 0);
  const documentationOnly = !hasCodeBearingChange && buckets.unknown.length === 0 && files.length > 0;

  return {
    totalFiles: files.length,
    totalAdditions,
    totalDeletions,
    sourceFiles: buckets.source,
    testFiles: buckets.test,
    documentationFiles: buckets.documentation,
    configFiles: buckets.config,
    ciFiles: buckets.ci,
    sqlFiles: buckets.sql,
    migrationFiles: buckets.migration,
    dependencyFiles: buckets.dependency,
    lockFiles: buckets.lockfile,
    infrastructureFiles: buckets.infrastructure,
    unknownFiles: buckets.unknown,
    languageCounts,
    touchesAuthentication,
    touchesDatabase,
    touchesHttpApi,
    touchesUi,
    touchesDependencies,
    touchesSecuritySensitive,
    touchesPerformanceSensitive,
    touchesBuildConfiguration,
    documentationOnly,
  };
}
