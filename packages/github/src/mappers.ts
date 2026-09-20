import {
  ValidationError,
  normalizeRepoPath,
  type ChangedFile,
  type ChangedFileStatus,
  type CodeSearchMatch,
  type FileContent,
  type PullRequestInfo,
  type RepositoryTreeEntry,
  type ReviewCommentRef,
} from '@acr/shared';
import type { GithubIssueCommentPayload, GithubPullRequestFilePayload, GithubPullRequestPayload } from './schemas';

const FILE_STATUS_MAP: Record<string, ChangedFileStatus> = {
  added: 'added',
  modified: 'modified',
  removed: 'removed',
  renamed: 'renamed',
  copied: 'copied',
  changed: 'changed',
  unchanged: 'unchanged',
};

export function toChangedFileStatus(status: string): ChangedFileStatus {
  const mapped = FILE_STATUS_MAP[status];
  if (mapped === undefined) {
    throw new ValidationError('Unsupported pull request file status', { status });
  }
  return mapped;
}

export function toPullRequestInfo(payload: GithubPullRequestPayload): PullRequestInfo {
  const labels = (payload.labels ?? [])
    .map((label) => (typeof label === 'string' ? label : label.name))
    .filter((label) => label.length > 0);

  const state: PullRequestInfo['state'] =
    payload.merged === true || payload.merged_at !== null && payload.merged_at !== undefined
      ? 'merged'
      : payload.state === 'open'
        ? 'open'
        : 'closed';

  return {
    id: payload.id,
    number: payload.number,
    title: payload.title,
    body: payload.body ?? '',
    author: payload.user?.login ?? 'unknown',
    state,
    draft: payload.draft ?? false,
    baseRef: payload.base.ref,
    baseSha: payload.base.sha,
    headRef: payload.head.ref,
    headSha: payload.head.sha,
    additions: payload.additions ?? 0,
    deletions: payload.deletions ?? 0,
    changedFiles: payload.changed_files ?? 0,
    url: payload.html_url,
    createdAt: payload.created_at,
    updatedAt: payload.updated_at,
    mergedAt: payload.merged_at ?? null,
    labels,
  };
}

export function toChangedFile(payload: GithubPullRequestFilePayload): ChangedFile {
  const patch = payload.patch ?? null;
  return {
    path: normalizeRepoPath(payload.filename),
    previousPath:
      payload.previous_filename === undefined ? null : normalizeRepoPath(payload.previous_filename),
    status: toChangedFileStatus(payload.status),
    additions: payload.additions,
    deletions: payload.deletions,
    patch,
    binary: payload.binary === true || patch === null,
  };
}

const TREE_ENTRY_TYPES: Record<string, RepositoryTreeEntry['type']> = {
  blob: 'file',
  tree: 'directory',
  commit: 'submodule',
};

export function toTreeEntry(payload: {
  path: string;
  type: string;
  sha: string;
  size?: number | undefined;
}): RepositoryTreeEntry {
  return {
    path: normalizeRepoPath(payload.path),
    type: TREE_ENTRY_TYPES[payload.type] ?? 'file',
    size: payload.size ?? null,
    sha: payload.sha,
  };
}

export function decodeBase64Content(content: string): string {
  return Buffer.from(content.replace(/\s/g, ''), 'base64').toString('utf8');
}

export function toFileContent(input: {
  path: string;
  ref: string;
  size: number;
  content: string | null;
  truncated: boolean;
  encoding: FileContent['encoding'];
}): FileContent {
  return {
    path: normalizeRepoPath(input.path),
    content: input.content,
    encoding: input.encoding,
    size: input.size,
    truncated: input.truncated,
    ref: input.ref,
  };
}

export function toReviewComment(payload: GithubIssueCommentPayload): ReviewCommentRef {
  return {
    id: payload.id,
    url: payload.html_url,
    body: payload.body ?? '',
    author: payload.user?.login ?? 'unknown',
    createdAt: payload.created_at,
  };
}

export function toCodeSearchMatches(
  files: readonly { readonly path: string; readonly content: string }[],
  query: string,
  limitPerFile = 3,
): CodeSearchMatch[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return [];
  }
  const matches: CodeSearchMatch[] = [];
  for (const file of files) {
    const lines = file.content.split('\n');
    let found = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      if (line.toLowerCase().includes(needle)) {
        matches.push({
          path: normalizeRepoPath(file.path),
          line: index + 1,
          snippet: line.trim().slice(0, 400),
        });
        found += 1;
        if (found >= limitPerFile) {
          break;
        }
      }
    }
  }
  return matches;
}
