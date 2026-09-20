import { getConfig, getLogger, serializeError } from '@acr/config';
import { createPrismaClient, disconnectPrismaClient } from './client';
import { seedDatabase } from './seed';

async function main(): Promise<void> {
  const config = getConfig();
  const logger = getLogger();
  const prisma = createPrismaClient();
  try {
    const summary = await seedDatabase(prisma, {
      adminEmail: config.isProduction ? undefined : 'admin@example.com',
      adminPassword: config.isProduction ? undefined : 'change-me-please',
      adminName: 'Admin',
    });
    logger.info(
      {
        users: summary.users,
        repositories: summary.repositories,
        pullRequests: summary.pullRequests,
        reviewRuns: summary.reviewRuns,
        findings: summary.findings,
      },
      'seed completed',
    );
    process.stdout.write(
      `seed completed: ${summary.users} users, ${summary.repositories} repositories, ` +
        `${summary.pullRequests} pull requests, ${summary.reviewRuns} review runs, ` +
        `${summary.findings} findings\n`,
    );
  } finally {
    await disconnectPrismaClient();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`seed failed: ${JSON.stringify(serializeError(error))}\n`);
  process.exitCode = 1;
});
