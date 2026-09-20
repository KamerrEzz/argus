import {
  SEVERITIES,
  type FindingDraft,
  type FindingSummary,
  type Severity,
  formatFindingSummary,
} from './findings';

export const REVIEW_RUN_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'awaiting_approval',
] as const;
export type ReviewRunStatus = (typeof REVIEW_RUN_STATUSES)[number];

export const REVIEW_TRIGGERS = ['webhook', 'manual', 'retry'] as const;
export type ReviewTrigger = (typeof REVIEW_TRIGGERS)[number];

export const REVIEW_VERDICTS = ['passed', 'neutral', 'failed'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export const CHECK_RUN_CONCLUSIONS = ['success', 'neutral', 'failure', 'cancelled', 'skipped'] as const;
export type CheckRunConclusion = (typeof CHECK_RUN_CONCLUSIONS)[number];

export const EXECUTION_STATUSES = ['pending', 'running', 'succeeded', 'failed', 'skipped', 'timed_out'] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const COMMAND_KINDS = [
  'test',
  'lint',
  'typecheck',
  'build',
  'static_analysis',
  'security_scan',
] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

export interface CommandOutcome {
  readonly kind: CommandKind;
  readonly command: string;
  readonly status: ExecutionStatus;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly sandbox: 'docker' | 'process';
  readonly image: string | null;
  readonly skippedReason?: string;
}

export interface CommandResult {
  readonly outcome: CommandOutcome;
  readonly summary: string;
  readonly failed: boolean;
}

export interface AnalysisResult {
  readonly kind: CommandKind;
  readonly tool: string;
  readonly status: ExecutionStatus;
  readonly summary: string;
  readonly findings: readonly FindingDraft[];
  readonly details?: Record<string, unknown>;
  readonly skippedReason?: string;
}

export interface BudgetExceededRecord {
  readonly limit: string;
  readonly details: Record<string, unknown>;
}

export interface ReviewPlan {
  readonly analyzeTests: boolean;
  readonly analyzeLint: boolean;
  readonly analyzeTypecheck: boolean;
  readonly analyzeSql: boolean;
  readonly analyzeSecurity: boolean;
  readonly analyzeDependencies: boolean;
  readonly analyzePerformance: boolean;
  readonly deepReview: boolean;
  readonly reasons: readonly string[];
}

export interface CheckPolicy {
  readonly failOnSeverities: readonly Severity[];
  readonly failOnFailedCommands: boolean;
  readonly neutralOnSeverities: readonly Severity[];
}

export const DEFAULT_CHECK_POLICY: CheckPolicy = {
  failOnSeverities: ['critical', 'high'],
  failOnFailedCommands: true,
  neutralOnSeverities: ['medium'],
};

export interface CheckRunSummary {
  readonly conclusion: CheckRunConclusion;
  readonly title: string;
  readonly summary: string;
  readonly text: string;
}

export function decideReviewVerdict(
  summary: FindingSummary,
  outcomes: readonly CommandOutcome[],
  policy: CheckPolicy = DEFAULT_CHECK_POLICY,
): ReviewVerdict {
  const blockingFinding = policy.failOnSeverities.some((severity) => summary.bySeverity[severity] > 0);
  if (blockingFinding) {
    return 'failed';
  }
  const failedCommand = outcomes.some(
    (outcome) => outcome.status === 'failed' || outcome.status === 'timed_out',
  );
  if (policy.failOnFailedCommands && failedCommand) {
    return 'failed';
  }
  const neutralFinding = policy.neutralOnSeverities.some((severity) => summary.bySeverity[severity] > 0);
  const skippedCommand = outcomes.some((outcome) => outcome.status === 'skipped');
  if (neutralFinding || skippedCommand || failedCommand) {
    return 'neutral';
  }
  return 'passed';
}

export function verdictToConclusion(verdict: ReviewVerdict): CheckRunConclusion {
  if (verdict === 'passed') {
    return 'success';
  }
  if (verdict === 'failed') {
    return 'failure';
  }
  return 'neutral';
}

function commandLine(outcome: CommandOutcome): string {
  if (outcome.status === 'succeeded') {
    return `+ ${outcome.kind}: passed (${outcome.durationMs}ms)`;
  }
  if (outcome.status === 'skipped') {
    return `- ${outcome.kind}: skipped${outcome.skippedReason ? ` (${outcome.skippedReason})` : ''}`;
  }
  if (outcome.status === 'timed_out') {
    return `x ${outcome.kind}: timed out after ${outcome.durationMs}ms`;
  }
  return `x ${outcome.kind}: failed with exit code ${outcome.exitCode ?? 'unknown'}`;
}

export function buildCheckRunSummary(input: {
  readonly headline: string;
  readonly filesAnalyzed: number;
  readonly summary: FindingSummary;
  readonly outcomes: readonly CommandOutcome[];
  readonly verdict: ReviewVerdict;
}): CheckRunSummary {
  const { summary, outcomes, verdict } = input;
  const lines: string[] = [];
  lines.push(`**${input.headline}**`);
  lines.push('');
  lines.push(`${input.filesAnalyzed} file(s) analyzed`);
  lines.push('');
  lines.push('Findings:');
  if (summary.total === 0) {
    lines.push('- none');
  } else {
    for (const severity of SEVERITIES) {
      const count = summary.bySeverity[severity];
      if (count > 0) {
        lines.push(`- ${count} ${severity}`);
      }
    }
  }
  if (outcomes.length > 0) {
    lines.push('');
    lines.push('Checks:');
    for (const outcome of outcomes) {
      lines.push(`- ${commandLine(outcome)}`);
    }
  }
  return {
    conclusion: verdictToConclusion(verdict),
    title: verdict === 'passed' ? 'Review passed' : verdict === 'failed' ? 'Review failed' : 'Review completed with notes',
    summary: `${formatFindingSummary(summary)} across ${input.filesAnalyzed} file(s)`,
    text: lines.join('\n'),
  };
}
