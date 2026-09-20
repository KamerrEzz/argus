import {
  GitHubApiError,
  NotFoundError,
  RateLimitError,
  UnauthorizedError,
  ValidationError,
  isAppError,
  safeStringify,
  truncate,
  type LoggerPort,
} from '@acr/shared';
import type { ZodType } from 'zod';
import { z } from 'zod';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface GithubHttpOptions {
  readonly apiBaseUrl: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly maxPages: number;
  readonly userAgent: string;
  readonly logger: LoggerPort;
}

export interface GithubRequestInput {
  readonly method: HttpMethod;
  readonly path: string;
  readonly token: string;
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly body?: unknown;
  readonly accept?: string;
}

export interface GithubRequestWithSchema<T> extends GithubRequestInput {
  readonly schema: ZodType<T>;
}

const RETRY_BASE_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 15_000;

function parseRetryAfter(headers: Headers): number | null {
  const retryAfter = headers.get('retry-after');
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
    }
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) {
      return Math.min(Math.max(0, date - Date.now()), MAX_RETRY_DELAY_MS);
    }
  }
  const reset = headers.get('x-ratelimit-reset');
  if (reset !== null) {
    const resetMs = Number(reset) * 1000;
    if (Number.isFinite(resetMs)) {
      return Math.min(Math.max(0, resetMs - Date.now()), MAX_RETRY_DELAY_MS);
    }
  }
  return null;
}

function backoffDelay(attempt: number): number {
  const exponential = RETRY_BASE_DELAY_MS * 2 ** attempt;
  const jitter = Math.random() * RETRY_BASE_DELAY_MS;
  return Math.min(exponential + jitter, MAX_RETRY_DELAY_MS);
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class GithubHttpClient {
  private readonly options: GithubHttpOptions;

  constructor(options: GithubHttpOptions) {
    this.options = options;
  }

  private buildUrl(
    path: string,
    query: Readonly<Record<string, string | number | undefined>> | undefined,
  ): string {
    const url = new URL(`${this.options.apiBaseUrl}${path}`);
    if (query !== undefined) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  private async executeRequest(
    input: GithubRequestInput,
    attempt: number,
  ): Promise<Response> {
    const url = this.buildUrl(input.path, input.query);
    const headers: Record<string, string> = {
      accept: input.accept ?? 'application/vnd.github+json',
      'user-agent': this.options.userAgent,
      'x-github-api-version': '2022-11-28',
      authorization: `Bearer ${input.token}`,
    };
    if (input.body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    let response: Response;
    try {
      // SSRF trust boundary: the outbound host is operator-controlled.
      // `apiBaseUrl` comes from GITHUB_API_BASE_URL, and repository input only
      // ever reaches path segments (owner/name are charset-validated before any
      // request or clone). fetch follows redirects by default and the target is
      // not re-validated here, so pointing GITHUB_API_BASE_URL at an untrusted
      // host, or a trusted host redirecting off-origin, remains a residual SSRF
      // surface. Documented limitation — not silently treated as covered.
      response = await fetch(url, {
        method: input.method,
        headers,
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      if (attempt < this.options.maxRetries) {
        await sleep(backoffDelay(attempt));
        return this.executeRequest(input, attempt + 1);
      }
      throw new GitHubApiError(`Request to ${input.method} ${input.path} failed`, {
        retryable: true,
        details: { reason: (error as Error).message },
        cause: error,
      });
    }

    if (!response.ok) {
      const retryable = isRetryable(response.status);
      if (retryable && attempt < this.options.maxRetries) {
        const retryAfter = parseRetryAfter(response.headers);
        this.options.logger.warn(
          { status: response.status, path: input.path, attempt },
          'github request failed, retrying',
        );
        await response.text();
        await sleep(retryAfter ?? backoffDelay(attempt));
        return this.executeRequest(input, attempt + 1);
      }
      throw await this.translateError(response, input);
    }

    return response;
  }

  private async translateError(response: Response, input: GithubRequestInput): Promise<Error> {
    const text = truncate(await response.text().catch(() => ''), 2000);
    const remaining = response.headers.get('x-ratelimit-remaining');
    const retryAfter = response.headers.get('retry-after');
    const context = {
      status: response.status,
      method: input.method,
      path: input.path,
      body: text.length > 0 ? safeStringify(text, 500) : undefined,
    };

    if (response.status === 404) {
      return new NotFoundError('GitHub resource', context);
    }
    if (response.status === 401) {
      return new UnauthorizedError('GitHub rejected the provided credentials');
    }
    if (response.status === 429 || (response.status === 403 && remaining === '0')) {
      return new RateLimitError('GitHub rate limit reached', {
        ...context,
        retryAfter,
      });
    }
    if (response.status === 422 || response.status === 400) {
      return new ValidationError('GitHub rejected the request payload', context);
    }
    return new GitHubApiError(`Request failed with status ${response.status}`, {
      status: response.status,
      details: context,
      retryable: isRetryable(response.status),
    });
  }

  async request<T>(input: GithubRequestWithSchema<T>): Promise<T>;
  async request(input: GithubRequestInput): Promise<unknown>;
  async request<T>(input: GithubRequestWithSchema<T> | GithubRequestInput): Promise<T | unknown> {
    const response = await this.executeRequest(input, 0);
    const payload: unknown = await response.json().catch(() => null);
    if ('schema' in input && input.schema !== undefined) {
      const parsed = input.schema.safeParse(payload);
      if (!parsed.success) {
        throw new GitHubApiError('Unexpected GitHub response shape', {
          details: {
            path: input.path,
            issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
          },
        });
      }
      return parsed.data;
    }
    return payload;
  }

  async requestText(input: GithubRequestInput): Promise<string> {
    const response = await this.executeRequest(input, 0);
    return response.text();
  }

  async paginate<T>(
    input: Omit<GithubRequestWithSchema<T>, 'method'> & { readonly maxItems?: number },
  ): Promise<T[]> {
    const perPage = 100;
    const maxItems = input.maxItems ?? Number.POSITIVE_INFINITY;
    const pageSchema = z.array(input.schema);
    const output: T[] = [];

    for (let page = 1; page <= this.options.maxPages; page += 1) {
      const chunk = await this.request({
        method: 'GET',
        path: input.path,
        token: input.token,
        ...(input.accept === undefined ? {} : { accept: input.accept }),
        query: { ...(input.query ?? {}), per_page: perPage, page },
        schema: pageSchema,
      });
      if (!Array.isArray(chunk)) {
        break;
      }
      for (const item of chunk) {
        output.push(item);
        if (output.length >= maxItems) {
          return output;
        }
      }
      if (chunk.length < perPage) {
        break;
      }
    }
    return output;
  }
}

export function toAppError(error: unknown, fallback: string): Error {
  return isAppError(error) ? error : new GitHubApiError(fallback, { cause: error });
}
