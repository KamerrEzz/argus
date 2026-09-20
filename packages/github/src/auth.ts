import {
  ConfigurationError,
  GitHubApiError,
  noopLogger,
  type LoggerPort,
} from '@acr/shared';
import { GithubHttpClient } from './http';
import { signRs256Jwt } from './jwt';
import { GithubInstallationTokenSchema } from './schemas';

export interface GithubAuthConfig {
  readonly appId: number | null;
  readonly privateKey: string;
  readonly apiBaseUrl: string;
  readonly requestTimeoutMs: number;
  readonly tokenCacheSkewSeconds: number;
  readonly maxRetries: number;
  readonly maxPages: number;
  readonly userAgent: string;
  readonly fallbackToken: string;
}

export interface InstallationToken {
  readonly token: string;
  readonly expiresAt: Date;
}

interface CachedToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

const JWT_LIFETIME_SECONDS = 9 * 60;
const JWT_CLOCK_SKEW_SECONDS = 60;

export class GithubAppAuth {
  private readonly config: GithubAuthConfig;
  private readonly http: GithubHttpClient;
  private readonly logger: LoggerPort;
  private readonly cache = new Map<number, CachedToken>();
  private readonly inflight = new Map<number, Promise<InstallationToken>>();

  constructor(config: GithubAuthConfig, logger: LoggerPort = noopLogger) {
    this.config = config;
    this.logger = logger;
    this.http = new GithubHttpClient({
      apiBaseUrl: config.apiBaseUrl,
      timeoutMs: config.requestTimeoutMs,
      maxRetries: config.maxRetries,
      maxPages: config.maxPages,
      userAgent: config.userAgent,
      logger,
    });
  }

  get fallbackToken(): string {
    return this.config.fallbackToken;
  }

  private requireAppId(): number {
    if (this.config.appId === null) {
      throw new ConfigurationError('GITHUB_APP_ID is not configured');
    }
    return this.config.appId;
  }

  private requirePrivateKey(): string {
    if (this.config.privateKey.trim().length === 0) {
      throw new ConfigurationError(
        'GITHUB_PRIVATE_KEY (or GITHUB_PRIVATE_KEY_PATH) is not configured',
      );
    }
    return this.config.privateKey;
  }

  createAppJwt(nowSeconds: number = Math.floor(Date.now() / 1000)): string {
    const appId = this.requireAppId();
    return signRs256Jwt(
      {
        iss: String(appId),
        iat: nowSeconds - JWT_CLOCK_SKEW_SECONDS,
        exp: nowSeconds + JWT_LIFETIME_SECONDS,
      },
      this.requirePrivateKey(),
    );
  }

  async getInstallationToken(
    installationId: number,
    options: { readonly forceRefresh?: boolean } = {},
  ): Promise<InstallationToken> {
    const cached = this.cache.get(installationId);
    const now = Date.now();
    if (
      options.forceRefresh !== true &&
      cached !== undefined &&
      cached.expiresAtMs - this.config.tokenCacheSkewSeconds * 1000 > now
    ) {
      return { token: cached.token, expiresAt: new Date(cached.expiresAtMs) };
    }

    if (options.forceRefresh !== true) {
      const existing = this.inflight.get(installationId);
      if (existing !== undefined) {
        return existing;
      }
    }

    const request = this.fetchInstallationToken(installationId).finally(() => {
      this.inflight.delete(installationId);
    });
    this.inflight.set(installationId, request);
    return request;
  }

  private async fetchInstallationToken(installationId: number): Promise<InstallationToken> {
    try {
      const response = await this.http.request({
        method: 'POST',
        path: `/app/installations/${installationId}/access_tokens`,
        token: this.createAppJwt(),
        schema: GithubInstallationTokenSchema,
      });
      const expiresAt = new Date(response.expires_at);
      this.cache.set(installationId, { token: response.token, expiresAtMs: expiresAt.getTime() });
      this.logger.debug(
        { installationId, expiresAt: expiresAt.toISOString() },
        'installation access token issued',
      );
      return { token: response.token, expiresAt };
    } catch (error) {
      this.logger.error({ installationId }, 'cannot create installation access token');
      throw new GitHubApiError('Could not create installation access token', {
        cause: error,
        retryable: true,
      });
    }
  }

  /**
   * Resolves the credential for a repository. Repositories registered without an
   * installation id can only be reached through an explicitly configured token.
   */
  async resolveToken(installationId: number | null): Promise<string> {
    if (installationId !== null) {
      const { token } = await this.getInstallationToken(installationId);
      return token;
    }
    if (this.config.fallbackToken.trim().length > 0) {
      return this.config.fallbackToken;
    }
    throw new ConfigurationError(
      'Repository has no GitHub App installation and GITHUB_TOKEN is not configured',
    );
  }

  invalidate(installationId: number): void {
    this.cache.delete(installationId);
  }

  clear(): void {
    this.cache.clear();
  }

  cachedInstallationIds(): number[] {
    return [...this.cache.keys()];
  }
}

export type InstallationTokenResolver = (installationId: number | null) => Promise<string>;
