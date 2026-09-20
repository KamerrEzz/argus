import type { AppConfig, Logger } from '@acr/config';
import { noopLogger, type GithubPublishPort, type GithubReadPort, type LoggerPort } from '@acr/shared';
import { GithubAppAuth } from './auth';
import { GithubHttpClient } from './http';
import { GithubInstallationClient } from './installations';
import { GithubPublishClient } from './publish-client';
import { GithubReadClient } from './read-client';

export interface GithubIntegration {
  readonly auth: GithubAppAuth;
  readonly read: GithubReadPort & { getRepository(input: {
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
  }> };
  readonly publish: GithubPublishPort;
  readonly installations: GithubInstallationClient;
}

export interface GithubIntegrationOptions {
  readonly config: AppConfig;
  readonly logger?: Logger | LoggerPort;
  readonly maxFileBytes?: number;
}

const USER_AGENT = 'ai-code-review-agent/0.1.0';

export function createGithubIntegration(options: GithubIntegrationOptions): GithubIntegration {
  const logger = (options.logger ?? noopLogger) as LoggerPort;
  const { config } = options;

  const auth = new GithubAppAuth(
    {
      appId: config.github.appId,
      privateKey: config.github.privateKey,
      apiBaseUrl: config.github.apiBaseUrl,
      requestTimeoutMs: config.github.requestTimeoutMs,
      tokenCacheSkewSeconds: config.github.tokenCacheSkewSeconds,
      maxRetries: 3,
      maxPages: config.github.maxPages,
      userAgent: USER_AGENT,
      fallbackToken: config.github.token,
    },
    logger,
  );

  const http = new GithubHttpClient({
    apiBaseUrl: config.github.apiBaseUrl,
    timeoutMs: config.github.requestTimeoutMs,
    maxRetries: 3,
    maxPages: config.github.maxPages,
    userAgent: USER_AGENT,
    logger,
  });

  const resolveToken = (installationId: number | null): Promise<string> =>
    auth.resolveToken(installationId);

  return {
    auth,
    read: new GithubReadClient({
      http,
      resolveToken,
      maxFileBytes: options.maxFileBytes ?? config.budgets.maxFileBytes,
      logger,
    }),
    publish: new GithubPublishClient({ http, resolveToken, logger }),
    installations: new GithubInstallationClient({ http, auth, logger }),
  };
}

export { GithubAppAuth } from './auth';
export { GithubHttpClient } from './http';
export { GithubInstallationClient } from './installations';
export { GithubPublishClient, CHECK_RUN_NAME } from './publish-client';
export { GithubReadClient } from './read-client';
export * from './webhook';
export * from './mappers';
export * from './schemas';
export { decodeJwtPayload, signRs256Jwt } from './jwt';
export type { InstallationToken, InstallationTokenResolver } from './auth';
