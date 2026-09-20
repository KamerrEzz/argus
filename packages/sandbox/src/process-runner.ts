import { spawn, type ChildProcess } from 'node:child_process';
import { isAbsolute, resolve, sep } from 'node:path';
import { SandboxError, type CommandRunnerPort, type CommandRunResult, type CommandSpec, type LoggerPort } from '@acr/shared';
import { resolveNpmCommand, sanitizeSpecEnv, toShellCommandLine } from './command';
import { buildResult, createOutputCollector, toCommandRunResult, type StructuredCommandResult } from './output';

export interface SpawnInvocation {
  readonly binary: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly onTimeout?: () => void | Promise<void>;
}

const KILL_GRACE_MS = 5000;

export async function runChildProcess(invocation: SpawnInvocation): Promise<StructuredCommandResult> {
  const stdout = createOutputCollector();
  const stderr = createOutputCollector();
  const startedAt = Date.now();
  let timedOutFlag = false;

  return new Promise<StructuredCommandResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(invocation.binary, [...invocation.args], {
        cwd: invocation.cwd,
        env: invocation.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new SandboxError('Failed to start sandboxed process', { cause: error }));
      return;
    }

    const timer = setTimeout(() => {
      timedOutFlag = true;
      void Promise.resolve(invocation.onTimeout?.()).catch(() => undefined);
      child.kill('SIGKILL');
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, KILL_GRACE_MS).unref();
    }, invocation.timeoutMs);
    timer.unref();

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout.append(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr.append(chunk);
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new SandboxError('Sandboxed process failed to run', { cause: error }));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(
        buildResult({
          exitCode: code,
          timedOut: timedOutFlag,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
          failureReason: timedOutFlag ? 'timeout' : null,
        }),
      );
    });
  });
}

export interface ProcessSandboxOptions {
  readonly logger: LoggerPort;
  readonly timeoutMs: number;
  readonly allowedRoots: readonly string[];
}

/**
 * Local fallback that still executes repository code in a separate process with
 * a scrubbed environment. It provides no kernel-level isolation, which is why
 * it must be explicitly enabled and is reported as `process` everywhere.
 */
export class ProcessSandboxRunner implements CommandRunnerPort {
  private readonly options: ProcessSandboxOptions;

  constructor(options: ProcessSandboxOptions) {
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

  async run(spec: CommandSpec): Promise<CommandRunResult> {
    this.assertAllowedWorkspace(spec.workspaceDir);
    const resolved = resolveNpmCommand(spec);
    const display = toShellCommandLine(spec);
    const timeoutMs = Math.min(spec.timeoutMs, this.options.timeoutMs);

    this.options.logger.info({ command: display, cwd: spec.workspaceDir }, 'running command in process sandbox');

    const result = await runChildProcess({
      binary: resolved.binary,
      args: resolved.args,
      cwd: spec.workspaceDir,
      env: {
        // Spec extras go first so the fixed sandbox values below always win.
        ...sanitizeSpecEnv(spec.env),
        PATH: process.env['PATH'] ?? '',
        HOME: process.env['HOME'] ?? process.env['USERPROFILE'] ?? spec.workspaceDir,
        SystemRoot: process.env['SystemRoot'] ?? '',
        ComSpec: process.env['ComSpec'] ?? '',
        TEMP: process.env['TEMP'] ?? '',
        TMP: process.env['TMP'] ?? '',
        CI: '1',
        NODE_ENV: 'test',
        GIT_TERMINAL_PROMPT: '0',
      },
      timeoutMs,
    });

    return toCommandRunResult(result, spec, 'process', display);
  }
}

export { KILL_GRACE_MS };
