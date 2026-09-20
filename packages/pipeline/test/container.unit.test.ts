import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@acr/config';
import type { SandboxProbe } from '@acr/sandbox';
import { noopLogger } from '@acr/shared';
import { resolveSandboxUnavailable } from '@acr/pipeline';

function configWith(mode: 'docker' | 'process' | 'off', allowProcessSandbox: boolean): AppConfig {
  return {
    sandbox: { mode, allowProcessSandbox },
  } as unknown as AppConfig;
}

function probe(available: boolean, error: string | null = null): SandboxProbe {
  return { available, version: available ? 'test' : null, error };
}

describe('resolveSandboxUnavailable', () => {
  it('reports skipped probes honestly instead of blaming a missing binary', () => {
    const result = resolveSandboxUnavailable(
      configWith('process', true),
      probe(false, 'skipped'),
      probe(false, 'skipped'),
      noopLogger,
    );
    expect(result).toContain('probes skipped');
    expect(result).not.toContain('unavailable');
  });

  it('still reports a genuinely missing git binary', () => {
    const result = resolveSandboxUnavailable(
      configWith('process', true),
      probe(true),
      probe(false, 'spawn git ENOENT'),
      noopLogger,
    );
    expect(result).toContain('git is unavailable');
  });

  it('returns null when git resolves in process mode', () => {
    expect(
      resolveSandboxUnavailable(configWith('process', true), probe(false, 'x'), probe(true), noopLogger),
    ).toBeNull();
  });

  it('reports skipped docker distinctly when there is no process fallback', () => {
    const result = resolveSandboxUnavailable(
      configWith('docker', false),
      probe(false, 'skipped'),
      probe(true),
      noopLogger,
    );
    expect(result).toContain('probes skipped');
  });

  it('returns null when docker resolves, even if the git probe was skipped alongside a passing one', () => {
    // Git available + docker mode + docker available: nothing is disabled.
    expect(
      resolveSandboxUnavailable(configWith('docker', false), probe(true), probe(true), noopLogger),
    ).toBeNull();
  });

  it('reports the sandbox disabled in off mode even when binaries exist', () => {
    const result = resolveSandboxUnavailable(
      configWith('off', false),
      probe(true),
      probe(true),
      noopLogger,
    );
    expect(result).toContain('SANDBOX_MODE=off');
  });

  it('does not warn through the logger on the happy path', () => {
    const logger = { ...noopLogger, warn: vi.fn() };
    resolveSandboxUnavailable(configWith('process', true), probe(true), probe(true), logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
