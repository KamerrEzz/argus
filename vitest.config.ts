import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const alias = {
  '@acr/config': resolve(__dirname, 'packages/config/src/index.ts'),
  '@acr/shared': resolve(__dirname, 'packages/shared/src/index.ts'),
  '@acr/database': resolve(__dirname, 'packages/database/src/index.ts'),
  '@acr/github': resolve(__dirname, 'packages/github/src/index.ts'),
  '@acr/sandbox': resolve(__dirname, 'packages/sandbox/src/index.ts'),
  '@acr/queue': resolve(__dirname, 'packages/queue/src/index.ts'),
  '@acr/ai': resolve(__dirname, 'packages/ai/src/index.ts'),
  '@acr/pipeline': resolve(__dirname, 'packages/pipeline/src/index.ts'),
};

const sharedTestConfig = {
  environment: 'node' as const,
  globals: false,
  include: [] as string[],
  testTimeout: 30_000,
  hookTimeout: 30_000,
  pool: 'forks' as const,
  reporters: process.env.CI ? (['default'] as const) : (['default'] as const),
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          ...sharedTestConfig,
          name: 'unit',
          include: [
            'packages/**/src/**/*.unit.test.ts',
            'packages/**/test/**/*.unit.test.ts',
            'apps/**/src/**/*.unit.test.ts',
          ],
        },
      },
      {
        resolve: { alias },
        test: {
          ...sharedTestConfig,
          name: 'integration',
          include: ['packages/**/test/**/*.integration.test.ts', 'apps/**/test/**/*.integration.test.ts'],
          fileParallelism: false,
        },
      },
      {
        resolve: { alias },
        test: {
          ...sharedTestConfig,
          name: 'e2e',
          include: ['tests/**/*.e2e.test.ts'],
          fileParallelism: false,
        },
      },
    ],
  },
});
