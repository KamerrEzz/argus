import { defineConfig } from '@playwright/test';

// Web e2e: drives the real dashboard (Next standalone build) against the real
// API (tsc-emitted dist), Postgres and Redis. No mocks, no AI keys — anything
// that needs the model or GitHub is asserted through its graceful failure path.
//
// Prerequisites once per checkout: `npm run build` (backend dist + web
// standalone). The servers below reuse whatever is already listening.
export default defineConfig({
  testDir: 'apps/web/e2e',
  timeout: 90_000,
  expect: {
    timeout: 10_000,
  },
  // Two workers: the specs share one dev database, so unbounded parallelism
  // would turn independent tests into ordering puzzles.
  workers: 2,
  retries: 0,
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'e2e',
      testMatch: /.*\.spec\.ts/,
      dependencies: ['setup'],
      use: { storageState: 'playwright/.auth/admin.json' },
    },
  ],
  use: {
    // localhost (not 127.0.0.1): the API's CORS allowlist and the baked-in
    // NEXT_PUBLIC_API_URL both say localhost, and cookies only flow when the
    // page, the API base and the CORS origin agree on the host.
    baseURL: 'http://localhost:3000',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node apps/api/dist/index.js',
      env: { LOG_PRETTY: 'false' },
      // /ready (not /health): it gates on the database, so the first test
      // never races a half-booted API into a 500 + an empty table.
      url: 'http://localhost:4000/ready',
      timeout: 180_000,
      reuseExistingServer: true,
    },
    {
      // next start (not the standalone server): it serves .next/static from
      // the build output directly. The standalone server.js needs static/ and
      // public/ copied beside it — the Dockerfile does that; locally this is
      // the path that always has assets.
      command: 'npx next start --port 3000',
      cwd: 'apps/web',
      env: { HOSTNAME: '0.0.0.0' },
      url: 'http://localhost:3000/login',
      timeout: 120_000,
      reuseExistingServer: true,
    },
  ],
});
