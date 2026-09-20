export const CHANGED_FILE_STATUSES = [
  'added',
  'modified',
  'removed',
  'renamed',
  'copied',
  'changed',
  'unchanged',
] as const;
export type ChangedFileStatus = (typeof CHANGED_FILE_STATUSES)[number];

export interface RepositoryRef {
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly installationId: number | null;
  readonly defaultBranch: string;
  readonly private: boolean;
}

export interface PullRequestInfo {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly author: string;
  readonly state: 'open' | 'closed' | 'merged';
  readonly draft: boolean;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly headRef: string;
  readonly headSha: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly url: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly mergedAt: string | null;
  readonly labels: readonly string[];
}

export interface ChangedFile {
  readonly path: string;
  readonly previousPath: string | null;
  readonly status: ChangedFileStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly patch: string | null;
  readonly binary: boolean;
}

export interface RepositoryTreeEntry {
  readonly path: string;
  readonly type: 'file' | 'directory' | 'submodule' | 'symlink';
  readonly size: number | null;
  readonly sha: string;
}

export interface FileContent {
  readonly path: string;
  readonly content: string | null;
  readonly encoding: 'utf-8' | 'base64' | 'none';
  readonly size: number;
  readonly truncated: boolean;
  readonly ref: string;
}

export interface CodeSearchMatch {
  readonly path: string;
  readonly line: number;
  readonly snippet: string;
}

export interface ReviewCommentRef {
  readonly id: number;
  readonly url: string;
  readonly body: string;
  readonly author: string;
  readonly createdAt: string;
}

export interface CheckRunRef {
  readonly id: number;
  readonly url: string | null;
}

export const CHECK_RUN_LIFECYCLE = ['queued', 'in_progress', 'completed'] as const;
export type CheckRunLifecycle = (typeof CHECK_RUN_LIFECYCLE)[number];

export interface GithubInstallationAccount {
  readonly login: string;
  readonly type: string;
}

export interface GithubInstallation {
  readonly id: number;
  readonly account: GithubInstallationAccount;
  readonly repositorySelection: string;
}

export interface InstallationRepository {
  readonly id: number;
  readonly name: string;
  readonly fullName: string;
  readonly owner: string;
  readonly private: boolean;
  readonly defaultBranch: string;
  readonly language: string | null;
}

export interface WebhookEnvelope {
  readonly deliveryId: string;
  readonly event: string;
  readonly action: string | null;
  readonly installationId: number | null;
  readonly repositoryFullName: string | null;
  readonly repositoryGithubId: number | null;
  readonly pullRequestNumber: number | null;
  readonly headSha: string | null;
  readonly sender: string | null;
}
