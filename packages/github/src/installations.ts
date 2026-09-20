import type { GithubInstallation, InstallationRepository, LoggerPort } from '@acr/shared';
import type { GithubHttpClient } from './http';
import type { GithubAppAuth } from './auth';
import { GithubInstallationRepositoriesSchema, GithubInstallationSchema } from './schemas';

const PAGE_SIZE = 100;

export interface GithubInstallationClientOptions {
  readonly http: GithubHttpClient;
  readonly auth: GithubAppAuth;
  readonly logger: LoggerPort;
}

export class GithubInstallationClient {
  private readonly options: GithubInstallationClientOptions;

  constructor(options: GithubInstallationClientOptions) {
    this.options = options;
  }

  async getInstallation(installationId: number): Promise<GithubInstallation> {
    const payload = await this.options.http.request({
      method: 'GET',
      path: `/app/installations/${installationId}`,
      token: this.options.auth.createAppJwt(),
      schema: GithubInstallationSchema,
    });
    return {
      id: payload.id,
      account: payload.account,
      repositorySelection: payload.repository_selection ?? 'selected',
    };
  }

  async listInstallations(): Promise<readonly GithubInstallation[]> {
    const token = this.options.auth.createAppJwt();
    const output: GithubInstallation[] = [];
    for (let page = 1; ; page += 1) {
      const payload = await this.options.http.request({
        method: 'GET',
        path: '/app/installations',
        token,
        query: { per_page: PAGE_SIZE, page },
      });
      if (!Array.isArray(payload)) {
        break;
      }
      for (const entry of payload) {
        const parsed = GithubInstallationSchema.safeParse(entry);
        if (parsed.success) {
          output.push({
            id: parsed.data.id,
            account: parsed.data.account,
            repositorySelection: parsed.data.repository_selection ?? 'selected',
          });
        }
      }
      if (payload.length < PAGE_SIZE) {
        break;
      }
    }
    return output;
  }

  async listRepositories(installationId: number): Promise<readonly InstallationRepository[]> {
    const token = await this.options.auth.resolveToken(installationId);
    const output: InstallationRepository[] = [];
    for (let page = 1; ; page += 1) {
      const payload = await this.options.http.request({
        method: 'GET',
        path: '/installation/repositories',
        token,
        query: { per_page: PAGE_SIZE, page },
        schema: GithubInstallationRepositoriesSchema,
      });
      for (const repository of payload.repositories) {
        output.push({
          id: repository.id,
          name: repository.name,
          fullName: repository.full_name,
          owner: repository.owner.login,
          private: repository.private,
          defaultBranch: repository.default_branch,
          language: repository.language ?? null,
        });
      }
      if (payload.repositories.length < PAGE_SIZE) {
        break;
      }
    }
    this.options.logger.debug({ installationId, count: output.length }, 'installation repositories listed');
    return output;
  }
}
