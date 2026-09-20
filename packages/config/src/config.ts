import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigError, type RawEnv, loadEnvFiles, parseEnv } from './env';
import { findWorkspaceRoot } from './paths';

export type SandboxMode = 'docker' | 'process' | 'off';
export type LlmProviderId = 'openai-compatible' | 'openai' | 'openrouter' | 'nan-builders';

export interface AppConfig {
  readonly env: 'development' | 'test' | 'production';
  readonly isProduction: boolean;
  readonly isTest: boolean;
  readonly log: {
    readonly level: RawEnv['LOG_LEVEL'];
    readonly pretty: boolean;
  };
  readonly api: {
    readonly port: number;
    readonly host: string;
    readonly publicUrl: string;
    readonly corsOrigins: readonly string[];
    readonly rateLimit: { readonly max: number; readonly windowMs: number };
  };
  readonly auth: {
    readonly secret: string;
    readonly sessionTtlSeconds: number;
    readonly cookieName: string;
    readonly secureCookies: boolean;
    readonly bootstrapAdmin: { email: string; password: string; name: string };
  };
  readonly database: {
    readonly url: string;
    readonly poolSize: number;
  };
  readonly redis: {
    readonly url: string;
    readonly keyPrefix: string;
  };
  readonly queue: {
    readonly reviewConcurrency: number;
    readonly commandConcurrency: number;
    readonly maxAttempts: number;
    readonly backoffMs: number;
    readonly jobTimeoutMs: number;
    readonly eventStreamMaxLen: number;
    readonly commandExecution: 'inline' | 'queued';
  };
  readonly worker: {
    /** Plain HTTP health endpoint for the worker container; 0 disables it. */
    readonly healthPort: number;
  };
  readonly github: {
    readonly appId: number | null;
    readonly appSlug: string;
    readonly privateKey: string;
    readonly privateKeyPath: string;
    readonly webhookSecret: string;
    readonly token: string;
    readonly apiBaseUrl: string;
    readonly tokenCacheSkewSeconds: number;
    readonly requestTimeoutMs: number;
    readonly maxPages: number;
  };
  readonly llm: {
    readonly provider: LlmProviderId;
    readonly apiKey: string;
    readonly baseUrl: string;
    readonly model: string;
    readonly temperature: number;
    readonly maxOutputTokens: number;
    readonly requestTimeoutMs: number;
    readonly maxRetries: number;
    readonly inputCostPer1kUsd: number;
    readonly outputCostPer1kUsd: number;
    /** OpenRouter app-attribution headers; empty when unset. */
    readonly httpReferer: string;
    readonly appTitle: string;
  };
  readonly sandbox: {
    readonly mode: SandboxMode;
    readonly image: string;
    readonly cpuLimit: number;
    readonly memoryLimit: string;
    readonly pidsLimit: number;
    readonly timeoutMs: number;
    readonly network: 'none' | 'bridge';
    readonly allowProcessSandbox: boolean;
    readonly workspaceRoot: string;
    readonly cloneDepth: number;
    readonly gitBinary: string;
    readonly dockerBinary: string;
  };
  readonly budgets: {
    readonly maxDurationMs: number;
    readonly maxFiles: number;
    readonly maxTokens: number;
    readonly maxToolCalls: number;
    readonly maxAgentIterations: number;
    readonly maxDiffBytes: number;
    readonly maxFileBytes: number;
    readonly minPublishConfidence: number;
  };
  readonly features: {
    readonly publishEnabled: boolean;
    readonly checkRunEnabled: boolean;
    readonly requireApprovalForPublish: boolean;
  };
  readonly workspaceRoot: string;
}

const REDACTED_KEYS = new Set([
  'secret',
  'privateKey',
  'webhookSecret',
  'apiKey',
  'password',
  'url',
  'databaseUrl',
]);

function resolveGitHubPrivateKey(raw: RawEnv, root: string): string {
  if (raw.GITHUB_PRIVATE_KEY.trim().length > 0) {
    return raw.GITHUB_PRIVATE_KEY;
  }
  if (raw.GITHUB_PRIVATE_KEY_PATH.trim().length === 0) {
    return '';
  }
  const candidate = resolve(root, raw.GITHUB_PRIVATE_KEY_PATH);
  if (!existsSync(candidate)) {
    return '';
  }
  return readFileSync(candidate, 'utf8');
}

export function createConfig(raw: RawEnv, options: { workspaceRoot?: string } = {}): AppConfig {
  const root = options.workspaceRoot ?? findWorkspaceRoot();
  const isProduction = raw.NODE_ENV === 'production';
  const appId = raw.GITHUB_APP_ID.trim();

  return {
    env: raw.NODE_ENV,
    isProduction,
    isTest: raw.NODE_ENV === 'test',
    log: {
      level: raw.LOG_LEVEL,
      pretty: raw.LOG_PRETTY && !isProduction,
    },
    api: {
      port: raw.API_PORT,
      host: raw.API_HOST,
      publicUrl: raw.API_PUBLIC_URL.replace(/\/$/, ''),
      corsOrigins: raw.CORS_ORIGINS,
      rateLimit: { max: raw.RATE_LIMIT_MAX, windowMs: raw.RATE_LIMIT_WINDOW_MS },
    },
    auth: {
      secret: raw.AUTH_SECRET,
      sessionTtlSeconds: raw.AUTH_SESSION_TTL_MINUTES * 60,
      cookieName: raw.AUTH_COOKIE_NAME,
      secureCookies: isProduction,
      bootstrapAdmin: {
        email: raw.BOOTSTRAP_ADMIN_EMAIL,
        password: raw.BOOTSTRAP_ADMIN_PASSWORD,
        name: raw.BOOTSTRAP_ADMIN_NAME,
      },
    },
    database: {
      url: raw.DATABASE_URL,
      poolSize: raw.DATABASE_POOL_SIZE,
    },
    redis: {
      url: raw.REDIS_URL,
      keyPrefix: raw.REDIS_KEY_PREFIX,
    },
    queue: {
      reviewConcurrency: raw.QUEUE_REVIEW_CONCURRENCY,
      commandConcurrency: raw.QUEUE_COMMAND_CONCURRENCY,
      maxAttempts: raw.QUEUE_MAX_ATTEMPTS,
      backoffMs: raw.QUEUE_BACKOFF_MS,
      jobTimeoutMs: raw.QUEUE_JOB_TIMEOUT_MS,
      eventStreamMaxLen: raw.QUEUE_EVENT_STREAM_MAXLEN,
      commandExecution: raw.REVIEW_COMMAND_EXECUTION,
    },
    worker: {
      healthPort: raw.WORKER_HEALTH_PORT,
    },
    github: {
      appId: appId.length > 0 && Number.isFinite(Number(appId)) ? Number(appId) : null,
      appSlug: raw.GITHUB_APP_SLUG,
      privateKey: resolveGitHubPrivateKey(raw, root),
      privateKeyPath: raw.GITHUB_PRIVATE_KEY_PATH,
      webhookSecret: raw.GITHUB_WEBHOOK_SECRET,
      token: raw.GITHUB_TOKEN,
      apiBaseUrl: raw.GITHUB_API_BASE_URL.replace(/\/$/, ''),
      tokenCacheSkewSeconds: raw.GITHUB_TOKEN_CACHE_SKEW_SECONDS,
      requestTimeoutMs: raw.GITHUB_REQUEST_TIMEOUT_MS,
      maxPages: raw.GITHUB_MAX_PAGES,
    },
    llm: {
      provider: raw.LLM_PROVIDER,
      apiKey: raw.LLM_API_KEY,
      baseUrl: raw.LLM_BASE_URL.replace(/\/$/, ''),
      model: raw.LLM_MODEL,
      temperature: raw.LLM_TEMPERATURE,
      maxOutputTokens: raw.LLM_MAX_OUTPUT_TOKENS,
      requestTimeoutMs: raw.LLM_REQUEST_TIMEOUT_MS,
      maxRetries: raw.LLM_MAX_RETRIES,
      inputCostPer1kUsd: raw.LLM_INPUT_COST_PER_1K_USD,
      outputCostPer1kUsd: raw.LLM_OUTPUT_COST_PER_1K_USD,
      httpReferer: raw.LLM_HTTP_REFERER,
      appTitle: raw.LLM_APP_TITLE,
    },
    sandbox: {
      mode: raw.SANDBOX_MODE,
      image: raw.SANDBOX_IMAGE,
      cpuLimit: raw.SANDBOX_CPU_LIMIT,
      memoryLimit: raw.SANDBOX_MEMORY_LIMIT,
      pidsLimit: raw.SANDBOX_PIDS_LIMIT,
      timeoutMs: raw.SANDBOX_TIMEOUT_MS,
      network: raw.SANDBOX_NETWORK,
      allowProcessSandbox: raw.ALLOW_PROCESS_SANDBOX,
      workspaceRoot: raw.WORKSPACE_ROOT,
      cloneDepth: raw.GIT_CLONE_DEPTH,
      gitBinary: raw.GIT_BINARY,
      dockerBinary: raw.DOCKER_BINARY,
    },
    budgets: {
      maxDurationMs: raw.REVIEW_MAX_DURATION_MS,
      maxFiles: raw.REVIEW_MAX_FILES,
      maxTokens: raw.REVIEW_MAX_TOKENS,
      maxToolCalls: raw.REVIEW_MAX_TOOL_CALLS,
      maxAgentIterations: raw.REVIEW_MAX_AGENT_ITERATIONS,
      maxDiffBytes: raw.REVIEW_MAX_DIFF_BYTES,
      maxFileBytes: raw.REVIEW_MAX_FILE_BYTES,
      minPublishConfidence: raw.REVIEW_MIN_PUBLISH_CONFIDENCE,
    },
    features: {
      publishEnabled: raw.REVIEW_PUBLISH_ENABLED,
      checkRunEnabled: raw.REVIEW_CHECK_RUN_ENABLED,
      requireApprovalForPublish: raw.REVIEW_REQUIRE_APPROVAL_FOR_PUBLISH,
    },
    workspaceRoot: root,
  };
}

export interface ReadinessIssue {
  readonly key: string;
  readonly message: string;
}

export function collectReadinessIssues(config: AppConfig): ReadinessIssue[] {
  const issues: ReadinessIssue[] = [];
  if (config.auth.secret.length < 16) {
    issues.push({ key: 'AUTH_SECRET', message: 'must be set to at least 16 characters' });
  }
  if (config.github.appId === null) {
    issues.push({ key: 'GITHUB_APP_ID', message: 'must be a numeric GitHub App id' });
  }
  if (config.github.privateKey.trim().length === 0) {
    issues.push({
      key: 'GITHUB_PRIVATE_KEY',
      message: 'must contain a PEM private key or GITHUB_PRIVATE_KEY_PATH must point to one',
    });
  }
  if (config.github.webhookSecret.length === 0) {
    issues.push({ key: 'GITHUB_WEBHOOK_SECRET', message: 'must be set to validate webhooks' });
  }
  if (config.llm.apiKey.length === 0) {
    issues.push({ key: 'LLM_API_KEY', message: 'must be set to run AI review stages' });
  }
  if (config.sandbox.mode === 'process' && !config.sandbox.allowProcessSandbox) {
    issues.push({
      key: 'SANDBOX_MODE',
      message: 'process mode requires ALLOW_PROCESS_SANDBOX=true because it is not isolated',
    });
  }
  return issues;
}

export function assertProductionReady(config: AppConfig): void {
  if (!config.isProduction) {
    return;
  }
  const issues = collectReadinessIssues(config);
  if (issues.length > 0) {
    throw new ConfigError(issues.map((issue) => `${issue.key}: ${issue.message}`));
  }
}

export function redactConfig(config: AppConfig): Record<string, unknown> {
  const walk = (value: unknown, key: string): unknown => {
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'string' && REDACTED_KEYS.has(key) && value.length > 0) {
        return '[REDACTED]';
      }
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((entry) => walk(entry, key));
    }
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      output[childKey] = walk(childValue, childKey);
    }
    return output;
  };
  return walk(config, 'config') as Record<string, unknown>;
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached === null) {
    loadEnvFiles();
    cached = createConfig(parseEnv());
  }
  return cached;
}

export function setConfig(config: AppConfig | null): void {
  cached = config;
}
