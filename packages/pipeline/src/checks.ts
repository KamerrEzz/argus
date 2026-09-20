import {
  availableScripts,
  describeDependencySummary,
  readPackageManifest,
  resolveScriptName,
  type PackageManifest,
} from '@acr/sandbox';
import {
  SandboxError,
  type CommandKind,
  type CommandOutcome,
  type CommandRunnerPort,
  type CommandRunResult,
  type CommandSpec,
  type RepoWorkspace,
} from '@acr/shared';
import type { AllowedScripts, CheckLaunchRequest, CheckLauncher } from '@acr/ai';
import { QUEUES, type QueueClient, type QueueName } from '@acr/queue';

export interface ScriptCatalog {
  readonly manifest: PackageManifest | null;
  readonly allowed: AllowedScripts;
  readonly availability: ReturnType<typeof availableScripts>;
  readonly dependencySummary: string | null;
}

const ANALYSIS_HINT = /(analy[sz]e|lint|type|check|inspect|report|dead)/i;
const SECURITY_HINT = /(security|audit|snyk|semgrep|gitleaks|truffle|vulnerab|nsp|codescan)/i;

/**
 * What this repository can actually run. Every allow-list entry is a script the
 * project itself declares, so neither the model nor the agent can invent a
 * command to execute.
 */
export async function buildScriptCatalog(workspace: RepoWorkspace): Promise<ScriptCatalog> {
  const manifest = await readPackageManifest(workspace);
  if (manifest === null) {
    return {
      manifest: null,
      allowed: {},
      availability: availableScripts(null),
      dependencySummary: null,
    };
  }
  const names = Object.keys(manifest.scripts);
  const canonical = {
    test: resolveScriptName(manifest, 'test'),
    lint: resolveScriptName(manifest, 'lint'),
    typecheck: resolveScriptName(manifest, 'typecheck'),
    build: resolveScriptName(manifest, 'build'),
  };
  const allowed: AllowedScripts = {
    test: canonical.test === null ? [] : [canonical.test],
    lint: canonical.lint === null ? [] : [canonical.lint],
    typecheck: canonical.typecheck === null ? [] : [canonical.typecheck],
    build: canonical.build === null ? [] : [canonical.build],
    static_analysis: dedupe([
      canonical.lint,
      canonical.typecheck,
      ...names.filter((name) => ANALYSIS_HINT.test(name)),
    ]),
    security_scan: names.filter((name) => SECURITY_HINT.test(name)),
  };

  return {
    manifest,
    allowed,
    availability: availableScripts(manifest),
    dependencySummary: describeDependencySummary(manifest),
  };
}

function dedupe(values: readonly (string | null)[]): string[] {
  const output: string[] = [];
  for (const value of values) {
    if (value !== null && !output.includes(value)) {
      output.push(value);
    }
  }
  return output;
}

export interface SandboxPolicy {
  readonly image: string;
  readonly network: 'none' | 'bridge';
  readonly memoryLimit: string;
  readonly cpuLimit: number;
  readonly pidsLimit: number;
  readonly timeoutMs: number;
}

export function toCommandSpec(
  request: CheckLaunchRequest,
  workspaceDir: string,
  policy: SandboxPolicy,
): CommandSpec {
  return {
    kind: request.kind,
    script: request.script,
    args: request.args,
    workspaceDir,
    timeoutMs: Math.min(request.timeoutMs, policy.timeoutMs),
    image: policy.image,
    network: policy.network,
    memoryLimit: policy.memoryLimit,
    cpuLimit: policy.cpuLimit,
    pidsLimit: policy.pidsLimit,
  };
}

export function toCommandOutcome(kind: CommandKind, result: CommandRunResult): CommandOutcome {
  return { kind, ...result };
}

/** Run a check in the local sandbox from the calling process. */
export function createInlineCheckLauncher(input: {
  readonly runner: CommandRunnerPort;
  readonly workspaceDir: string;
  readonly policy: SandboxPolicy;
}): CheckLauncher {
  return async (request) => {
    const spec = toCommandSpec(request, input.workspaceDir, input.policy);
    const result = await input.runner.run(spec);
    return toCommandOutcome(request.kind, result);
  };
}

/** Hand the check to a worker that owns a sandbox, and wait for its result. */
export function createQueuedCheckLauncher(input: {
  readonly queue: QueueClient;
  readonly reviewRunId: string;
  readonly workspaceDir: string;
}): CheckLauncher {
  return async (request) => {
    const queueName: QueueName = request.kind === 'test' ? QUEUES.runTests : QUEUES.runStaticAnalysis;
    const dispatched = await input.queue.dispatch(queueName, {
      reviewRunId: input.reviewRunId,
      workspaceDir: input.workspaceDir,
      kind: request.kind,
      script: request.script,
      args: [...request.args],
      timeoutMs: request.timeoutMs,
    });

    if (dispatched.jobId === null) {
      throw new SandboxError(`could not queue ${request.kind} check: job was deduplicated`);
    }

    const outcome = await input.queue.waitForJob<CommandRunResult>(queueName, dispatched.jobId, {
      timeoutMs: request.timeoutMs + 60_000,
      pollMs: 500,
    });

    if (outcome.status !== 'completed') {
      throw new SandboxError(
        `${request.kind} check did not complete: ${outcome.status === 'failed' ? outcome.reason : outcome.status}`,
      );
    }
    return toCommandOutcome(request.kind, outcome.result);
  };
}

export function queueNameForKind(kind: CommandKind): QueueName {
  return kind === 'test' ? QUEUES.runTests : QUEUES.runStaticAnalysis;
}
