import { randomBytes } from 'node:crypto';
import { isAbsolute, resolve, sep } from 'node:path';
import {
  SandboxError,
  type CommandRunnerPort,
  type CommandRunResult,
  type CommandSpec,
  type LoggerPort,
} from '@acr/shared';
import { sanitizeSpecEnv, toShellCommandLine } from './command';
import { runChildProcess } from './process-runner';
import { toCommandRunResult } from './output';

export interface DockerSandboxOptions {
  readonly logger: LoggerPort;
  readonly dockerBinary: string;
  readonly defaultImage: string;
  readonly timeoutMs: number;
  readonly cpuLimit: number;
  readonly memoryLimit: string;
  readonly pidsLimit: number;
  readonly network: 'none' | 'bridge';
  readonly allowedRoots: readonly string[];
}

function containerName(): string {
  return `acr-sandbox-${randomBytes(6).toString('hex')}`;
}

function currentUserArgs(): string[] {
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') {
    return [];
  }
  return ['--user', `${process.getuid()}:${process.getgid()}`];
}

export class DockerSandboxRunner implements CommandRunnerPort {
  private readonly options: DockerSandboxOptions;

  constructor(options: DockerSandboxOptions) {
    this.options = options;
  }

  private assertAllowedWorkspace(workspaceDir: string): void {
    // Resolve before comparing: a raw prefix check accepts `/workspaces-evil`
    // and `/workspaces/../etc`, both outside the root.
    const candidate = resolve(workspaceDir);
    const allowed = this.options.allowedRoots.some((root) => {
      const absoluteRoot = resolve(root);
      return (
        isAbsolute(candidate) &&
        (candidate === absoluteRoot ||
          candidate.startsWith(absoluteRoot.endsWith(sep) ? absoluteRoot : `${absoluteRoot}${sep}`))
      );
    });
    if (!allowed) {
      throw new SandboxError('Workspace directory is outside the configured sandbox root', {
        details: { workspaceDir },
      });
    }
  }

  private buildArgs(spec: CommandSpec, name: string, commandLine: string): string[] {
    const args = [
      'run',
      '--rm',
      '--name',
      name,
      '--network',
      spec.network,
      '--memory',
      spec.memoryLimit,
      '--memory-swap',
      spec.memoryLimit,
      '--cpus',
      String(spec.cpuLimit),
      '--pids-limit',
      String(spec.pidsLimit),
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      ...currentUserArgs(),
      '--tmpfs',
      '/tmp:rw,size=256m',
      '-v',
      `${spec.workspaceDir}:/workspace:rw`,
      '-w',
      '/workspace',
      '-e',
      'HOME=/tmp',
      '-e',
      'CI=1',
      '-e',
      'GIT_TERMINAL_PROMPT=0',
    ];

    for (const [key, value] of Object.entries(sanitizeSpecEnv(spec.env))) {
      args.push('-e', `${key}=${value}`);
    }

    args.push(spec.image, 'sh', '-lc', commandLine);
    return args;
  }

  async run(spec: CommandSpec): Promise<CommandRunResult> {
    this.assertAllowedWorkspace(spec.workspaceDir);
    const commandLine = toShellCommandLine(spec);
    const name = containerName();
    const timeoutMs = Math.min(spec.timeoutMs, this.options.timeoutMs);
    const args = this.buildArgs(spec, name, commandLine);
    const display = `docker run ${spec.image} :: ${commandLine}`;

    this.options.logger.info(
      { image: spec.image, container: name, command: commandLine, network: spec.network },
      'running command in docker sandbox',
    );

    const result = await runChildProcess({
      binary: this.options.dockerBinary,
      args,
      cwd: spec.workspaceDir,
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: process.env['HOME'] ?? process.env['USERPROFILE'] ?? '',
        SystemRoot: process.env['SystemRoot'] ?? '',
        DOCKER_HOST: process.env['DOCKER_HOST'] ?? '',
      },
      timeoutMs,
      onTimeout: async () => {
        await runChildProcess({
          binary: this.options.dockerBinary,
          args: ['kill', name],
          cwd: spec.workspaceDir,
          env: { PATH: process.env['PATH'] ?? '' },
          timeoutMs: 15_000,
        });
      },
    });

    if (result.exitCode !== 0 && !result.timedOut && result.stderr.includes('Cannot connect to the Docker daemon')) {
      throw new SandboxError('Docker daemon is unreachable', {
        details: { dockerBinary: this.options.dockerBinary },
      });
    }

    return toCommandRunResult(result, spec, 'docker', display);
  }
}
