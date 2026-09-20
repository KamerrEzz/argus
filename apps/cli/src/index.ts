import { createLogger, getConfig } from '@acr/config';
import {
  createContainer,
  executeReview,
  formatDuration,
  requestReview,
  type ReviewExecutionResult,
} from '@acr/pipeline';
import type { ReviewEvent } from '@acr/shared';
import { USAGE, parseArgs } from './args';

const COLOR = process.env['NO_COLOR'] === undefined && process.stdout.isTTY === true;

function paint(code: string, value: string): string {
  return COLOR ? `\u001b[${code}m${value}\u001b[0m` : value;
}

const dim = (value: string): string => paint('2', value);
const bold = (value: string): string => paint('1', value);
const red = (value: string): string => paint('31', value);
const green = (value: string): string => paint('32', value);
const yellow = (value: string): string => paint('33', value);

function renderEvent(event: ReviewEvent): string | null {
  switch (event.type) {
    case 'node.started':
      return dim(`  … ${event.node ?? event.message}`);
    case 'node.finished':
      return `  ${event.status === 'failed' ? red('✗') : green('✓')} ${event.node ?? ''} ${dim(`(${event.message})`)}`;
    case 'check.started':
      return dim(`  ▶ ${event.message}`);
    case 'check.finished':
      return `  ${event.status === 'succeeded' ? green('✓') : yellow('!')} ${event.message}`;
    case 'tool.started':
      return dim(`  · ${event.tool ?? 'tool'} ${event.message}`);
    case 'finding.created':
      return `  ${yellow('•')} ${event.message}`;
    case 'warning':
      return yellow(`  ! ${event.message}`);
    case 'error':
      return red(`  ✗ ${event.message}`);
    case 'run.failed':
      return red(`  ✗ ${event.message}`);
    case 'heartbeat':
      return null;
    default:
      return dim(`  ${event.message}`);
  }
}

function printResult(result: ReviewExecutionResult, json: boolean): void {
  if (json) {
    const payload = {
      reviewRunId: result.reviewRunId,
      status: result.status,
      verdict: result.verdict,
      reason: result.reason,
      durationMs: result.durationMs,
      findings: result.findings,
      published: result.published,
      usage: result.outcome?.usage ?? null,
      summary: result.outcome?.summary ?? null,
      narrative: result.outcome?.narrative ?? null,
      skipped: result.outcome?.skipped ?? [],
      warnings: result.outcome?.warnings ?? [],
      nodeTrace: result.outcome?.nodeTrace.map((entry) => ({
        node: entry.node,
        status: entry.status,
        durationMs: entry.durationMs,
      })),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  const outcome = result.outcome;
  process.stdout.write('\n');
  process.stdout.write(`${bold('verdict ')} ${verdictText(result.verdict)}\n`);
  process.stdout.write(
    `${bold('findings')} ${result.findings.publishable} actionable / ${result.findings.total} kept\n`,
  );
  if (outcome !== null) {
    process.stdout.write(
      `${bold('cost     ')} ${outcome.usage.tokensIn + outcome.usage.tokensOut} tokens, ~$${outcome.usage.estimatedCostUsd.toFixed(3)}\n`,
    );
    process.stdout.write(`${bold('time     ')} ${formatDuration(result.durationMs)}\n`);
    const prose = (outcome.narrative.trim().length > 0 ? outcome.narrative : outcome.summary).trim();
    if (prose.length > 0) {
      process.stdout.write(`\n${prose}\n`);
    }
    for (const warning of outcome.warnings.slice(0, 5)) {
      process.stdout.write(`${yellow(`warning: ${warning}`)}\n`);
    }
  }
  process.stdout.write(`${bold('published')} ${publishText(result.published.skippedReason)}\n`);
}

function verdictText(verdict: ReviewExecutionResult['verdict']): string {
  if (verdict === 'failed') {
    return red('failed');
  }
  if (verdict === 'passed') {
    return green('passed');
  }
  return yellow(verdict ?? 'unknown');
}

function publishText(reason: string | null): string {
  if (reason === null) {
    return green('yes');
  }
  return `${yellow('no')} ${dim(`(${reason})`)}`;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const base = getConfig();
  const config =
    options.model === null ? base : { ...base, llm: { ...base.llm, model: options.model } };

  const container = await createContainer({
    config,
    requireRedis: false,
    logger: createLogger({
      name: 'acr-review',
      level: options.quiet || options.json ? 'error' : 'info',
      pretty: false,
    }),
  });

  const controller = new AbortController();
  let stream: Promise<void> = Promise.resolve();

  try {
    const requested = await requestReview(container, {
      repository: options.repository,
      pullRequestNumber: options.pullRequestNumber,
      trigger: 'manual',
      requestedBy: `${process.env['USER'] ?? process.env['USERNAME'] ?? 'cli'}`,
      ...(options.fresh ? { idempotencyKey: `cli:${Date.now()}` } : {}),
    });

    if (!options.json) {
      process.stdout.write(
        `${bold(`reviewing ${options.repository}#${options.pullRequestNumber}`)} ${dim(`run ${requested.reviewRunId}`)}\n`,
      );
      if (!requested.created) {
        process.stdout.write(dim('  reusing the existing review run for this head commit (--fresh to force a new one)\n'));
      }
      stream = container.events.subscribe({
        reviewRunId: requested.reviewRunId,
        signal: controller.signal,
        blockMs: 5_000,
        onEvent: (event) => {
          const line = renderEvent(event);
          if (line !== null) {
            process.stdout.write(`${line}\n`);
          }
        },
      });
    }

    const result = await executeReview(container, requested.reviewRunId, {
      publish: options.publish,
      allowChecks: options.checks,
    });

    controller.abort();
    await stream.catch(() => undefined);
    printResult(result, options.json);

    if (result.status === 'completed' && result.outcome?.status !== 'failed') {
      return 0;
    }
    return 1;
  } finally {
    controller.abort();
    await container.close();
  }
}

if (require.main === module) {
  void main().then(
    (code) => {
      process.exit(code);
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${red('error')} ${message}\n`);
      if (process.env['DEBUG'] !== undefined && error instanceof Error && error.stack) {
        process.stderr.write(`${dim(error.stack)}\n`);
      }
      process.exit(1);
    },
  );
}

export { main };
