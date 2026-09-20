import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { findWorkspaceRoot } from './paths';

const booleanFromEnv = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === '') {
        return fallback;
      }
      return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
    });

const csvFromEnv = (fallback: string[] = []) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === '') {
        return fallback;
      }
      return value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    });

const multilineSecret = z
  .string()
  .optional()
  .transform((value) => (value === undefined ? '' : value.replace(/\\n/g, '\n')));

const RawEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: booleanFromEnv(false),

  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_HOST: z.string().min(1).default('0.0.0.0'),
  API_PUBLIC_URL: z.string().min(1).default('http://localhost:4000'),
  CORS_ORIGINS: csvFromEnv(['http://localhost:3000']),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(120),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),

  AUTH_SECRET: z.string().default(''),
  AUTH_SESSION_TTL_MINUTES: z.coerce.number().int().min(5).default(720),
  AUTH_COOKIE_NAME: z.string().min(1).default('acr_session'),
  BOOTSTRAP_ADMIN_EMAIL: z.string().default('admin@example.com'),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().default('change-me-please'),
  BOOTSTRAP_ADMIN_NAME: z.string().default('Admin'),

  DATABASE_URL: z.string().default('postgresql://acr:acr@localhost:5432/acr?schema=public'),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),

  REDIS_URL: z.string().default('redis://localhost:6379'),
  REDIS_KEY_PREFIX: z.string().default('acr'),

  QUEUE_REVIEW_CONCURRENCY: z.coerce.number().int().min(1).default(2),
  QUEUE_COMMAND_CONCURRENCY: z.coerce.number().int().min(1).default(2),
  QUEUE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  QUEUE_BACKOFF_MS: z.coerce.number().int().min(100).default(2000),
  QUEUE_JOB_TIMEOUT_MS: z.coerce.number().int().min(1000).default(1_800_000),
  QUEUE_EVENT_STREAM_MAXLEN: z.coerce.number().int().min(10).default(1000),
  REVIEW_COMMAND_EXECUTION: z.enum(['inline', 'queued']).default('inline'),

  /** 0 disables the plain HTTP endpoint a container orchestrator can probe. */
  WORKER_HEALTH_PORT: z.coerce.number().int().min(0).max(65535).default(9100),

  GITHUB_APP_ID: z.string().default(''),
  GITHUB_APP_SLUG: z.string().default(''),
  GITHUB_PRIVATE_KEY: multilineSecret,
  GITHUB_PRIVATE_KEY_PATH: z.string().default(''),
  GITHUB_WEBHOOK_SECRET: z.string().default(''),
  GITHUB_TOKEN: z.string().default(''),
  GITHUB_API_BASE_URL: z.string().default('https://api.github.com'),
  GITHUB_TOKEN_CACHE_SKEW_SECONDS: z.coerce.number().int().min(0).default(60),
  GITHUB_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).default(20_000),
  GITHUB_MAX_PAGES: z.coerce.number().int().min(1).max(100).default(10),

  LLM_PROVIDER: z
    .enum(['openai-compatible', 'openai', 'openrouter', 'nan-builders'])
    .default('openai-compatible'),
  LLM_API_KEY: z.string().default(''),
  LLM_BASE_URL: z.string().default(''),
  LLM_MODEL: z.string().default('gpt-4o-mini'),
  /** OpenRouter app-attribution headers; ignored by other providers. */
  LLM_HTTP_REFERER: z.string().default(''),
  LLM_APP_TITLE: z.string().default(''),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0),
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(16).default(4000),
  LLM_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120_000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(2),
  LLM_INPUT_COST_PER_1K_USD: z.coerce.number().min(0).default(0),
  LLM_OUTPUT_COST_PER_1K_USD: z.coerce.number().min(0).default(0),

  SANDBOX_MODE: z.enum(['docker', 'process', 'off']).default('docker'),
  SANDBOX_IMAGE: z.string().default('node:22-bookworm-slim'),
  SANDBOX_CPU_LIMIT: z.coerce.number().min(0.1).max(64).default(1),
  SANDBOX_MEMORY_LIMIT: z.string().default('1g'),
  SANDBOX_PIDS_LIMIT: z.coerce.number().int().min(16).default(256),
  SANDBOX_TIMEOUT_MS: z.coerce.number().int().min(1000).default(600_000),
  SANDBOX_NETWORK: z.enum(['none', 'bridge']).default('none'),
  ALLOW_PROCESS_SANDBOX: booleanFromEnv(false),
  WORKSPACE_ROOT: z.string().default('.work'),
  GIT_CLONE_DEPTH: z.coerce.number().int().min(1).max(1000).default(50),
  GIT_BINARY: z.string().default('git'),
  DOCKER_BINARY: z.string().default('docker'),

  REVIEW_MAX_DURATION_MS: z.coerce.number().int().min(1000).default(900_000),
  REVIEW_MAX_FILES: z.coerce.number().int().min(1).default(50),
  REVIEW_MAX_TOKENS: z.coerce.number().int().min(100).default(200_000),
  REVIEW_MAX_TOOL_CALLS: z.coerce.number().int().min(1).default(60),
  REVIEW_MAX_AGENT_ITERATIONS: z.coerce.number().int().min(1).max(100).default(12),
  REVIEW_MAX_DIFF_BYTES: z.coerce.number().int().min(1000).default(400_000),
  REVIEW_MAX_FILE_BYTES: z.coerce.number().int().min(1000).default(200_000),
  REVIEW_MIN_PUBLISH_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.6),
  REVIEW_PUBLISH_ENABLED: booleanFromEnv(true),
  REVIEW_CHECK_RUN_ENABLED: booleanFromEnv(true),
  REVIEW_REQUIRE_APPROVAL_FOR_PUBLISH: booleanFromEnv(false),
});

export type RawEnv = z.infer<typeof RawEnvSchema>;

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

let envLoaded = false;

export function loadEnvFiles(startDir: string = process.cwd(), override = false): void {
  if (envLoaded && !override) {
    return;
  }
  const root = findWorkspaceRoot(startDir);
  const candidates = [
    join(root, '.env'),
    join(root, `.env.${process.env.NODE_ENV ?? 'development'}`),
    join(root, '.env.local'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      loadDotenv({ path: candidate, override, quiet: true });
    }
  }
  envLoaded = true;
}

export function parseEnv(source: NodeJS.ProcessEnv = process.env): RawEnv {
  const result = RawEnvSchema.safeParse(source);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`),
    );
  }
  return result.data;
}
