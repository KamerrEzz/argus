import { describe, expect, it, vi } from 'vitest';
import { GithubPublishClient } from '@acr/github';
import type { GithubHttpClient } from '@acr/github';
import type { LoggerPort, RepositoryRef } from '@acr/shared';

const REPOSITORY: RepositoryRef = {
  owner: 'acme',
  name: 'widgets',
  fullName: 'acme/widgets',
  installationId: 42,
  defaultBranch: 'main',
  private: true,
};

function build() {
  const request = vi.fn().mockResolvedValue({
    id: 9001,
    body: 'posted',
    html_url: 'https://github.com/acme/widgets/pull/7#discussion_r9001',
    created_at: '2026-01-01T00:00:00Z',
    user: { login: 'acr-bot' },
  });
  const logger: LoggerPort = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  const publish = new GithubPublishClient({
    http: { request, paginate: vi.fn() } as unknown as GithubHttpClient,
    resolveToken: () => Promise.resolve('installation-token'),
    logger,
  });
  return { publish, request };
}

describe('GithubPublishClient.createReviewComment', () => {
  it('posts an inline comment on the right side of the diff', async () => {
    const { publish, request } = build();

    const ref = await publish.createReviewComment({
      repository: REPOSITORY,
      pullRequestNumber: 7,
      commitId: 'deadbeef',
      path: 'src/pricing.js',
      line: 12,
      startLine: null,
      body: 'body text',
    });

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        path: '/repos/acme/widgets/pulls/7/comments',
        token: 'installation-token',
        body: {
          body: 'body text',
          commit_id: 'deadbeef',
          path: 'src/pricing.js',
          line: 12,
          side: 'RIGHT',
        },
      }),
    );
    expect(ref).toMatchObject({
      id: 9001,
      url: 'https://github.com/acme/widgets/pull/7#discussion_r9001',
    });
  });

  it('anchors a whole range when the finding spans lines', async () => {
    const { publish, request } = build();

    await publish.createReviewComment({
      repository: REPOSITORY,
      pullRequestNumber: 7,
      commitId: 'deadbeef',
      path: 'src/pricing.js',
      line: 14,
      startLine: 12,
      body: 'body text',
    });

    const body = request.mock.calls[0]?.[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      line: 14,
      start_line: 12,
      start_side: 'RIGHT',
    });
  });

  it('leaves the summary comment on the issues endpoint', async () => {
    const { publish, request } = build();

    await publish.createComment({
      repository: REPOSITORY,
      pullRequestNumber: 7,
      body: 'summary',
    });

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/repos/acme/widgets/issues/7/comments' }),
    );
  });
});
