import {
  ValidationError,
  isSafeRelativePath,
  normalizeRepoPath,
  type ChangedFile,
  type CodeSearchMatch,
  type FileContent,
  type GithubReadPort,
  type LoggerPort,
  type PullRequestInfo,
  type RepositoryRef,
  type RepositoryTreeEntry,
} from '@acr/shared';
import type { GithubHttpClient } from './http';
import type { InstallationTokenResolver } from './auth';
import {
  GithubBlobSchema,
  GithubContentSchema,
  GithubPullRequestFileSchema,
  GithubPullRequestSchema,
  GithubRepositorySchema,
  GithubSearchCodeSchema,
  GithubTreeSchema,
} from './schemas';
import {
  decodeBase64Content,
  toChangedFile,
  toCodeSearchMatches,
  toFileContent,
  toPullRequestInfo,
  toTreeEntry,
} from './mappers';

const MAX_FILES_PER_PULL_REQUEST = 300;
const MAX_TREE_ENTRIES = 5000;
const MAX_SEARCH_FILES = 10;

export interface GithubReadClientOptions {
  readonly http: GithubHttpClient;
  readonly resolveToken: InstallationTokenResolver;
  readonly maxFileBytes: number;
  readonly logger: LoggerPort;
}

function encodeRepoPath(path: string): string {
  return normalizeRepoPath(path)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export class GithubReadClient implements GithubReadPort {
  private readonly options: GithubReadClientOptions;

  constructor(options: GithubReadClientOptions) {
    this.options = options;
  }

  private repoPath(repository: RepositoryRef): string {
    return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
  }

  async getPullRequest(input: {
    readonly repository: RepositoryRef;
    readonly number: number;
  }): Promise<PullRequestInfo> {
    const token = await this.options.resolveToken(input.repository.installationId);
    const payload = await this.options.http.request({
      method: 'GET',
      path: `${this.repoPath(input.repository)}/pulls/${input.number}`,
      token,
      schema: GithubPullRequestSchema,
    });
    return toPullRequestInfo(payload);
  }

  async getPullRequestDiff(input: {
    readonly repository: RepositoryRef;
    readonly number: number;
  }): Promise<string> {
    const token = await this.options.resolveToken(input.repository.installationId);
    const diff = await this.options.http.requestText({
      method: 'GET',
      path: `${this.repoPath(input.repository)}/pulls/${input.number}`,
      token,
      accept: 'application/vnd.github.diff',
    });
    return diff;
  }

  async getChangedFiles(input: {
    readonly repository: RepositoryRef;
    readonly number: number;
  }): Promise<readonly ChangedFile[]> {
    const token = await this.options.resolveToken(input.repository.installationId);
    const payloads = await this.options.http.paginate({
      path: `${this.repoPath(input.repository)}/pulls/${input.number}/files`,
      token,
      schema: GithubPullRequestFileSchema,
      maxItems: MAX_FILES_PER_PULL_REQUEST,
    });
    return payloads.map(toChangedFile);
  }

  async getFileContent(input: {
    readonly repository: RepositoryRef;
    readonly path: string;
    readonly ref: string;
  }): Promise<FileContent> {
    const normalized = normalizeRepoPath(input.path);
    if (!isSafeRelativePath(normalized)) {
      throw new ValidationError('Unsafe repository path', { path: input.path });
    }
    const token = await this.options.resolveToken(input.repository.installationId);
    const payload = await this.options.http.request({
      method: 'GET',
      path: `${this.repoPath(input.repository)}/contents/${encodeRepoPath(normalized)}`,
      token,
      query: { ref: input.ref },
      schema: GithubContentSchema,
    });

    if (payload.type !== 'file') {
      throw new ValidationError('Requested path is not a file', { path: normalized, type: payload.type });
    }

    const maxBytes = this.options.maxFileBytes;
    const truncated = payload.size > maxBytes;

    if (payload.encoding === 'base64' && payload.content !== undefined && payload.content.length > 0) {
      const decoded = decodeBase64Content(payload.content);
      return toFileContent({
        path: normalized,
        ref: input.ref,
        size: payload.size,
        content: truncated ? decoded.slice(0, maxBytes) : decoded,
        truncated,
        encoding: 'utf-8',
      });
    }

    const blob = await this.options.http.request({
      method: 'GET',
      path: `${this.repoPath(input.repository)}/git/blobs/${payload.sha}`,
      token,
      schema: GithubBlobSchema,
    });
    const decoded = blob.encoding === 'base64' ? decodeBase64Content(blob.content) : blob.content;
    return toFileContent({
      path: normalized,
      ref: input.ref,
      size: payload.size,
      content: truncated ? decoded.slice(0, maxBytes) : decoded,
      truncated,
      encoding: 'utf-8',
    });
  }

  async searchRepository(input: {
    readonly repository: RepositoryRef;
    readonly query: string;
    readonly limit: number;
  }): Promise<readonly CodeSearchMatch[]> {
    const query = input.query.trim();
    if (query.length < 3) {
      throw new ValidationError('Search query must be at least 3 characters', { query });
    }
    const token = await this.options.resolveToken(input.repository.installationId);
    const limit = Math.min(Math.max(input.limit, 1), MAX_SEARCH_FILES);
    const search = await this.options.http.request({
      method: 'GET',
      path: '/search/code',
      token,
      query: { q: `${query} repo:${input.repository.fullName}` },
      schema: GithubSearchCodeSchema,
    });

    const paths = search.items.slice(0, limit).map((item) => normalizeRepoPath(item.path));
    if (paths.length === 0) {
      return [];
    }

    const contents: { path: string; content: string }[] = [];
    for (const path of paths) {
      try {
        const file = await this.getFileContent({
          repository: input.repository,
          path,
          ref: input.repository.defaultBranch,
        });
        if (file.content !== null && !file.truncated) {
          contents.push({ path, content: file.content });
        }
      } catch (error) {
        this.options.logger.debug(
          { path, reason: error instanceof Error ? error.message : 'unknown' },
          'code search could not read candidate file',
        );
      }
    }
    return toCodeSearchMatches(contents, query);
  }

  async getRepositoryTree(input: {
    readonly repository: RepositoryRef;
    readonly ref: string;
  }): Promise<readonly RepositoryTreeEntry[]> {
    const token = await this.options.resolveToken(input.repository.installationId);
    const payload = await this.options.http.request({
      method: 'GET',
      path: `${this.repoPath(input.repository)}/git/trees/${encodeURIComponent(input.ref)}`,
      token,
      query: { recursive: 1 },
      schema: GithubTreeSchema,
    });

    if (payload.truncated === true) {
      this.options.logger.warn(
        { repository: input.repository.fullName, ref: input.ref },
        'repository tree truncated by GitHub, falling back to root listing',
      );
      const root = await this.options.http.request({
        method: 'GET',
        path: `${this.repoPath(input.repository)}/git/trees/${encodeURIComponent(input.ref)}`,
        token,
        schema: GithubTreeSchema,
      });
      return root.tree.slice(0, MAX_TREE_ENTRIES).map(toTreeEntry);
    }
    return payload.tree.slice(0, MAX_TREE_ENTRIES).map(toTreeEntry);
  }

  async getRepository(input: {
    readonly owner: string;
    readonly name: string;
    readonly installationId: number | null;
  }): Promise<{
    id: number;
    fullName: string;
    owner: string;
    name: string;
    defaultBranch: string;
    isPrivate: boolean;
    language: string | null;
  }> {
    const token = await this.options.resolveToken(input.installationId);
    const payload = await this.options.http.request({
      method: 'GET',
      path: `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.name)}`,
      token,
      schema: GithubRepositorySchema,
    });
    return {
      id: payload.id,
      fullName: payload.full_name,
      owner: payload.owner.login,
      name: payload.name,
      defaultBranch: payload.default_branch,
      isPrivate: payload.private,
      language: payload.language ?? null,
    };
  }
}
