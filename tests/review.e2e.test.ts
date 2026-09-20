import { execFile as execFileCb } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConfig, parseEnv } from '@acr/config';
import {
  createUser,
  findPendingPublishApproval,
  findRepositoryByFullName,
  listApprovalsForRun,
  listReviewFindings,
  setRepositorySettings,
} from '@acr/database';
import { ScriptedProvider } from '@acr/ai';
import type { GithubAppAuth, GithubInstallationClient, GithubIntegration } from '@acr/github';
import {
  GitClient,
  LocalWorkspace,
  type CreateWorkspaceInput,
  type WorkspaceManager,
} from '@acr/sandbox';
import {
  DEFAULT_REPOSITORY_SETTINGS,
  REVIEW_COMMENT_MARKER,
  noopLogger,
  type ChangedFile,
  type CheckRunRef,
  type FileContent,
  type GithubPublishPort,
  type GithubReadPort,
  type PullRequestInfo,
  type RepositoryTreeEntry,
  type ReviewCommentRef,
} from '@acr/shared';
import {
  approvePublish,
  createContainer,
  executeReview,
  requestReview,
  type ApplicationContainer,
} from '@acr/pipeline';

const execFile = promisify(execFileCb);
const E2E_TIMEOUT_MS = 180_000;

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFile('git', [...args], { cwd });
  return result.stdout.trim();
}

/** Two scripted findings anchored to the fixture's risky.ts. Both survive the
 * deterministic validation: in-changeset file, specific titles, high confidence. */
const SCRIPTED_FINDINGS = [
  {
    severity: 'critical',
    category: 'security',
    title: 'Shell command built from unsanitized pull request input',
    description:
      'thumbnail() interpolates the caller-supplied path and size directly into a shell command string passed to exec, so a malicious argument executes arbitrary commands on the worker.',
    file: 'src/risky.ts',
    line: 3,
    endLine: 3,
    suggestion: 'Use execFile with an argument array instead of interpolating into a shell string.',
    confidence: 0.92,
    evidence: 'exec(`convert ${path} -resize ${size} out.png`, () => undefined);',
  },
  {
    severity: 'medium',
    category: 'bug',
    title: 'Swallowed exec errors hide thumbnail failures',
    description:
      'The exec callback ignores the error argument entirely, so failed conversions are silent and callers cannot distinguish success from failure.',
    file: 'src/risky.ts',
    line: 3,
    endLine: 3,
    suggestion: 'Handle the error argument: log it and surface the failure to the caller.',
    confidence: 0.78,
    evidence: 'exec(`convert ${path} -resize ${size} out.png`, () => undefined);',
  },
] as const;

const NARRATIVE = {
  headline: 'E2E review found command injection in thumbnail generation',
  whatChanged:
    'The pull request adds thumbnail generation by interpolating caller input into a shell command string.',
  strengths: ['The change is small and easy to review.'],
  risks: ['Unsanitized input reaches a shell command and failures are silent.'],
  nextSteps: ['Sanitize the size argument before interpolating it into the command.'],
};

const CRITIQUE_KEEP = {
  discarded: [],
  recalibrated: [],
  overallAssessment: 'Both findings are anchored to the changed file and specific.',
};

interface Fixture {
  readonly dir: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly diff: string;
  readonly changedFiles: readonly ChangedFile[];
  readonly info: PullRequestInfo;
}

async function buildFixture(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'acr-e2e-'));
  const gitArgs = (args: readonly string[]): Promise<string> => git(dir, args);
  await gitArgs(['init', '--quiet', '-b', 'main']);
  await gitArgs(['config', '--local', 'user.email', 'e2e@local']);
  await gitArgs(['config', '--local', 'user.name', 'e2e']);
  await gitArgs(['config', '--local', 'commit.gpgsign', 'false']);

  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'e2e-fixture',
        version: '1.0.0',
        scripts: { test: 'node ./check.cjs', lint: 'node -e "process.exit(0)"' },
      },
      null,
      2,
    ),
  );
  await writeFile(join(dir, 'check.cjs'), "console.log('e2e fixture checks pass');\n");
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(
    join(dir, 'src', 'clean.ts'),
    'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
  );
  await gitArgs(['add', '-A']);
  await gitArgs(['commit', '--quiet', '-m', 'base']);
  const baseSha = await gitArgs(['rev-parse', 'HEAD']);

  await gitArgs(['checkout', '--quiet', '-b', 'e2e-feature']);
  await writeFile(
    join(dir, 'src', 'risky.ts'),
    "import { exec } from 'node:child_process';\n" +
      'export function thumbnail(path: string, size: string): void {\n' +
      '  exec(`convert ${path} -resize ${size} out.png`, () => undefined);\n' +
      '}\n',
  );
  await gitArgs(['add', '-A']);
  await gitArgs(['commit', '--quiet', '-m', 'add thumbnail generation']);
  const headSha = await gitArgs(['rev-parse', 'HEAD']);

  const diff = await gitArgs(['diff', `${baseSha}..${headSha}`]);
  const numstat = await gitArgs(['diff', '--numstat', `${baseSha}..${headSha}`]);
  const firstStat = numstat.split('\n')[0] ?? '';
  const [addedRaw, deletedRaw] = firstStat.split('\t');
  const additions = Number.parseInt(addedRaw ?? '0', 10);
  const deletions = Number.parseInt(deletedRaw ?? '0', 10);

  const changedFiles: readonly ChangedFile[] = [
    {
      path: 'src/risky.ts',
      previousPath: null,
      status: 'added',
      additions: Number.isNaN(additions) ? 0 : additions,
      deletions: Number.isNaN(deletions) ? 0 : deletions,
      patch: diff,
      binary: false,
    },
  ];
  const now = new Date().toISOString();
  const info: PullRequestInfo = {
    id: 9001,
    number: 1,
    title: 'Add thumbnail generation',
    body: 'Adds thumbnail generation for uploads.',
    author: 'e2e-author',
    state: 'open',
    draft: false,
    baseRef: 'main',
    baseSha,
    headRef: 'e2e-feature',
    headSha,
    additions: changedFiles[0]?.additions ?? 0,
    deletions: changedFiles[0]?.deletions ?? 0,
    changedFiles: 1,
    url: 'https://github.com/e2e-org/e2e-repo/pull/1',
    createdAt: now,
    updatedAt: now,
    mergedAt: null,
    labels: [],
  };
  return { dir, baseSha, headSha, diff, changedFiles, info };
}

describe('end-to-end review', () => {
  let fixtureDir = '';
  let fixture: Fixture | null = null;
  let container: ApplicationContainer | null = null;
  let e2eUserId = '';
  let submitted = false;
  // Each test reviews a distinct PR number: validation deliberately discards
  // findings already reported on the same pull request, so reusing one PR
  // would make reruns (and the second test) see zero findings.
  let nextPrNumber = 9400 + (Date.now() % 4000);
  let prNumber = 0;

  const publishedComments: { readonly body: string }[] = [];
  const publishedChecks: { readonly conclusion: string; readonly title: string }[] = [];
  const publishedInline: { readonly path: string; readonly line: number; readonly body: string }[] = [];

  beforeAll(async () => {
    // Fresh config (no shared cache): process sandbox, inline checks, real Postgres.
    const baseConfig = createConfig(parseEnv());
    const config = {
      ...baseConfig,
      sandbox: {
        ...baseConfig.sandbox,
        mode: 'process' as const,
        allowProcessSandbox: true,
        workspaceRoot: join(tmpdir(), `acr-e2e-work-${Date.now()}`),
      },
    };
    const scripted = new ScriptedProvider((request) => {
      const system = request.messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n');
      if (system.includes('closing summary')) {
        return {
          text: JSON.stringify(NARRATIVE),
          inputTokens: 300,
          outputTokens: 120,
        };
      }
      if (system.includes('auditing another reviewer')) {
        return {
          text: JSON.stringify(CRITIQUE_KEEP),
          inputTokens: 200,
          outputTokens: 40,
        };
      }
      if (!submitted) {
        submitted = true;
        return {
          text: 'Findings identified during review.',
          toolCalls: [
            {
              id: 'call_e2e_1',
              name: 'submit_findings',
              args: { findings: SCRIPTED_FINDINGS.map((finding) => ({ ...finding })) },
            },
          ],
          inputTokens: 500,
          outputTokens: 200,
        };
      }
      return { text: 'No further tool calls are needed.', toolCalls: [], inputTokens: 10, outputTokens: 5 };
    });

    const created = await createContainer({
      config,
      provider: scripted,
      requireRedis: true,
      // Real probes: git must resolve (the fixture clones through it) and the
      // process sandbox must stay enabled so repo checks really execute.
      probeSandbox: true,
      loggerName: 'e2e',
    });
    container = created;

    fixture = await buildFixture();
    fixtureDir = fixture.dir;
    const current = fixture;
    const git = new GitClient({ gitBinary: 'git', logger: noopLogger });

    const read: GithubReadPort = {
      // The fake PR id derives from the number: pullRequest.githubId is
      // unique, so every distinct test PR needs its own.
      getPullRequest: () =>
        Promise.resolve({
          ...current.info,
          id: 900000 + prNumber,
          number: prNumber,
          url: `https://github.com/e2e-org/e2e-repo/pull/${prNumber}`,
        }),
      getPullRequestDiff: () => Promise.resolve(current.diff),
      getChangedFiles: () => Promise.resolve(current.changedFiles),
      getFileContent: async (input: { readonly path: string; readonly ref: string }) => {
        try {
          const content = await gitOut(current.dir, ['show', `${input.ref}:${input.path}`]);
          const result: FileContent = {
            path: input.path,
            content,
            encoding: 'utf-8',
            size: content.length,
            truncated: false,
            ref: input.ref,
          };
          return result;
        } catch {
          const missing: FileContent = {
            path: input.path,
            content: null,
            encoding: 'none',
            size: 0,
            truncated: false,
            ref: input.ref,
          };
          return missing;
        }
      },
      searchRepository: () => Promise.resolve([]),
      getRepositoryTree: async (_input: { readonly ref: string }): Promise<readonly RepositoryTreeEntry[]> => {
        const listing = await gitOut(current.dir, ['ls-tree', '-r', '--name-only', current.headSha]);
        return listing
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .map((path) => ({ path, type: 'file' as const, size: null, sha: current.headSha }));
      },
    };

    const publish: GithubPublishPort = {
      findSummaryComment: () => Promise.resolve(null),
      createComment: (input: { readonly body: string }): Promise<ReviewCommentRef> => {
        publishedComments.push({ body: input.body });
        return Promise.resolve({
          id: 71000 + publishedComments.length,
          url: 'https://github.com/e2e-org/e2e-repo/pull/1#e2e',
          body: input.body,
          author: 'e2e-bot',
          createdAt: new Date().toISOString(),
        });
      },
      updateComment: (input: { readonly body: string }): Promise<ReviewCommentRef> => {
        publishedComments.push({ body: input.body });
        return Promise.resolve({
          id: 71000,
          url: 'https://github.com/e2e-org/e2e-repo/pull/1#e2e',
          body: input.body,
          author: 'e2e-bot',
          createdAt: new Date().toISOString(),
        });
      },
      createReviewComment: (input: {
        readonly path: string;
        readonly line: number;
        readonly body: string;
      }): Promise<ReviewCommentRef> => {
        publishedInline.push({ path: input.path, line: input.line, body: input.body });
        return Promise.resolve({
          id: 73000 + publishedInline.length,
          url: `https://github.com/e2e-org/e2e-repo/pull/1#inline-${input.path}-${input.line}`,
          body: input.body,
          author: 'e2e-bot',
          createdAt: new Date().toISOString(),
        });
      },
      createCheckRun: (input: { readonly conclusion: string; readonly title: string }): Promise<CheckRunRef> => {
        publishedChecks.push({ conclusion: input.conclusion, title: input.title });
        return Promise.resolve({ id: 72000 + publishedChecks.length, url: 'https://github.com/e2e-org/e2e-repo/checks/e2e' });
      },
      updateCheckRun: (input: { readonly conclusion: string; readonly title: string }): Promise<CheckRunRef> => {
        publishedChecks.push({ conclusion: input.conclusion, title: input.title });
        return Promise.resolve({ id: 72000, url: 'https://github.com/e2e-org/e2e-repo/checks/e2e' });
      },
    };

    const fakeGithub = {
      auth: { resolveToken: () => Promise.resolve('e2e-token') } as unknown as GithubAppAuth,
      read: {
        ...read,
        getRepository: (input: { readonly owner: string; readonly name: string }) =>
          Promise.resolve({
            id: 9001,
            fullName: `${input.owner}/${input.name}`,
            owner: input.owner,
            name: input.name,
            defaultBranch: 'main',
            isPrivate: true,
            language: 'TypeScript',
          }),
      },
      publish,
      installations: {} as unknown as GithubInstallationClient,
    } satisfies GithubIntegration;

    const fakeWorkspaces = {
      absoluteRoot: () => config.sandbox.workspaceRoot,
      create: async (input: CreateWorkspaceInput) => {
        const directory = join(config.sandbox.workspaceRoot, `run-${input.runId}-${randomUUID().slice(0, 8)}`);
        await mkdir(directory, { recursive: true });
        const branch = input.ref !== null && input.ref !== undefined && input.ref.length > 0 ? input.ref : 'main';
        await git.initWorkspace(directory);
        await git.addRemote(directory, pathToFileURL(current.dir).href);
        await git.fetchRef(directory, branch, 50);
        await git.checkoutDetached(directory);
        await git.removeRemote(directory, 'origin');
        const headSha = await git.resolveHead(directory);
        if (
          input.expectedSha !== undefined &&
          input.expectedSha !== null &&
          input.expectedSha.length > 0 &&
          headSha !== input.expectedSha
        ) {
          throw new Error(`e2e workspace sha mismatch: ${headSha} !== ${input.expectedSha}`);
        }
        return new LocalWorkspace({ root: directory, headSha, logger: noopLogger, maxFileBytes: 1_000_000 });
      },
    } as unknown as WorkspaceManager;

    const mutable = created as unknown as { github: GithubIntegration; workspaces: WorkspaceManager };
    mutable.github = fakeGithub;
    mutable.workspaces = fakeWorkspaces;

    const user = await createUser(created.prisma, {
      email: `e2e-${randomUUID()}@example.com`,
      name: 'E2E Decider',
      password: 'e2e-password-123',
      role: 'member',
    });
    e2eUserId = user.id;

    // The gate test flips this flag; reset to the default so reruns start clean.
    const existing = await findRepositoryByFullName(created.prisma, 'e2e-org/e2e-repo');
    if (existing !== null) {
      await setRepositorySettings(created.prisma, existing.id, {
        ...DEFAULT_REPOSITORY_SETTINGS,
        requireApprovalToPublish: false,
      });
    }
  }, E2E_TIMEOUT_MS);

  afterAll(async () => {
    await container?.close().catch(() => undefined);
    if (fixtureDir.length > 0) {
      await rm(fixtureDir, { recursive: true, force: true }).catch(() => undefined);
    }
    const root = container?.workspaceRoot;
    if (root !== undefined && root.includes('acr-e2e-work-')) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function gitOut(cwd: string, args: readonly string[]): Promise<string> {
    const result = await execFile('git', [...args], { cwd });
    return result.stdout.trim();
  }

  it('runs a review end to end: request, execute, findings, publish', async () => {
    expect(container).not.toBeNull();
    expect(fixture).not.toBeNull();
    if (container === null || fixture === null) {
      throw new Error('e2e setup failed');
    }
    const active = container;
    prNumber = nextPrNumber++;

    const seen: { readonly type: string; readonly message: string }[] = [];
    const controller = new AbortController();
    const requested = await requestReview(active, {
      repository: 'e2e-org/e2e-repo',
      pullRequestNumber: prNumber,
      trigger: 'manual',
      requestedBy: 'e2e-suite',
      idempotencyKey: `e2e:${randomUUID()}`,
    });
    expect(requested.created).toBe(true);

    const streamDone = active.events.subscribe({
      reviewRunId: requested.reviewRunId,
      signal: controller.signal,
      blockMs: 5_000,
      onEvent: (event) => {
        seen.push({ type: event.type, message: event.message });
      },
    });

    const result = await executeReview(active, requested.reviewRunId);
    controller.abort();
    await streamDone.catch(() => undefined);

    expect(result.status).toBe('completed');
    expect(result.verdict).toBe('failed');
    expect(result.outcome).not.toBeNull();
    expect(result.findings.total).toBeGreaterThanOrEqual(2);
    expect(result.published.skippedReason).toBeNull();
    const usage = result.outcome?.usage;
    expect((usage?.tokensIn ?? 0) + (usage?.tokensOut ?? 0)).toBeGreaterThan(0);
    // The fixture's own test and lint scripts really executed in the sandbox:
    // the run is not just model prose over an empty checkout.
    const commands = result.outcome?.commands ?? [];
    expect(commands.length).toBeGreaterThanOrEqual(1);
    expect(commands.some((record) => record.command.includes('test'))).toBe(true);

    // The reviewer's prose and findings reached the publisher intact.
    expect(publishedComments.length).toBeGreaterThanOrEqual(1);
    const comment = publishedComments[publishedComments.length - 1]?.body ?? '';
    expect(comment).toContain(REVIEW_COMMENT_MARKER);
    expect(comment).toContain('Shell command built from unsanitized pull request input');
    expect(comment).toContain(NARRATIVE.headline);
    expect(publishedChecks.length).toBeGreaterThanOrEqual(1);
    expect(publishedChecks[publishedChecks.length - 1]?.conclusion).toBe('failure');

    // The event stream carried the run from start to completion.
    const types = seen.map((entry) => entry.type);
    expect(types).toContain('run.started');
    expect(types).toContain('run.completed');

    // Persistence recorded the same run the pipeline returned.
    const stored = await listReviewFindings(active.prisma, requested.reviewRunId, {});
    expect(stored.length).toBeGreaterThanOrEqual(2);
    expect(stored.some((finding) => String(finding['severity']) === 'critical')).toBe(true);
  }, E2E_TIMEOUT_MS);

  it('gates publishing behind approval, then publishes the exact snapshot', async () => {
    expect(container).not.toBeNull();
    if (container === null) {
      throw new Error('e2e setup failed');
    }
    submitted = false;
    prNumber = nextPrNumber++;
    const active = container;
    const repo = await findRepositoryByFullName(active.prisma, 'e2e-org/e2e-repo');
    expect(repo).not.toBeNull();
    if (repo === null) {
      throw new Error('e2e repository missing');
    }
    await setRepositorySettings(active.prisma, repo.id, {
      ...DEFAULT_REPOSITORY_SETTINGS,
      requireApprovalToPublish: true,
    });
    try {
      const commentsBefore = publishedComments.length;
      const checksBefore = publishedChecks.length;
      const requested = await requestReview(active, {
        repository: 'e2e-org/e2e-repo',
        pullRequestNumber: prNumber,
        trigger: 'manual',
        requestedBy: 'e2e-suite',
        idempotencyKey: `e2e-gate:${randomUUID()}`,
      });
      const result = await executeReview(active, requested.reviewRunId);

      expect(result.status).toBe('completed');
      expect(result.published.skippedReason?.startsWith('approval_required')).toBe(true);
      expect(publishedComments.length).toBe(commentsBefore);
      expect(publishedChecks.length).toBe(checksBefore);

      const pending = await findPendingPublishApproval(active.prisma, requested.reviewRunId);
      expect(pending).not.toBeNull();
      const approvals = await listApprovalsForRun(active.prisma, requested.reviewRunId);
      expect(approvals.length).toBeGreaterThanOrEqual(1);

      const published = await approvePublish(active, {
        reviewRunId: requested.reviewRunId,
        decidedById: e2eUserId,
        reason: 'e2e approval',
      });
      expect(published.skippedReason).toBeNull();
      expect(publishedComments.length).toBe(commentsBefore + 1);
      const approved = publishedComments[publishedComments.length - 1]?.body ?? '';
      expect(approved).toContain(REVIEW_COMMENT_MARKER);
      expect(approved).toContain('Shell command built from unsanitized pull request input');
    } finally {
      await setRepositorySettings(active.prisma, repo.id, {
        ...DEFAULT_REPOSITORY_SETTINGS,
        requireApprovalToPublish: false,
      });
    }
  }, E2E_TIMEOUT_MS);
});
