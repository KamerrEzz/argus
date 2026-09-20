import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Minimal .env reader for the e2e process. Importing @acr/config would also
 * work, but its side effects (logger creation) do not belong in a test runner;
 * twenty lines of parsing keep the dependency surface at zero.
 */
function loadDotEnv(): void {
  const path = join(process.cwd(), '.env');
  if (!existsSync(path)) {
    return;
  }
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }
    const equals = trimmed.indexOf('=');
    if (equals <= 0) {
      continue;
    }
    const key = trimmed.slice(0, equals).trim();
    const value = trimmed.slice(equals + 1).trim();
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value.length === 0) {
    throw new Error(`e2e needs ${name} (repo .env or environment)`);
  }
  return value;
}

// The browser talks to the API through the same host the dashboard itself
// was built with (NEXT_PUBLIC_API_URL, default http://localhost:4000): the
// session cookie belongs to that host, and CORS only allows it.
export const API_URL = 'http://localhost:4000';
export const DATABASE_URL = required('DATABASE_URL');
export const REDIS_URL = required('REDIS_URL', 'redis://127.0.0.1:6379');
export const REDIS_PREFIX = required('REDIS_KEY_PREFIX', 'acr:dev');

export const ADMIN_EMAIL = 'admin@example.com';
export const ADMIN_PASSWORD = 'change-me-please';
export const REVIEWER_EMAIL = 'reviewer@example.com';
export const REVIEWER_PASSWORD = 'reviewer-password';

/** Seed UUIDs (packages/database/src/seed.ts) — the only rows FK-bound setup may reference. */
export const SEED = {
  adminId: '11111111-1111-4111-8111-111111111111',
  reviewerId: '22222222-2222-4222-8222-222222222222',
  repositoryApiId: '33333333-3333-4333-8333-333333333333',
  pullRequestSqlId: '55555555-5555-4555-8555-555555555555',
  pullRequestAuthId: '77777777-7777-4777-8777-777777777777',
  reviewCompletedId: '88888888-8888-4888-8888-888888888888',
  reviewFailedId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
} as const;
