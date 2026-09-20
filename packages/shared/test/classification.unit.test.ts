import { describe, expect, it } from 'vitest';
import {
  buildReviewPlan,
  classifyChanges,
  classifyFileKind,
  type ChangedFile,
} from '@acr/shared';

function file(path: string, additions = 1, deletions = 0, overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path,
    previousPath: null,
    status: 'modified',
    additions,
    deletions,
    patch: null,
    binary: false,
    ...overrides,
  };
}

describe('classifyFileKind', () => {
  it.each([
    ['src/services/user.ts', 'source'],
    ['app/page.jsx', 'source'],
    ['cmd/main.go', 'source'],
    ['lib/conn.py', 'source'],
    ['server.sh', 'source'],
  ])('source code: %s -> %s', (path, kind) => {
    expect(classifyFileKind(path)).toBe(kind);
  });

  it.each([
    'src/user.test.ts',
    'src/user.spec.ts',
    'tests/helper.ts',
    '__tests__/thing.js',
    'e2e/login.ts',
    'specs/x.py',
  ])('test path (suffix or directory): %s', (path) => {
    expect(classifyFileKind(path)).toBe('test');
  });

  it.each(['README.md', 'docs/guide.mdx', 'notes.txt', 'CHANGELOG.adoc'])('documentation: %s', (path) => {
    expect(classifyFileKind(path)).toBe('documentation');
  });

  it('lockfiles win over dependency manifests and config by extension', () => {
    expect(classifyFileKind('package-lock.json')).toBe('lockfile');
    expect(classifyFileKind('pnpm-lock.yaml')).toBe('lockfile');
    expect(classifyFileKind('yarn.lock')).toBe('lockfile');
    expect(classifyFileKind('src/package-lock.json')).toBe('lockfile');
  });

  it('dependency manifests are detected by exact basename', () => {
    expect(classifyFileKind('package.json')).toBe('dependency');
    expect(classifyFileKind('apps/api/package.json')).toBe('dependency');
    expect(classifyFileKind('go.mod')).toBe('dependency');
    // Not a manifest basename: falls through to config by extension.
    expect(classifyFileKind('renamed-package.json')).toBe('config');
  });

  it('CI, migration, infra and SQL kinds are matched before generic rules', () => {
    expect(classifyFileKind('.github/workflows/ci.yml')).toBe('ci');
    expect(classifyFileKind('.circleci/config.yml')).toBe('ci');
    expect(classifyFileKind('db/migrations/001_init.sql')).toBe('migration'); // before .sql
    expect(classifyFileKind('schema.sql')).toBe('sql');
    // `docker-compose.yml` is NOT infrastructure: the docker rule needs a path
    // segment (or `Dockerfile`), so it falls through to config by extension.
    expect(classifyFileKind('docker-compose.yml')).toBe('config');
  });

  it('infrastructure covers Dockerfile, terraform and infra directories; build configs too', () => {
    expect(classifyFileKind('Dockerfile')).toBe('infrastructure');
    expect(classifyFileKind('infra/k8s/app.tf')).toBe('infrastructure');
    expect(classifyFileKind('kubernetes/deploy.yaml')).toBe('infrastructure');
    expect(classifyFileKind('tsconfig.json')).toBe('infrastructure');
    expect(classifyFileKind('webpack.config.js')).toBe('infrastructure');
  });

  it('config vs unknown by extension', () => {
    expect(classifyFileKind('settings.yaml')).toBe('config');
    expect(classifyFileKind('app.properties')).toBe('config');
    expect(classifyFileKind('LICENSE')).toBe('unknown');
    // A leading-dot file has no extension per extensionOfRepoPath: `.env` is
    // unknown, while `app.env` carries the `.env` extension and is config.
    expect(classifyFileKind('.env')).toBe('unknown');
    expect(classifyFileKind('staging.env')).toBe('config');
  });

  it('normalizes backslash and ./ prefixed inputs', () => {
    expect(classifyFileKind('src\\user.test.ts')).toBe('test');
    expect(classifyFileKind('./docs/readme.md')).toBe('documentation');
  });

  it('uppercase extensions still classify (basename and extension are lowercased first)', () => {
    expect(classifyFileKind('COMPONENT.TSX')).toBe('source');
    // The manifest/lockfile lookup runs on the lowercased basename, so even a
    // shouty `Package.JSON` is a dependency manifest, not a plain config file.
    expect(classifyFileKind('Package.JSON')).toBe('dependency');
  });

  it('has no concept of vendored or generated files (documented limitation)', () => {
    // There is no vendor/generated rule in classification.ts: a vendored file
    // classifies by extension, so reviewers see it as ordinary source. Any
    // ignore rules live in RepositorySettings.ignorePaths instead.
    expect(classifyFileKind('vendor/legacy.js')).toBe('source');
    expect(classifyFileKind('generated/client.ts')).toBe('source');
  });
});

describe('classifyChanges totals and bucket shape', () => {
  it('empty input produces zeroed totals and no code-bearing flags', () => {
    const result = classifyChanges([]);
    expect(result.totalFiles).toBe(0);
    expect(result.totalAdditions).toBe(0);
    expect(result.totalDeletions).toBe(0);
    expect(result.sourceFiles).toEqual([]);
    expect(result.documentationOnly).toBe(false); // requires files.length > 0
    expect(result.touchesAuthentication).toBe(false);
    expect(result.touchesDatabase).toBe(false);
    expect(result.touchesHttpApi).toBe(false);
    expect(result.touchesUi).toBe(false);
    expect(result.touchesDependencies).toBe(false);
    expect(result.touchesSecuritySensitive).toBe(false);
    expect(result.touchesPerformanceSensitive).toBe(false);
    expect(result.touchesBuildConfiguration).toBe(false);
    expect(result.languageCounts).toEqual({});
  });

  it('sums additions/deletions across files and keeps bucket order', () => {
    const result = classifyChanges([file('src/b.ts', 10, 2), file('src/a.ts', 1, 5), file('docs/x.md', 3, 0)]);
    expect(result.totalAdditions).toBe(14);
    expect(result.totalDeletions).toBe(7);
    expect(result.totalFiles).toBe(3);
    expect(result.sourceFiles).toEqual(['src/b.ts', 'src/a.ts']); // input order, not sorted
    expect(result.documentationFiles).toEqual(['docs/x.md']);
  });

  it('normalizes every reported path to forward slashes', () => {
    const result = classifyChanges([file('src\\nested\\util.js')]);
    expect(result.sourceFiles).toEqual(['src/nested/util.js']);
  });

  it('languageCounts tallies source and test files only, with lowercase extensions', () => {
    const result = classifyChanges([
      file('a.ts'),
      file('B.TS'), // uppercase extension normalizes to .ts
      file('src/x.test.ts'),
      file('README.md'), // documentation not counted
      file('noext-source-file'), // unknown not counted
    ]);
    expect(result.languageCounts).toEqual({ '.ts': 3 });
  });

  it('flags auth/security/db/api/ui/perf by path patterns, not substrings-within-words', () => {
    const touching = classifyChanges([
      file('src/auth/login.ts'),
      file('api/routes/users.ts'),
      file('components/Button.tsx'),
      file('src/cache/redis.ts'),
    ]);
    expect(touching.touchesAuthentication).toBe(true);
    expect(touching.touchesHttpApi).toBe(true);
    expect(touching.touchesUi).toBe(true);
    expect(touching.touchesPerformanceSensitive).toBe(true);

    // "author" must NOT trip the auth pattern (word boundary via (\/|\.|$)).
    const lookalike = classifyChanges([file('src/author/bio.ts')]);
    expect(lookalike.touchesAuthentication).toBe(false);
    expect(lookalike.touchesHttpApi).toBe(false);
  });

  it('dependencies and build-configuration flags flip only for their kinds', () => {
    const deps = classifyChanges([file('package-lock.json')]);
    expect(deps.touchesDependencies).toBe(true);
    expect(deps.lockFiles).toEqual(['package-lock.json']);

    const build = classifyChanges([file('.github/workflows/test.yml')]);
    expect(build.touchesBuildConfiguration).toBe(true);

    const neither = classifyChanges([file('src/app.ts')]);
    expect(neither.touchesDependencies).toBe(false);
    expect(neither.touchesBuildConfiguration).toBe(false);
  });

  it('sql and migration changes imply touchesDatabase', () => {
    const result = classifyChanges([file('db/migrations/002_index.sql')]);
    expect(result.migrationFiles).toEqual(['db/migrations/002_index.sql']);
    expect(result.touchesDatabase).toBe(true);
  });

  it('documentationOnly is true only when no code-bearing or unknown file changed', () => {
    expect(classifyChanges([file('README.md'), file('docs/guide.mdx')]).documentationOnly).toBe(true);
    expect(classifyChanges([file('README.md'), file('src/hidden.ts')]).documentationOnly).toBe(false);
    // An unknown file disqualifies documentationOnly (safety: never assume).
    expect(classifyChanges([file('README.md'), file('LICENSE')]).documentationOnly).toBe(false);
  });
});

describe('classification feeding ReviewPlan (consumer contract)', () => {
  const baseInputs = {
    availableScripts: { test: true, lint: true, typecheck: true, build: true },
    enableTests: true,
    enableLint: true,
    enableTypecheck: true,
    deepReviewAllowed: true,
    maxFiles: 100,
  };

  it('documentation-only changes produce an all-off plan', () => {
    const classification = classifyChanges([file('docs/readme.md')]);
    const plan = buildReviewPlan({ ...baseInputs, classification });
    expect(plan.analyzeTests).toBe(false);
    expect(plan.analyzeLint).toBe(false);
    expect(plan.deepReview).toBe(false);
    expect(plan.reasons).toContain('documentation_only_change');
  });

  it('a source change with scripts available turns tests/lint/typecheck on', () => {
    const classification = classifyChanges([file('src/app.ts')]);
    const plan = buildReviewPlan({ ...baseInputs, classification });
    expect(plan.analyzeTests).toBe(true);
    expect(plan.analyzeLint).toBe(true);
    expect(plan.analyzeTypecheck).toBe(true);
    expect(plan.analyzeSecurity).toBe(true); // hasExecutableSource
  });

  it('sourceFiles length alone drives deep review at 3+ files', () => {
    const small = buildReviewPlan({
      ...baseInputs,
      classification: classifyChanges([file('a.ts'), file('b.ts')]),
    });
    expect(small.deepReview).toBe(false);
    const large = buildReviewPlan({
      ...baseInputs,
      classification: classifyChanges([file('a.ts'), file('b.ts'), file('c.ts')]),
    });
    expect(large.deepReview).toBe(true);
  });

  it('file_limit_exceeded reason surfaces the actual numbers', () => {
    const plan = buildReviewPlan({
      ...baseInputs,
      maxFiles: 1,
      classification: classifyChanges([file('a.ts'), file('b.ts')]),
    });
    expect(plan.reasons).toContain('file_limit_exceeded:2>1');
  });
});
