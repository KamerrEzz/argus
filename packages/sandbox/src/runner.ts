import type { AppConfig } from '@acr/config';
import {
  SandboxError,
  type CommandRunnerPort,
  type LoggerPort,
} from '@acr/shared';
import { resolve } from 'node:path';
import { DockerSandboxRunner } from './docker-runner';
import { ProcessSandboxRunner, runChildProcess } from './process-runner';

export interface SandboxProbe {
  readonly available: boolean;
  readonly version: string | null;
  readonly error: string | null;
}

export interface CommandRunnerFactoryOptions {
  readonly config: AppConfig;
  readonly logger: LoggerPort;
}

export function workspaceRootOf(config: AppConfig): string {
  return resolve(config.workspaceRoot, config.sandbox.workspaceRoot);
}

/**
 * Fail-closed runner for `SANDBOX_MODE=off`: code-reading reviews never reach
 * it (the container reports the sandbox unavailable and checks are skipped),
 * but a direct call fails loudly instead of executing anywhere.
 */
export class DisabledCommandRunner implements CommandRunnerPort {
  async run(): Promise<never> {
    throw new SandboxError('Sandbox is disabled (SANDBOX_MODE=off): code checks cannot run');
  }
}

export function createCommandRunner(options: CommandRunnerFactoryOptions): CommandRunnerPort {
  const { config, logger } = options;
  const allowedRoots = [workspaceRootOf(config)];

  if (config.sandbox.mode === 'off') {
    return new DisabledCommandRunner();
  }

  if (config.sandbox.mode === 'docker') {
    return new DockerSandboxRunner({
      logger,
      dockerBinary: config.sandbox.dockerBinary,
      defaultImage: config.sandbox.image,
      timeoutMs: config.sandbox.timeoutMs,
      cpuLimit: config.sandbox.cpuLimit,
      memoryLimit: config.sandbox.memoryLimit,
      pidsLimit: config.sandbox.pidsLimit,
      network: config.sandbox.network,
      allowedRoots,
    });
  }

  if (!config.sandbox.allowProcessSandbox) {
    throw new SandboxError(
      'Sandbox mode "process" requires ALLOW_PROCESS_SANDBOX=true; it is not isolated',
    );
  }

  return new ProcessSandboxRunner({
    logger,
    timeoutMs: config.sandbox.timeoutMs,
    allowedRoots,
  });
}

async function probeBinary(binary: string, expect: string): Promise<SandboxProbe> {
  try {
    const result = await runChildProcess({
      binary,
      args: ['--version'],
      cwd: process.cwd(),
      env: { PATH: process.env['PATH'] ?? '', SystemRoot: process.env['SystemRoot'] ?? '' },
      timeoutMs: 15_000,
    });
    const version = result.stdout.trim().split('\n')[0] ?? '';
    if (result.exitCode !== 0 || version.length === 0) {
      return { available: false, version: null, error: `${binary} --version exited with ${result.exitCode}` };
    }
    return {
      available: version.toLowerCase().includes(expect),
      version,
      error: version.toLowerCase().includes(expect) ? null : `unexpected version output: ${version}`,
    };
  } catch (error) {
    return {
      available: false,
      version: null,
      error: error instanceof Error ? error.message : 'unknown',
    };
  }
}

export function probeDocker(config: AppConfig): Promise<SandboxProbe> {
  return probeBinary(config.sandbox.dockerBinary, 'docker');
}

export function probeGit(config: AppConfig): Promise<SandboxProbe> {
  return probeBinary(config.sandbox.gitBinary, 'git version');
}
