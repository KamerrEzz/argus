import type { PrismaClient } from '@prisma/client';
import { findingFingerprint, parseRepositorySettings, type Severity } from '@acr/shared';
import { hashPassword } from './auth-store';

export interface SeedOptions {
  readonly adminEmail?: string;
  readonly adminPassword?: string;
  readonly adminName?: string;
}

export interface SeedSummary {
  readonly users: number;
  readonly repositories: number;
  readonly pullRequests: number;
  readonly reviewRuns: number;
  readonly findings: number;
  readonly credentials: { readonly email: string; readonly password: string };
}

const IDS = {
  admin: '11111111-1111-4111-8111-111111111111',
  reviewer: '22222222-2222-4222-8222-222222222222',
  repositoryApi: '33333333-3333-4333-8333-333333333333',
  repositoryWeb: '44444444-4444-4444-8444-444444444444',
  pullRequestSql: '55555555-5555-4555-8555-555555555555',
  pullRequestDocs: '66666666-6666-4666-8666-666666666666',
  pullRequestAuth: '77777777-7777-4777-8777-777777777777',
  reviewCompleted: '88888888-8888-4888-8888-888888888888',
  reviewRunning: '99999999-9999-4999-8999-999999999999',
  reviewFailed: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  agentCompleted: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  webhook: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
} as const;

interface SeedFinding {
  readonly severity: Severity;
  readonly category: 'bug' | 'security' | 'performance' | 'architecture' | 'maintainability' | 'testing' | 'style';
  readonly title: string;
  readonly description: string;
  readonly file: string;
  readonly line: number;
  readonly endLine: number | null;
  readonly suggestion: string;
  readonly confidence: number;
  readonly evidence: string;
}

const FINDINGS: readonly SeedFinding[] = [
  {
    severity: 'critical',
    category: 'security',
    title: 'SQL query built from request parameter without parameterisation',
    description:
      'The handler concatenates `req.query.tenant` directly into the SQL string passed to `pool.query`, so any authenticated caller can inject arbitrary SQL. Repository content is untrusted, so this is exploitable without further privileges.',
    file: 'src/repositories/tenant-repository.ts',
    line: 42,
    endLine: 51,
    suggestion:
      'Pass the tenant id as a bound parameter: `pool.query("SELECT * FROM tenants WHERE id = $1", [tenantId])`.',
    confidence: 0.94,
    evidence: 'const sql = `SELECT * FROM tenants WHERE id = \'${req.query.tenant}\'`;',
  },
  {
    severity: 'high',
    category: 'bug',
    title: 'Missing await on repository.save causes lost writes',
    description:
      '`saveInvoice` returns before the database write resolves and swallows rejections, so callers observe success even when persistence fails.',
    file: 'src/services/invoice-service.ts',
    line: 118,
    endLine: 126,
    suggestion: 'Await the repository call and let failures propagate to the caller.',
    confidence: 0.87,
    evidence: 'await this.repository.save(invoice);',
  },
  {
    severity: 'medium',
    category: 'performance',
    title: 'Loop issues one query per tenant (N+1)',
    description:
      'For each tenant the loop calls `loadSettings`, producing N sequential round trips. On large installations this dominates request latency.',
    file: 'src/services/tenant-service.ts',
    line: 77,
    endLine: 93,
    suggestion: 'Fetch all settings with a single `IN (...)` query and join in memory.',
    confidence: 0.72,
    evidence: 'for (const tenant of tenants) { const settings = await loadSettings(tenant.id); }',
  },
  {
    severity: 'low',
    category: 'maintainability',
    title: 'Duplicated error mapping between two handlers',
    description:
      '`mapError` is duplicated in `routes/orders.ts` and `routes/users.ts`; divergence will produce inconsistent API errors.',
    file: 'src/routes/orders.ts',
    line: 210,
    endLine: 244,
    suggestion: 'Extract the mapping into `src/http/error-mapper.ts` and import it in both handlers.',
    confidence: 0.68,
    evidence: 'function mapError(error: unknown): HttpError {',
  },
  {
    severity: 'info',
    category: 'testing',
    title: 'New pagination branch lacks a boundary test',
    description:
      'The added `cursor` branch is not covered by the existing pagination suite, so regressions on the empty-page path would ship silently.',
    file: 'src/services/invoice-service.ts',
    line: 156,
    endLine: 160,
    suggestion: 'Add a test that requests a cursor past the last row and asserts an empty page.',
    confidence: 0.63,
    evidence: 'if (cursor !== undefined && page.length === 0) {',
  },
];

export async function seedDatabase(prisma: PrismaClient, options: SeedOptions = {}): Promise<SeedSummary> {
  const adminEmail = (options.adminEmail ?? 'admin@example.com').toLowerCase();
  const adminPassword = options.adminPassword ?? 'change-me-please';
  const adminName = options.adminName ?? 'Admin';

  const passwordHash = await hashPassword(adminPassword);
  const reviewerHash = await hashPassword('reviewer-password');

  await prisma.user.upsert({
    where: { id: IDS.admin },
    update: { email: adminEmail, name: adminName, role: 'ADMIN', isActive: true },
    create: {
      id: IDS.admin,
      email: adminEmail,
      name: adminName,
      role: 'ADMIN',
      passwordHash,
      isActive: true,
    },
  });

  await prisma.user.upsert({
    where: { id: IDS.reviewer },
    update: { email: 'reviewer@example.com', name: 'Reviewer', role: 'MEMBER', isActive: true },
    create: {
      id: IDS.reviewer,
      email: 'reviewer@example.com',
      name: 'Reviewer',
      role: 'MEMBER',
      passwordHash: reviewerHash,
      isActive: true,
    },
  });

  const apiRepository = await prisma.repository.upsert({
    where: { id: IDS.repositoryApi },
    update: { isActive: true },
    create: {
      id: IDS.repositoryApi,
      githubId: '70000001',
      owner: 'acme',
      name: 'api-gateway',
      fullName: 'acme/api-gateway',
      installationId: '50000001',
      defaultBranch: 'main',
      isPrivate: true,
      language: 'TypeScript',
      isActive: true,
      lastSyncedAt: new Date(),
      settings: parseRepositorySettings({
        enableTests: true,
        enableLint: true,
        enableTypecheck: true,
        failOnSeverities: ['critical', 'high'],
      }) as unknown as object,
    },
  });

  const webRepository = await prisma.repository.upsert({
    where: { id: IDS.repositoryWeb },
    update: { isActive: true },
    create: {
      id: IDS.repositoryWeb,
      githubId: '70000002',
      owner: 'acme',
      name: 'web-console',
      fullName: 'acme/web-console',
      installationId: '50000001',
      defaultBranch: 'main',
      isPrivate: false,
      language: 'TypeScript',
      isActive: true,
      lastSyncedAt: new Date(),
      settings: parseRepositorySettings({ deepReview: false }) as unknown as object,
    },
  });

  await prisma.repositoryAccess.upsert({
    where: { userId_repositoryId: { userId: IDS.admin, repositoryId: apiRepository.id } },
    update: { permission: 'ADMIN' },
    create: { userId: IDS.admin, repositoryId: apiRepository.id, permission: 'ADMIN', grantedById: IDS.admin },
  });
  await prisma.repositoryAccess.upsert({
    where: { userId_repositoryId: { userId: IDS.admin, repositoryId: webRepository.id } },
    update: { permission: 'ADMIN' },
    create: { userId: IDS.admin, repositoryId: webRepository.id, permission: 'ADMIN', grantedById: IDS.admin },
  });
  await prisma.repositoryAccess.upsert({
    where: { userId_repositoryId: { userId: IDS.reviewer, repositoryId: apiRepository.id } },
    update: { permission: 'READ' },
    create: { userId: IDS.reviewer, repositoryId: apiRepository.id, permission: 'READ', grantedById: IDS.admin },
  });

  const sqlPr = await prisma.pullRequest.upsert({
    where: { id: IDS.pullRequestSql },
    update: { updatedAt: new Date() },
    create: {
      id: IDS.pullRequestSql,
      githubId: '90000001',
      repositoryId: apiRepository.id,
      number: 128,
      title: 'Add tenant-scoped invoice queries',
      body: 'Introduces tenant filtering for invoices and wires the new repository layer.',
      author: 'dev-alice',
      state: 'OPEN',
      baseRef: 'main',
      baseSha: 'b1a2c3d4e5f60718293a4b5c6d7e8f9012345678',
      headRef: 'feature/tenant-invoices',
      headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      additions: 412,
      deletions: 87,
      changedFiles: 14,
      url: 'https://github.com/acme/api-gateway/pull/128',
      labels: ['feature', 'backend'],
      openedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
    },
  });

  const docsPr = await prisma.pullRequest.upsert({
    where: { id: IDS.pullRequestDocs },
    update: {},
    create: {
      id: IDS.pullRequestDocs,
      githubId: '90000002',
      repositoryId: apiRepository.id,
      number: 129,
      title: 'Document the invoice API',
      body: 'Adds request and response examples to the integration guide.',
      author: 'dev-bob',
      state: 'OPEN',
      baseRef: 'main',
      baseSha: 'c1d2e3f405162738495a6b7c8d9e0f1122334455',
      headRef: 'docs/invoice-api',
      headSha: 'd1e2f30415263748596a7b8c9d0e1f2233445566',
      additions: 96,
      deletions: 4,
      changedFiles: 2,
      url: 'https://github.com/acme/api-gateway/pull/129',
      labels: ['documentation'],
      openedAt: new Date(Date.now() - 26 * 60 * 60 * 1000),
    },
  });

  const authPr = await prisma.pullRequest.upsert({
    where: { id: IDS.pullRequestAuth },
    update: {},
    create: {
      id: IDS.pullRequestAuth,
      githubId: '90000003',
      repositoryId: webRepository.id,
      number: 57,
      title: 'Rotate session tokens on privilege change',
      body: 'Invalidates active sessions when a user role changes.',
      author: 'dev-carol',
      state: 'OPEN',
      draft: true,
      baseRef: 'main',
      baseSha: 'e1f2031425364758697a8b9c0d1e2f3344556677',
      headRef: 'fix/session-rotation',
      headSha: 'f102132435465768798a9b0c1d2e3f4455667788',
      additions: 133,
      deletions: 21,
      changedFiles: 6,
      url: 'https://github.com/acme/web-console/pull/57',
      labels: ['security'],
      openedAt: new Date(Date.now() - 40 * 60 * 1000),
    },
  });

  const completedRun = await prisma.reviewRun.upsert({
    where: { id: IDS.reviewCompleted },
    update: {},
    create: {
      id: IDS.reviewCompleted,
      repositoryId: apiRepository.id,
      pullRequestId: sqlPr.id,
      status: 'COMPLETED',
      trigger: 'WEBHOOK',
      verdict: 'FAILED',
      headSha: sqlPr.headSha,
      baseSha: sqlPr.baseSha,
      model: 'gpt-4o-mini',
      summary:
        'Found one critical SQL injection in the tenant repository and a lost-write bug in the invoice service. Documentation and pagination changes look safe.',
      plan: {
        analyzeTests: true,
        analyzeLint: true,
        analyzeTypecheck: true,
        analyzeSql: true,
        analyzeSecurity: true,
        analyzeDependencies: false,
        analyzePerformance: true,
        deepReview: true,
        reasons: ['database_change_detected', 'authentication_change_detected'],
      },
      planReasons: ['database_change_detected', 'authentication_change_detected'],
      changedFiles: [
        { path: 'src/repositories/tenant-repository.ts', status: 'modified', additions: 120, deletions: 34 },
        { path: 'src/services/invoice-service.ts', status: 'modified', additions: 88, deletions: 12 },
        { path: 'src/services/tenant-service.ts', status: 'modified', additions: 74, deletions: 21 },
        { path: 'src/routes/orders.ts', status: 'modified', additions: 45, deletions: 8 },
      ],
      filesAnalyzed: 14,
      findingsTotal: FINDINGS.length,
      criticalCount: 1,
      highCount: 1,
      mediumCount: 1,
      lowCount: 1,
      infoCount: 1,
      tokensIn: 48210,
      tokensOut: 6120,
      estimatedCostUsd: '0.109500',
      iterations: 6,
      toolCalls: 23,
      idempotencyKey: 'seed:acme/api-gateway:128:completed',
      startedAt: new Date(Date.now() - 2.5 * 60 * 60 * 1000),
      finishedAt: new Date(Date.now() - 2.4 * 60 * 60 * 1000),
      publishedAt: new Date(Date.now() - 2.4 * 60 * 60 * 1000),
      durationMs: 96_400,
      commentId: '4100000001',
      checkRunId: '5500000001',
    },
  });

  await prisma.reviewRun.upsert({
    where: { id: IDS.reviewRunning },
    update: {},
    create: {
      id: IDS.reviewRunning,
      repositoryId: apiRepository.id,
      pullRequestId: docsPr.id,
      status: 'RUNNING',
      trigger: 'WEBHOOK',
      headSha: docsPr.headSha,
      baseSha: docsPr.baseSha,
      model: 'gpt-4o-mini',
      plan: {
        analyzeTests: false,
        analyzeLint: false,
        analyzeTypecheck: false,
        analyzeSql: false,
        analyzeSecurity: false,
        analyzeDependencies: false,
        analyzePerformance: false,
        deepReview: false,
        reasons: ['documentation_only_change'],
      },
      idempotencyKey: 'seed:acme/api-gateway:129:running',
      startedAt: new Date(Date.now() - 45_000),
    },
  });

  await prisma.reviewRun.upsert({
    where: { id: IDS.reviewFailed },
    update: {},
    create: {
      id: IDS.reviewFailed,
      repositoryId: webRepository.id,
      pullRequestId: authPr.id,
      status: 'FAILED',
      trigger: 'MANUAL',
      headSha: authPr.headSha,
      baseSha: authPr.baseSha,
      model: 'gpt-4o-mini',
      summary: 'Review aborted: the sandbox rejected the generated image before tests started.',
      error: 'Sandbox: pull access denied for node:22-bookworm-slim',
      idempotencyKey: 'seed:acme/web-console:57:failed',
      startedAt: new Date(Date.now() - 30 * 60 * 1000),
      finishedAt: new Date(Date.now() - 29 * 60 * 1000),
      durationMs: 14_200,
    },
  });

  const agentExecution = await prisma.agentExecution.upsert({
    where: { id: IDS.agentCompleted },
    update: {},
    create: {
      id: IDS.agentCompleted,
      reviewRunId: completedRun.id,
      graphName: 'review-graph',
      model: 'gpt-4o-mini',
      status: 'SUCCEEDED',
      currentNode: 'publishResults',
      iterations: 6,
      toolCalls: 23,
      tokensIn: 48210,
      tokensOut: 6120,
      estimatedCostUsd: '0.109500',
      startedAt: new Date(Date.now() - 2.5 * 60 * 60 * 1000),
      finishedAt: new Date(Date.now() - 2.4 * 60 * 60 * 1000),
      durationMs: 96_400,
    },
  });

  const nodeSequence: readonly { node: string; durationMs: number; summary: string }[] = [
    { node: 'initialize', durationMs: 120, summary: 'Review run loaded with budget 900000ms' },
    { node: 'loadPullRequest', durationMs: 640, summary: 'PR #128 metadata loaded' },
    { node: 'inspectRepository', durationMs: 2_310, summary: 'Changed files and repository tree inspected' },
    { node: 'analyzeChanges', durationMs: 180, summary: 'Plan: tests, lint, typecheck, sql, security' },
    { node: 'runChecks', durationMs: 41_200, summary: 'test, lint and typecheck executed in sandbox' },
    { node: 'staticAnalysis', durationMs: 3_400, summary: '2 static analysis findings' },
    { node: 'securityAnalysis', durationMs: 4_100, summary: '1 security finding' },
    { node: 'aiReview', durationMs: 33_800, summary: '5 candidate findings produced' },
    { node: 'validateFindings', durationMs: 2_900, summary: '5 kept, 0 discarded' },
    { node: 'finalReview', durationMs: 5_600, summary: 'Verdict failed (1 critical, 1 high)' },
    { node: 'publishResults', durationMs: 1_400, summary: 'Summary comment and check run published' },
  ];

  const baseTime = Date.now() - 2.5 * 60 * 60 * 1000;
  let cursor = baseTime;
  for (const entry of nodeSequence) {
    await prisma.agentNodeExecution.create({
      data: {
        reviewRunId: completedRun.id,
        agentExecutionId: agentExecution.id,
        node: entry.node,
        attempt: 1,
        status: 'SUCCEEDED',
        summary: entry.summary,
        startedAt: new Date(cursor),
        finishedAt: new Date(cursor + entry.durationMs),
        durationMs: entry.durationMs,
      },
    });
    cursor += entry.durationMs;
  }

  const tools: readonly { tool: string; durationMs: number }[] = [
    { tool: 'getPullRequest', durationMs: 420 },
    { tool: 'getChangedFiles', durationMs: 610 },
    { tool: 'getRepositoryTree', durationMs: 1_180 },
    { tool: 'inspectPackageJson', durationMs: 52 },
    { tool: 'runTests', durationMs: 28_400 },
    { tool: 'runLint', durationMs: 7_900 },
    { tool: 'runTypeCheck', durationMs: 4_900 },
    { tool: 'analyzeSecurityPatterns', durationMs: 2_300 },
  ];
  let toolCursor = baseTime + 4_000;
  for (const entry of tools) {
    await prisma.toolExecution.create({
      data: {
        reviewRunId: completedRun.id,
        agentExecutionId: agentExecution.id,
        tool: entry.tool,
        status: 'SUCCEEDED',
        inputMetadata: { source: 'seed' },
        outputMetadata: { ok: true },
        startedAt: new Date(toolCursor),
        finishedAt: new Date(toolCursor + entry.durationMs),
        durationMs: entry.durationMs,
      },
    });
    toolCursor += entry.durationMs + 250;
  }

  const checks: readonly {
    kind: 'TEST' | 'LINT' | 'TYPECHECK' | 'STATIC_ANALYSIS' | 'SECURITY_SCAN';
    tool: string;
    command: string;
    status: 'SUCCEEDED' | 'FAILED';
    exitCode: number;
    durationMs: number;
    summary: string;
  }[] = [
    {
      kind: 'TEST',
      tool: 'npm',
      command: 'npm test',
      status: 'FAILED',
      exitCode: 1,
      durationMs: 28_400,
      summary: '2 failing tests in tenant-repository.spec.ts',
    },
    {
      kind: 'LINT',
      tool: 'npm',
      command: 'npm run lint',
      status: 'SUCCEEDED',
      exitCode: 0,
      durationMs: 7_900,
      summary: 'No lint errors',
    },
    {
      kind: 'TYPECHECK',
      tool: 'npm',
      command: 'npm run typecheck',
      status: 'SUCCEEDED',
      exitCode: 0,
      durationMs: 4_900,
      summary: 'No type errors',
    },
    {
      kind: 'SECURITY_SCAN',
      tool: 'acr-security-patterns',
      command: 'internal:security-patterns',
      status: 'SUCCEEDED',
      exitCode: 0,
      durationMs: 2_300,
      summary: 'SQL string concatenation detected',
    },
  ];
  for (const check of checks) {
    await prisma.testExecution.create({
      data: {
        reviewRunId: completedRun.id,
        kind: check.kind,
        tool: check.tool,
        command: check.command,
        status: check.status,
        exitCode: check.exitCode,
        durationMs: check.durationMs,
        stdout: check.status === 'FAILED' ? 'FAIL src/repositories/tenant-repository.spec.ts' : 'ok',
        stderr: '',
        sandbox: 'DOCKER',
        image: 'node:22-bookworm-slim',
        summary: check.summary,
      },
    });
  }

  for (const finding of FINDINGS) {
    const fingerprint = findingFingerprint({
      category: finding.category,
      file: finding.file,
      title: finding.title,
      line: finding.line,
    });
    await prisma.reviewFinding.upsert({
    where: { reviewRunId_fingerprint: { reviewRunId: completedRun.id, fingerprint } },
    create: {
      reviewRunId: completedRun.id,
      pullRequestId: sqlPr.id,
      fingerprint,
      severity: finding.severity.toUpperCase() as 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO',
      category: finding.category.toUpperCase() as
        | 'BUG'
        | 'SECURITY'
        | 'PERFORMANCE'
        | 'ARCHITECTURE'
        | 'MAINTAINABILITY'
        | 'TESTING'
        | 'STYLE',
      status: 'PUBLISHED',
      title: finding.title,
      description: finding.description,
      file: finding.file,
      line: finding.line,
      endLine: finding.endLine,
      suggestion: finding.suggestion,
      evidence: finding.evidence,
      confidence: finding.confidence,
      confidenceBand: finding.confidence >= 0.8 ? 'high' : finding.confidence >= 0.6 ? 'medium' : 'low',
      publishable: true,
      source: 'AGENT',
      validationReasons: ['validated'],
      publishedAt: new Date(Date.now() - 2.4 * 60 * 60 * 1000),
    },
    update: {},
  });
  }

  await prisma.webhookEvent.upsert({
    where: { id: IDS.webhook },
    update: {},
    create: {
      id: IDS.webhook,
      deliveryId: 'seed-delivery-0001',
      event: 'pull_request',
      action: 'opened',
      status: 'PROCESSED',
      repositoryId: apiRepository.id,
      repositoryFullName: apiRepository.fullName,
      installationId: '50000001',
      pullRequestNumber: 128,
      headSha: sqlPr.headSha,
      reviewRunId: completedRun.id,
      payloadSummary: { action: 'opened', number: 128 },
      receivedAt: new Date(Date.now() - 2.6 * 60 * 60 * 1000),
      processedAt: new Date(Date.now() - 2.5 * 60 * 60 * 1000),
    },
  });

  const counts = {
    users: await prisma.user.count(),
    repositories: await prisma.repository.count(),
    pullRequests: await prisma.pullRequest.count(),
    reviewRuns: await prisma.reviewRun.count(),
    findings: await prisma.reviewFinding.count(),
  };

  return {
    ...counts,
    credentials: { email: adminEmail, password: adminPassword },
  };
}
