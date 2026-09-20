import { ValidationError } from '@acr/shared';
import { runChildProcess } from './process-runner';

const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const SHA_PATTERN = /^[0-9a-f]{7,64}$/;

export function assertSafeGitRef(ref: string): void {
  if (!REF_PATTERN.test(ref)) {
    throw new ValidationError('Unsafe git ref', { ref });
  }
  if (ref.includes('..') || ref.endsWith('/') || ref.endsWith('.lock')) {
    throw new ValidationError('Unsafe git ref', { ref });
  }
}

export function assertSafeSha(sha: string): void {
  if (!SHA_PATTERN.test(sha)) {
    throw new ValidationError('Unsafe commit sha', { sha });
  }
}

export function buildAuthenticatedRemoteUrl(fullName: string, token: string): string {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(fullName)) {
    throw new ValidationError('Unsafe repository name', { fullName });
  }
  return `https://x-access-token:${encodeURIComponent(token)}@github.com/${fullName}.git`;
}

export interface GitClientOptions {
  readonly gitBinary: string;
  readonly logger: import('@acr/shared').LoggerPort;
}

export interface GitCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'] ?? '',
    SystemRoot: process.env['SystemRoot'] ?? '',
    ComSpec: process.env['ComSpec'] ?? '',
    HOME: process.env['HOME'] ?? process.env['USERPROFILE'] ?? '',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_ADVICE: '0',
  };
}

export class GitClient {
  private readonly options: GitClientOptions;

  constructor(options: GitClientOptions) {
    this.options = options;
  }

  private hardeningArgs(): string[] {
    return [
      '-c',
      'core.hooksPath=.git/disabled-hooks',
      '-c',
      'advice.detachedHead=false',
      '-c',
      'core.symlinks=false',
      '-c',
      'credential.helper=',
    ];
  }

  private async run(
    cwd: string,
    args: readonly string[],
    timeoutMs = 300_000,
  ): Promise<GitCommandResult> {
    const result = await runChildProcess({
      binary: this.options.gitBinary,
      args: [...this.hardeningArgs(), ...args],
      cwd,
      env: gitEnv(),
      timeoutMs,
    });
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }

  private async runOrThrow(
    cwd: string,
    args: readonly string[],
    operation: string,
    timeoutMs?: number,
  ): Promise<string> {
    const result = await this.run(cwd, args, timeoutMs);
    if (result.exitCode !== 0) {
      this.options.logger.error({ operation, args: args[0] }, 'git command failed');
      throw new ValidationError(`git ${operation} failed`, {
        exitCode: result.exitCode,
        stderr: result.stderr.slice(0, 2000),
      });
    }
    return result.stdout;
  }

  async initWorkspace(dir: string): Promise<void> {
    await this.runOrThrow(dir, ['init', '--quiet', '--initial-branch=acr'], 'init', 60_000);
    await this.runOrThrow(dir, ['config', '--local', 'core.autocrlf', 'false'], 'config', 30_000);
    await this.runOrThrow(dir, ['config', '--local', 'gc.auto', '0'], 'config', 30_000);
  }

  async addRemote(dir: string, url: string, name = 'origin'): Promise<void> {
    await this.runOrThrow(dir, ['remote', 'add', name, url], 'remote add', 30_000);
  }

  async removeRemote(dir: string, name = 'origin'): Promise<void> {
    await this.run(dir, ['remote', 'remove', name], 30_000);
  }

  async fetchRef(dir: string, ref: string, depth: number): Promise<void> {
    assertSafeGitRef(ref);
    await this.runOrThrow(
      dir,
      ['fetch', '--quiet', '--no-tags', `--depth=${depth}`, 'origin', ref],
      'fetch',
      600_000,
    );
  }

  async checkoutDetached(dir: string, ref = 'FETCH_HEAD'): Promise<void> {
    assertSafeGitRef(ref);
    await this.runOrThrow(dir, ['checkout', '--quiet', '--detach', ref], 'checkout', 300_000);
  }

  async resolveHead(dir: string): Promise<string> {
    const output = await this.runOrThrow(dir, ['rev-parse', 'HEAD'], 'rev-parse', 30_000);
    return output.trim();
  }

  async listTrackedFiles(dir: string): Promise<string[]> {
    const output = await this.runOrThrow(
      dir,
      ['ls-files', '-z', '--cached', '--exclude-standard'],
      'ls-files',
      120_000,
    );
    return output
      .split('\u0000')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  async version(): Promise<string | null> {
    const result = await this.run(process.cwd(), ['--version'], 15_000);
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  async pruneRefs(dir: string): Promise<void> {
    await this.run(dir, ['reflog', 'expire', '--expire=now', '--all'], 60_000);
    await this.run(dir, ['gc', '--prune=now', '--quiet'], 120_000);
  }
}
