import {
  FindingDraftSchema,
  buildReviewPlan,
  classifyChanges,
  describeReviewPlan,
  truncate,
  type AnalysisResult,
  type CheckExecutionRecord,
  type CommandKind,
  type CommandOutcome,
  type FindingDraft,
} from '@acr/shared';
import { parseCheckOutput } from '../analysis/static-output';
import { publish, skippedNode, type GraphNodeFn, type ReviewGraphPorts } from './instrument';

interface PlannedCheck {
  readonly kind: Extract<CommandKind, 'test' | 'lint' | 'typecheck'>;
  readonly enabled: boolean;
  readonly disabledReason: string | null;
}

/** Mirrors the capability flags `buildReviewPlan` consumes. */
interface ScriptFlags {
  readonly test: boolean;
  readonly lint: boolean;
  readonly typecheck: boolean;
  readonly build: boolean;
}

/**
 * Deterministic change classification. No model call: the shape of a change is
 * facts, and the plan must be reproducible from them.
 */
export function createAnalyzeChangesNode(ports: ReviewGraphPorts): GraphNodeFn {
  return async (state) => {
    const classification = classifyChanges(state.changedFiles);
    await publish(ports, {
      reviewRunId: ports.reviewRunId,
      type: 'log',
      message: `Classified ${classification.totalFiles} file(s): ${classification.sourceFiles.length} source, ${classification.testFiles.length} test, ${classification.migrationFiles.length} migration, ${classification.documentationFiles.length} docs`,
      data: {
        touchesAuthentication: classification.touchesAuthentication,
        touchesDatabase: classification.touchesDatabase,
        touchesDependencies: classification.touchesDependencies,
        documentationOnly: classification.documentationOnly,
      },
    });
    return { classification };
  };
}

/**
 * Turns the classification plus the repository's real capabilities into the
 * check plan, and persists it before anything runs.
 */
export function createDetermineChecksNode(ports: ReviewGraphPorts): GraphNodeFn {
  return async (state) => {
    if (state.classification === null) {
      throw new Error('determine_checks ran before analyze_changes');
    }
    const plan = buildReviewPlan({
      classification: state.classification,
      availableScripts: scriptFlags(ports),
      enableTests: ports.settings.enableTests,
      enableLint: ports.settings.enableLint,
      enableTypecheck: ports.settings.enableTypecheck,
      deepReviewAllowed: ports.settings.deepReview && ports.sandboxUnavailable === null,
      maxFiles: ports.settings.maxFiles,
    });

    await ports.persistence.savePlan(ports.reviewRunId, plan, plan.reasons);
    await publish(ports, {
      reviewRunId: ports.reviewRunId,
      type: 'log',
      message: `Review plan: ${describeReviewPlan(plan)} (${plan.reasons.slice(0, 4).join('; ')})`,
      progress: 15,
      data: { reasons: plan.reasons },
    });

    return { plan };
  };
}

/**
 * Executes the planned repository scripts in the sandbox. A missing capability
 * is recorded as a skipped check rather than a failure, so the review still
 * completes and says what it could not do.
 */
export function createRunChecksNode(ports: ReviewGraphPorts): GraphNodeFn {
  return async (state) => {
    if (state.plan === null) {
      throw new Error('run_checks ran before determine_checks');
    }
    const plans: readonly PlannedCheck[] = [
      {
        kind: 'test',
        enabled: state.plan.analyzeTests,
        disabledReason: state.plan.analyzeTests ? null : 'tests are outside this review plan',
      },
      {
        kind: 'lint',
        enabled: state.plan.analyzeLint,
        disabledReason: state.plan.analyzeLint ? null : 'lint is outside this review plan',
      },
      {
        kind: 'typecheck',
        enabled: state.plan.analyzeTypecheck,
        disabledReason: state.plan.analyzeTypecheck ? null : 'typecheck is outside this review plan',
      },
    ];

    const records: CheckExecutionRecord[] = [];
    for (const check of plans) {
      const script = pickScript(check.kind, ports.toolDeps.allowedScripts[check.kind]);
      const remainingMs = ports.budget.limits.maxDurationMs - ports.budget.elapsedMs();

      if (!check.enabled) {
        records.push(skippedRecord(check.kind, check.disabledReason ?? 'not planned', script));
        continue;
      }
      if (script === null) {
        records.push(
          skippedRecord(check.kind, `no allow-listed ${check.kind} script in package.json`, null),
        );
        continue;
      }
      if (ports.sandboxUnavailable !== null) {
        records.push(skippedRecord(check.kind, ports.sandboxUnavailable, script));
        continue;
      }
      if (remainingMs < 60_000) {
        records.push(
          skippedRecord(check.kind, 'review duration budget nearly exhausted; check not started', script),
        );
        continue;
      }

      await publish(ports, {
        reviewRunId: ports.reviewRunId,
        type: 'check.started',
        message: `Running ${check.kind}: npm run ${script}`,
        data: { kind: check.kind, script },
      });

      const outcome = await ports.toolDeps.launchCheck({
        kind: check.kind,
        script,
        args: [],
        timeoutMs: Math.min(ports.limits.checkTimeoutMs, remainingMs),
      });

      records.push(recordFromOutcome(check.kind, script, outcome));
      await publish(ports, {
        reviewRunId: ports.reviewRunId,
        type: 'check.finished',
        message: `${check.kind} ${outcome.status} (exit ${outcome.exitCode ?? 'n/a'}) in ${outcome.durationMs}ms`,
        status: outcome.status,
        data: { kind: check.kind, script, exitCode: outcome.exitCode },
      });
    }

    await ports.persistence.saveExecutions(ports.reviewRunId, records);
    return { commands: records };
  };
}

/**
 * Interprets recorded output. Parsing lives here, so a check that ran but
 * produced nothing readable is still honestly reported.
 */
export function createStaticAnalysisNode(ports: ReviewGraphPorts): GraphNodeFn {
  return async (state) => {
    if (state.commands.length === 0) {
      return skippedNode('static_analysis', 'no checks were executed');
    }

    const firstChangedFile = state.changedFiles[0]?.path ?? 'package.json';
    const analyses: AnalysisResult[] = [];
    const findings: FindingDraft[] = [];

    for (const record of state.commands) {
      if (record.status === 'skipped') {
        analyses.push({
          kind: record.kind,
          tool: record.tool,
          status: 'skipped',
          summary: record.skippedReason ?? 'skipped',
          findings: [],
          skippedReason: record.skippedReason ?? 'skipped',
        });
        continue;
      }

      const parsed = parseCheckOutput({
        kind: record.kind,
        tool: record.tool,
        stdout: record.stdout,
        stderr: record.stderr,
        workspaceDir: ports.workspace.root,
        maxFindings: ports.limits.maxFindings,
      });

      const failed = record.status !== 'succeeded';
      let analysisFindings: readonly FindingDraft[] = parsed;

      // A failing check with no parseable line is still one honest finding.
      if (failed && parsed.length === 0) {
        const fallback = fallbackFinding(record, firstChangedFile);
        if (fallback !== null) {
          analysisFindings = [fallback];
        }
      }

      analyses.push({
        kind: record.kind,
        tool: record.tool,
        status: record.status,
        summary: truncate(
          failed
            ? `${record.tool} reported a problem: ${record.summary}`
            : `${record.tool} completed without reported issues`,
          500,
        ),
        findings: analysisFindings,
        details: { exitCode: record.exitCode, durationMs: record.durationMs, sandbox: record.sandbox },
      });
      findings.push(...analysisFindings);
    }

    await publish(ports, {
      reviewRunId: ports.reviewRunId,
      type: 'log',
      message: `Static analysis produced ${findings.length} finding(s) from ${analyses.length} check(s)`,
      progress: 45,
      data: { findings: findings.length, analyses: analyses.length },
    });

    return { analyses, findings };
  };
}

function fallbackFinding(record: CheckExecutionRecord, file: string): FindingDraft | null {
  const parsed = FindingDraftSchema.safeParse({
    severity: record.kind === 'test' ? 'high' : 'medium',
    category: record.kind === 'test' ? 'testing' : 'bug',
    title: `${labelOf(record.kind)} failed on this change`,
    description: `${record.summary}\n\nThe review could not attribute this failure to individual lines. Read the command output recorded for this check before assuming the cause is unrelated to the pull request.`,
    file,
    line: null,
    suggestion: `Reproduce with \`${record.command}\` and fix the reported failure.`,
    confidence: 0.6,
    evidence: truncate(`${record.stdout}\n${record.stderr}`.trim(), 2000),
    source: record.kind === 'test' ? 'test_execution' : 'static_analysis',
    ruleId: null,
    metadata: { kind: record.kind, exitCode: record.exitCode, tool: record.tool },
  });
  return parsed.success ? parsed.data : null;
}

function recordFromOutcome(
  kind: CommandKind,
  script: string,
  outcome: CommandOutcome,
): CheckExecutionRecord {
  return {
    kind,
    tool: `npm run ${script}`,
    command: outcome.command,
    status: outcome.status,
    exitCode: outcome.exitCode,
    durationMs: outcome.durationMs,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    timedOut: outcome.timedOut,
    sandbox: outcome.sandbox,
    image: outcome.image,
    summary: `${outcome.command} -> ${outcome.status} (exit ${outcome.exitCode ?? 'n/a'}, ${outcome.durationMs}ms)`,
    findings: [],
    details: { script },
    skippedReason: null,
  };
}

function skippedRecord(
  kind: CommandKind,
  reason: string,
  script: string | null,
): CheckExecutionRecord {
  const command = script === null ? kind : `npm run ${script}`;
  return {
    kind,
    tool: command,
    command,
    status: 'skipped',
    exitCode: null,
    durationMs: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    sandbox: 'docker',
    image: null,
    summary: `skipped: ${reason}`,
    findings: [],
    details: { reason },
    skippedReason: reason,
  };
}

function scriptFlags(ports: ReviewGraphPorts): ScriptFlags {
  const allowed = ports.toolDeps.allowedScripts;
  return {
    test: pickScript('test', allowed['test']) !== null,
    lint: pickScript('lint', allowed['lint']) !== null,
    typecheck: pickScript('typecheck', allowed['typecheck']) !== null,
    build: pickScript('build', allowed['build']) !== null,
  };
}

const PREFERRED_SCRIPTS: Record<string, readonly string[]> = {
  test: ['test', 'test:unit', 'tests', 'test:ci'],
  lint: ['lint', 'eslint', 'lint:ci'],
  typecheck: ['typecheck', 'type-check', 'check:types', 'tsc'],
  build: ['build', 'compile'],
  static_analysis: ['analyze', 'lint', 'typecheck'],
  security_scan: ['security', 'audit', 'security:scan'],
};

/** Prefer the conventional script name, otherwise take what the repository offers. */
export function pickScript(kind: CommandKind, scripts: readonly string[] | undefined): string | null {
  if (scripts === undefined || scripts.length === 0) {
    return null;
  }
  const preferred = PREFERRED_SCRIPTS[kind] ?? [];
  for (const name of preferred) {
    if (scripts.includes(name)) {
      return name;
    }
  }
  return scripts[0] ?? null;
}

function labelOf(kind: CommandKind): string {
  switch (kind) {
    case 'test':
      return 'Test run';
    case 'lint':
      return 'Lint';
    case 'typecheck':
      return 'Typecheck';
    case 'security_scan':
      return 'Security scan';
    case 'static_analysis':
      return 'Static analysis';
    default:
      return 'Build';
  }
}
