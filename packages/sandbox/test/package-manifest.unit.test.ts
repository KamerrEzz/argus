import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  availableScripts,
  detectPackageManager,
  readPackageManifest,
  describeDependencySummary,
  resolveScriptName,
  type PackageManifest,
} from '@acr/sandbox';
import { buildScriptCatalog } from '@acr/pipeline';
import {
  NotFoundError,
  ValidationError,
  type RepoWorkspace,
} from '@acr/shared';

/**
 * Minimal RepoWorkspace over a real temp directory (injected port, no git).
 * `readFile` rejects on missing files, mirroring LocalWorkspace's NotFoundError,
 * because readPackageManifest relies on that rejection to return null.
 */
function makeWorkspace(root: string): RepoWorkspace {
  async function walk(directory: string, prefix: string): Promise<string[]> {
    const found: string[] = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        found.push(...(await walk(join(directory, entry.name), relative)));
      } else {
        found.push(relative);
      }
    }
    return found;
  }

  return {
    root,
    headSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    async fileList(): Promise<readonly string[]> {
      return walk(root, '');
    },
    async readFile(relativePath: string): Promise<string> {
      try {
        return await fs.readFile(join(root, relativePath), 'utf8');
      } catch {
        throw new NotFoundError('Workspace file', { path: relativePath });
      }
    },
    async exists(relativePath: string): Promise<boolean> {
      try {
        await fs.access(join(root, relativePath));
        return true;
      } catch {
        return false;
      }
    },
    async listDirectory(): Promise<readonly { name: string; type: 'file' | 'directory' | 'symlink' | 'other' }[]> {
      return [];
    },
    async cleanup(): Promise<void> {
      // The outer afterEach removes the temp directory.
    },
  };
}

function manifestWith(
  scripts: Readonly<Record<string, string>>,
  overrides: Partial<PackageManifest> = {},
): PackageManifest {
  return {
    name: 'demo',
    packageManager: 'npm',
    scripts,
    dependencies: {},
    devDependencies: {},
    engines: {},
    workspaces: [],
    ...overrides,
  };
}

describe('readPackageManifest — workspace-backed reads', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'acr-manifest-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function writeManifest(content: string): Promise<void> {
    await fs.writeFile(join(dir, 'package.json'), content, 'utf8');
  }

  it('returns null (does not throw) when the manifest is missing', async () => {
    await expect(readPackageManifest(makeWorkspace(dir))).resolves.toBeNull();
  });

  it('returns null when package.json cannot be read as a file', async () => {
    await fs.mkdir(join(dir, 'package.json'));
    await expect(readPackageManifest(makeWorkspace(dir))).resolves.toBeNull();
  });

  it('throws ValidationError on malformed JSON instead of crashing raw', async () => {
    await writeManifest('{ "name": "broken", ');
    const attempt = readPackageManifest(makeWorkspace(dir)).catch((error: unknown) => error);
    const error = await attempt;
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe('validation_error');
    expect((error as ValidationError).message).toBe('Repository package.json is not valid JSON');
  });

  it('throws ValidationError when the JSON is valid but not an object', async () => {
    await writeManifest('"just a string"');
    const error = await readPackageManifest(makeWorkspace(dir)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).message).toBe('Repository package.json is not an object');

    await writeManifest('null');
    const nullError = await readPackageManifest(makeWorkspace(dir)).catch((caught: unknown) => caught);
    expect(nullError).toBeInstanceOf(ValidationError);
  });

  it('accepts a JSON array without crashing (it is an object to typeof)', async () => {
    await writeManifest('[1, 2, 3]');
    const manifest = await readPackageManifest(makeWorkspace(dir));
    expect(manifest).not.toBeNull();
    expect(manifest?.name).toBeNull();
    expect(manifest?.scripts).toEqual({});
    expect(manifest?.packageManager).toBe('unknown');
  });

  it('parses CRLF-terminated JSON', async () => {
    await writeManifest(
      '{\r\n  "name": "crlf-demo",\r\n  "scripts": {\r\n    "test": "vitest run"\r\n  }\r\n}',
    );
    const manifest = await readPackageManifest(makeWorkspace(dir));
    expect(manifest?.name).toBe('crlf-demo');
    expect(manifest?.scripts).toEqual({ test: 'vitest run' });
  });

  it('drops non-string script and dependency values instead of throwing', async () => {
    await writeManifest(
      JSON.stringify({
        name: 'noisy',
        scripts: { test: 'vitest run', broken: 42, nested: { deep: true } },
        dependencies: { leftpad: '^1.0.0', weird: null },
        devDependencies: 'not-a-map',
      }),
    );
    const manifest = await readPackageManifest(makeWorkspace(dir));
    expect(manifest?.scripts).toEqual({ test: 'vitest run' });
    expect(manifest?.dependencies).toEqual({ leftpad: '^1.0.0' });
    expect(manifest?.devDependencies).toEqual({});
  });

  it('keeps only string entries from workspaces arrays', async () => {
    await writeManifest(JSON.stringify({ name: 'mono', workspaces: ['packages/*', 7, null] }));
    const manifest = await readPackageManifest(makeWorkspace(dir));
    expect(manifest?.workspaces).toEqual(['packages/*']);
  });

  it('prefers a declared packageManager field over lockfiles', async () => {
    await writeManifest(JSON.stringify({ name: 'x', packageManager: 'pnpm@9.15.0' }));
    await fs.writeFile(join(dir, 'yarn.lock'), '', 'utf8');
    await fs.writeFile(join(dir, 'package-lock.json'), '{}', 'utf8');
    const manifest = await readPackageManifest(makeWorkspace(dir));
    expect(manifest?.packageManager).toBe('pnpm');
  });

  it('uses lockfiles discovered through the injected files list, not the disk', async () => {
    await writeManifest(JSON.stringify({ name: 'x' }));
    await fs.writeFile(join(dir, 'package-lock.json'), '{}', 'utf8');
    const manifest = await readPackageManifest(makeWorkspace(dir), ['pnpm-lock.yaml']);
    expect(manifest?.packageManager).toBe('pnpm');
  });

  it('falls back to fileList() when no files list is provided', async () => {
    await writeManifest(JSON.stringify({ name: 'x' }));
    await fs.writeFile(join(dir, 'yarn.lock'), '', 'utf8');
    const manifest = await readPackageManifest(makeWorkspace(dir));
    expect(manifest?.packageManager).toBe('yarn');
  });
});

describe('detectPackageManager — precedence rules', () => {
  it('honors a declared packageManager string', () => {
    expect(detectPackageManager({}, [], 'npm@10.9.0')).toBe('npm');
    expect(detectPackageManager({}, ['package-lock.json'], 'bun@1.2.3')).toBe('bun');
  });

  it('ignores unknown or empty declared values and consults lockfiles in priority order', () => {
    expect(detectPackageManager({}, ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'], 'deno@2')).toBe('pnpm');
    expect(detectPackageManager({}, ['yarn.lock', 'package-lock.json'], '')).toBe('yarn');
    expect(detectPackageManager({}, ['bun.lockb', 'package-lock.json'], undefined)).toBe('bun');
    expect(detectPackageManager({}, ['package-lock.json'], undefined)).toBe('npm');
  });

  it('defaults to npm for a manifest with a name, unknown otherwise', () => {
    expect(detectPackageManager({ name: 'x' }, [], undefined)).toBe('npm');
    expect(detectPackageManager({}, [], undefined)).toBe('unknown');
    expect(detectPackageManager(null, [], undefined)).toBe('unknown');
  });
});

describe('availableScripts', () => {
  it('is all-false for a null manifest', () => {
    expect(availableScripts(null)).toEqual({
      test: false,
      lint: false,
      typecheck: false,
      build: false,
    });
  });

  it('flags the four canonical kinds when plain names exist', () => {
    const manifest = manifestWith({
      test: 'vitest run',
      lint: 'eslint .',
      typecheck: 'tsc --noEmit',
      build: 'tsc -b',
    });
    expect(availableScripts(manifest)).toEqual({
      test: true,
      lint: true,
      typecheck: true,
      build: true,
    });
  });

  it('recognizes every alias the source declares', () => {
    expect(availableScripts(manifestWith({ 'test:unit': 'vitest run' })).test).toBe(true);
    expect(availableScripts(manifestWith({ tests: 'node --test' })).test).toBe(true);
    expect(availableScripts(manifestWith({ 'test:ci': 'vitest ci' })).test).toBe(true);
    expect(availableScripts(manifestWith({ eslint: 'eslint .' })).lint).toBe(true);
    expect(availableScripts(manifestWith({ 'lint:ci': 'eslint .' })).lint).toBe(true);
    expect(availableScripts(manifestWith({ 'type-check': 'tsc --noEmit' })).typecheck).toBe(true);
    expect(availableScripts(manifestWith({ tsc: 'tsc --noEmit' })).typecheck).toBe(true);
    expect(availableScripts(manifestWith({ 'check:types': 'tsc --noEmit' })).typecheck).toBe(true);
    expect(availableScripts(manifestWith({ compile: 'tsc -b' })).build).toBe(true);
  });

  it('does not count whitespace-only script values', () => {
    expect(availableScripts(manifestWith({ test: '   ' })).test).toBe(false);
    expect(availableScripts(manifestWith({ test: '' })).test).toBe(false);
  });

  it('is all-false for unrelated script names', () => {
    expect(availableScripts(manifestWith({ start: 'node .', seed: 'node seed.js' }))).toEqual({
      test: false,
      lint: false,
      typecheck: false,
      build: false,
    });
  });
});

describe('resolveScriptName — canonical kinds and alias precedence', () => {
  const kinds = ['test', 'lint', 'typecheck', 'build'] as const;

  it('resolves each canonical kind to its plain name', () => {
    const manifest = manifestWith({
      test: 'vitest run',
      lint: 'eslint .',
      typecheck: 'tsc --noEmit',
      build: 'tsc -b',
    });
    for (const kind of kinds) {
      expect(resolveScriptName(manifest, kind)).toBe(kind);
    }
  });

  it('prefers the earliest alias regardless of insertion order', () => {
    // 'test:unit' inserted BEFORE 'test': alias order must win over key order.
    const manifest = manifestWith({ 'test:unit': 'vitest run unit', test: 'vitest run' });
    expect(resolveScriptName(manifest, 'test')).toBe('test');
  });

  it('falls through to later aliases when earlier ones are absent or blank', () => {
    expect(resolveScriptName(manifestWith({ 'test:ci': 'vitest ci' }), 'test')).toBe('test:ci');
    expect(resolveScriptName(manifestWith({ test: '  ', tests: 'node --test' }), 'test')).toBe(
      'tests',
    );
    expect(
      resolveScriptName(manifestWith({ typecheck: ' ', 'check:types': 'tsc --noEmit' }), 'typecheck'),
    ).toBe('check:types');
  });

  it('returns null for absent kinds and null manifests', () => {
    expect(resolveScriptName(manifestWith({ start: 'node .' }), 'lint')).toBeNull();
    for (const kind of kinds) {
      expect(resolveScriptName(null, kind)).toBeNull();
    }
  });

  it('handles a 40-key script map without breaking ordering assumptions', () => {
    const scripts: Record<string, string> = {};
    for (let index = 1; index <= 40; index += 1) {
      scripts[`task-${String(index).padStart(2, '0')}`] = `node scripts/task-${index}.js`;
    }
    // Canonical names placed last; decoy aliases placed first.
    scripts['test:unit'] = 'vitest run --coverage';
    scripts.typecheck = 'tsc -p tsconfig.json';
    scripts.test = 'vitest run';
    scripts.lint = 'eslint .';
    scripts.build = 'tsc -b';
    const manifest = manifestWith(scripts);

    expect(Object.keys(manifest.scripts)).toHaveLength(45);
    expect(resolveScriptName(manifest, 'test')).toBe('test');
    expect(resolveScriptName(manifest, 'lint')).toBe('lint');
    expect(resolveScriptName(manifest, 'typecheck')).toBe('typecheck');
    expect(resolveScriptName(manifest, 'build')).toBe('build');
    expect(availableScripts(manifest)).toEqual({
      test: true,
      lint: true,
      typecheck: true,
      build: true,
    });
  });
});

describe('describeDependencySummary', () => {
  it('lists up to ten runtime dependency names in key order', () => {
    const dependencies: Record<string, string> = {};
    for (let index = 1; index <= 12; index += 1) {
      dependencies[`pkg-${String(index).padStart(2, '0')}`] = '^1.0.0';
    }
    const summary = describeDependencySummary(
      manifestWith({}, { dependencies, devDependencies: { vitest: '3.0.0' }, packageManager: 'pnpm' }),
    );
    const [runtimePart, devPart, managerPart] = summary.split(' | ');
    expect(runtimePart).toBe(
      '12 runtime dependencies: pkg-01, pkg-02, pkg-03, pkg-04, pkg-05, pkg-06, pkg-07, pkg-08, pkg-09, pkg-10',
    );
    expect(devPart).toBe('1 development dependencies');
    expect(managerPart).toBe('package manager: pnpm');
  });

  it('omits the preview when there are no runtime dependencies', () => {
    const summary = describeDependencySummary(manifestWith({}, { packageManager: 'unknown' }));
    expect(summary).toBe('0 runtime dependencies | 0 development dependencies | package manager: unknown');
  });
});

describe('buildScriptCatalog — static_analysis and security_scan hints', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'acr-catalog-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('expands hint-matching script names into the analysis and security allow-lists', async () => {
    await fs.writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'hints',
        scripts: {
          test: 'vitest run',
          lint: 'eslint .',
          typecheck: 'tsc --noEmit',
          'analyze-bundle': 'node scripts/analyze.js',
          audit: 'npm audit --audit-level=high',
          'security-scan': 'semgrep --config auto',
          'test:e2e': 'playwright test',
        },
      }),
      'utf8',
    );
    const catalog = await buildScriptCatalog(makeWorkspace(dir));
    expect(catalog.allowed.static_analysis).toEqual(
      expect.arrayContaining(['lint', 'typecheck', 'analyze-bundle']),
    );
    // Canonical lint/typecheck appear exactly once even though their names
    // also match the analysis hint regex.
    expect(catalog.allowed.static_analysis?.filter((name) => name === 'lint')).toHaveLength(1);
    expect(catalog.allowed.security_scan).toEqual(
      expect.arrayContaining(['audit', 'security-scan']),
    );
    expect(catalog.allowed.security_scan).not.toContain('test:e2e');
    expect(catalog.allowed.test).toEqual(['test']);
    expect(catalog.dependencySummary).toContain('package manager: npm');
    expect(catalog.availability).toEqual({
      test: true,
      lint: true,
      typecheck: true,
      build: false,
    });
  });

  it('produces an empty catalog when the manifest is missing', async () => {
    const catalog = await buildScriptCatalog(makeWorkspace(dir));
    expect(catalog.manifest).toBeNull();
    expect(catalog.allowed).toEqual({});
    expect(catalog.dependencySummary).toBeNull();
    expect(catalog.availability).toEqual({
      test: false,
      lint: false,
      typecheck: false,
      build: false,
    });
  });
});
