import {
  REVIEW_COMMENT_MARKER,
  type CheckRunConclusion,
  type CheckRunRef,
  type GithubPublishPort,
  type LoggerPort,
  type RepositoryRef,
  type ReviewCommentRef,
} from '@acr/shared';
import type { GithubHttpClient } from './http';
import type { InstallationTokenResolver } from './auth';
import { GithubCheckRunSchema, GithubIssueCommentSchema } from './schemas';
import { toReviewComment } from './mappers';

const CHECK_RUN_NAME = 'AI Code Review';
const MAX_COMMENT_PAGES_ITEMS = 500;

export interface GithubPublishClientOptions {
  readonly http: GithubHttpClient;
  readonly resolveToken: InstallationTokenResolver;
  readonly logger: LoggerPort;
}

export class GithubPublishClient implements GithubPublishPort {
  private readonly options: GithubPublishClientOptions;

  constructor(options: GithubPublishClientOptions) {
    this.options = options;
  }

  private repoPath(repository: RepositoryRef): string {
    return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
  }

  async findSummaryComment(input: {
    readonly repository: RepositoryRef;
    readonly pullRequestNumber: number;
  }): Promise<ReviewCommentRef | null> {
    const token = await this.options.resolveToken(input.repository.installationId);
    const comments = await this.options.http.paginate({
      path: `${this.repoPath(input.repository)}/issues/${input.pullRequestNumber}/comments`,
      token,
      schema: GithubIssueCommentSchema,
      maxItems: MAX_COMMENT_PAGES_ITEMS,
    });

    const match = comments
      .filter((comment) => (comment.body ?? '').includes(REVIEW_COMMENT_MARKER))
      .sort((left, right) => left.created_at.localeCompare(right.created_at))
      .at(-1);

    return match === undefined ? null : toReviewComment(match);
  }

  async createComment(input: {
    readonly repository: RepositoryRef;
    readonly pullRequestNumber: number;
    readonly body: string;
  }): Promise<ReviewCommentRef> {
    const token = await this.options.resolveToken(input.repository.installationId);
    const payload = await this.options.http.request({
      method: 'POST',
      path: `${this.repoPath(input.repository)}/issues/${input.pullRequestNumber}/comments`,
      token,
      body: { body: input.body },
      schema: GithubIssueCommentSchema,
    });
    return toReviewComment(payload);
  }

  async updateComment(input: {
    readonly repository: RepositoryRef;
    readonly commentId: number;
    readonly body: string;
  }): Promise<ReviewCommentRef> {
    const token = await this.options.resolveToken(input.repository.installationId);
    const payload = await this.options.http.request({
      method: 'PATCH',
      path: `${this.repoPath(input.repository)}/issues/comments/${input.commentId}`,
      token,
      body: { body: input.body },
      schema: GithubIssueCommentSchema,
    });
    return toReviewComment(payload);
  }

  /**
   * One inline comment on a line of the pull request diff. The response is a
   * review-comment object with the same fields the issue-comment schema checks.
   */
  async createReviewComment(input: {
    readonly repository: RepositoryRef;
    readonly pullRequestNumber: number;
    readonly commitId: string;
    readonly path: string;
    readonly line: number;
    readonly startLine: number | null;
    readonly body: string;
  }): Promise<ReviewCommentRef> {
    const token = await this.options.resolveToken(input.repository.installationId);
    const payload = await this.options.http.request({
      method: 'POST',
      path: `${this.repoPath(input.repository)}/pulls/${input.pullRequestNumber}/comments`,
      token,
      body: {
        body: input.body,
        commit_id: input.commitId,
        path: input.path,
        line: input.line,
        side: 'RIGHT',
        ...(input.startLine === null
          ? {}
          : { start_line: input.startLine, start_side: 'RIGHT' }),
      },
      schema: GithubIssueCommentSchema,
    });
    return toReviewComment(payload);
  }

  async createCheckRun(input: {
    readonly repository: RepositoryRef;
    readonly headSha: string;
    readonly name: string;
    readonly conclusion: CheckRunConclusion;
    readonly title: string;
    readonly summary: string;
    readonly text: string;
    readonly detailsUrl: string | null;
  }): Promise<CheckRunRef> {
    const token = await this.options.resolveToken(input.repository.installationId);
    const payload = await this.options.http.request({
      method: 'POST',
      path: `${this.repoPath(input.repository)}/check-runs`,
      token,
      body: {
        name: input.name.length > 0 ? input.name : CHECK_RUN_NAME,
        head_sha: input.headSha,
        status: 'completed',
        conclusion: input.conclusion,
        ...(input.detailsUrl === null ? {} : { details_url: input.detailsUrl }),
        output: {
          title: input.title,
          summary: input.summary,
          text: input.text,
        },
      },
      schema: GithubCheckRunSchema,
    });
    return { id: payload.id, url: payload.html_url ?? null };
  }

  async updateCheckRun(input: {
    readonly repository: RepositoryRef;
    readonly checkRunId: number;
    readonly conclusion: CheckRunConclusion;
    readonly title: string;
    readonly summary: string;
    readonly text: string;
  }): Promise<CheckRunRef> {
    const token = await this.options.resolveToken(input.repository.installationId);
    const payload = await this.options.http.request({
      method: 'PATCH',
      path: `${this.repoPath(input.repository)}/check-runs/${input.checkRunId}`,
      token,
      body: {
        status: 'completed',
        conclusion: input.conclusion,
        output: {
          title: input.title,
          summary: input.summary,
          text: input.text,
        },
      },
      schema: GithubCheckRunSchema,
    });
    return { id: payload.id, url: payload.html_url ?? null };
  }
}

export { CHECK_RUN_NAME };
