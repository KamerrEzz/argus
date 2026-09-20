import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import {
  NotFoundError,
  ValidationError,
  resolveWithinRoot,
  type LoggerPort,
  type RepoWorkspace,
  type RepositoryRef,
  type WorkspaceDirectoryEntry,
} from '@acr/shared';
import { GitClient, assertSafeSha, buildAuthenticatedRemoteUrl } from './git';

export interface WorkspaceManagerOptions {
  readonly root: string;
  readonly gitBinary: string;
  readonly cloneDepth: number;
  readonly maxFileBytes: number;
  readonly logger: LoggerPort;
}

export interface CreateWorkspaceInput {
  readonly repository: RepositoryRef;
  readonly token: string;
  readonly runId: string;
  readonly pullRequestNumber?: number | null;
  readonly ref?: string | null;
  readonly expectedSha?: string | null;
}

function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate === root || candidate.startsWith(normalizedRoot);
}

export class LocalWorkspace implements RepoWorkspace {
  readonly root: string;
  readonly headSha: string;
  private readonly logger: LoggerPort;
  private readonly maxFileBytes: number;
  private cleanedUp = false;

  constructor(input: {
    root: string;
    headSha: string;
    logger: LoggerPort;
    maxFileBytes: number;
  }) {
    this.root = input.root;
    this.headSha = input.headSha;
    this.logger = input.logger;
    this.maxFileBytes = input.maxFileBytes;
  }

  private async assertRealPathWithinRoot(relativePath: string): Promise<string> {
    const candidate = resolveWithinRoot(this.root, relativePath);
    let real: string;
    try {
      real = await fs.realpath(candidate);
    } catch {
      throw new NotFoundError('Workspace file', { path: relativePath });
    }
    const realRoot = await fs.realpath(this.root);
    if (!isWithin(realRoot, real)) {
      throw new ValidationError('Path escapes the workspace root', { path: relativePath });
    }
    return real;
  }

  async fileList(): Promise<readonly string[]> {
    const git = new GitClient({ gitBinary: 'git', logger: this.logger });
    return git.listTrackedFiles(this.root);
  }

  async readFile(relativePath: string, options: { readonly maxBytes?: number } = {}): Promise<string> {
    const target = await this.assertRealPathWithinRoot(relativePath);
    const stats = await fs.stat(target);
    if (!stats.isFile()) {
      throw new ValidationError('Requested path is not a file', { path: relativePath });
    }
    const limit = Math.min(options.maxBytes ?? this.maxFileBytes, this.maxFileBytes);
    const length = Math.min(stats.size, limit);
    const handle = await fs.open(target, 'r');
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, 0);
      return buffer.toString('utf8');
    } finally {
      await handle.close();
    }
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await this.assertRealPathWithinRoot(relativePath);
      return true;
    } catch {
      return false;
    }
  }

  async listDirectory(relativePath: string): Promise<readonly WorkspaceDirectoryEntry[]> {
    const target = relativePath.length === 0 ? this.root : await this.assertRealPathWithinRoot(relativePath);
    const entries = await fs.readdir(target, { withFileTypes: true });
    return entries
      .map((entry) => {
        const type: WorkspaceDirectoryEntry['type'] = entry.isDirectory()
          ? 'directory'
          : entry.isFile()
            ? 'file'
            : entry.isSymbolicLink()
              ? 'symlink'
              : 'other';
        return { name: entry.name, type };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async cleanup(): Promise<void> {
    if (this.cleanedUp) {
      return;
    }
    this.cleanedUp = true;
    try {
      await fs.rm(this.root, { recursive: true, force: true });
      this.logger.debug({ workspace: this.root }, 'workspace removed');
    } catch (error) {
      this.logger.warn(
        { workspace: this.root, reason: error instanceof Error ? error.message : 'unknown' },
        'workspace cleanup failed',
      );
    }
  }
}

export class WorkspaceManager {
  private readonly options: WorkspaceManagerOptions;

  constructor(options: WorkspaceManagerOptions) {
    this.options = options;
  }

  absoluteRoot(): string {
    return resolve(this.options.root);
  }

  private async ensureRoot(): Promise<string> {
    const root = this.absoluteRoot();
    await fs.mkdir(root, { recursive: true });
    return root;
  }

  async create(input: CreateWorkspaceInput): Promise<RepoWorkspace> {
    const baseRoot = await this.ensureRoot();
    const directory = join(baseRoot, `run-${input.runId}-${randomBytes(4).toString('hex')}`);
    if (!isWithin(baseRoot, directory)) {
      throw new ValidationError('Workspace path escaped the configured root');
    }
    await fs.mkdir(dirname(directory), { recursive: true });
    await fs.mkdir(directory, { recursive: true });

    const git = new GitClient({ gitBinary: this.options.gitBinary, logger: this.options.logger });
    const remoteUrl = buildAuthenticatedRemoteUrl(input.repository.fullName, input.token);

    try {
      await git.initWorkspace(directory);
      await git.addRemote(directory, remoteUrl);

      const fetchRef = this.resolveFetchRef(input);
      await git.fetchRef(directory, fetchRef, this.options.cloneDepth);
      await git.checkoutDetached(directory);

      // The remote URL embeds an installation token; drop it before any
      // repository script can read .git/config.
      await git.removeRemote(directory, 'origin');

      const headSha = await git.resolveHead(directory);

      if (input.expectedSha !== undefined && input.expectedSha !== null && input.expectedSha.length > 0) {
        assertSafeSha(input.expectedSha);
        if (headSha !== input.expectedSha) {
          throw new ValidationError('Checked out commit does not match the expected revision', {
            expected: input.expectedSha,
            actual: headSha,
          });
        }
      }

      this.options.logger.info(
        { repository: input.repository.fullName, headSha },
        'workspace prepared',
      );

      return new LocalWorkspace({
        root: directory,
        headSha,
        logger: this.options.logger,
        maxFileBytes: this.options.maxFileBytes,
      });
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private resolveFetchRef(input: CreateWorkspaceInput): string {
    if (input.pullRequestNumber !== undefined && input.pullRequestNumber !== null) {
      if (!Number.isSafeInteger(input.pullRequestNumber) || input.pullRequestNumber <= 0) {
        throw new ValidationError('Unsafe pull request number', {
          number: input.pullRequestNumber,
        });
      }
      return `refs/pull/${input.pullRequestNumber}/head`;
    }
    const ref = input.ref ?? input.repository.defaultBranch;
    if (ref.length === 0) {
      throw new ValidationError('No git ref available to check out');
    }
    return ref;
  }
}
