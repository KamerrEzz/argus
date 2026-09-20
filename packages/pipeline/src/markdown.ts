import {
  REVIEW_COMMENT_MARKER,
  redactSecrets,
  stripAnsi,
  truncate,
  summarizeFindings,
  buildCheckRunSummary,
  checkRecordToOutcome,
  type CheckRunSummary,
  type FindingValidationOutcome,
  type PriorFindingReference,
  type ReviewVerdict,
  type Severity,
} from '@acr/shared';
import type { ReviewOutcome } from '@acr/ai';

const VERDICT_LABEL: Readonly<Record<ReviewVerdict, string>> = {
  passed: 'No blocking issues found',
  neutral: 'Review completed with notes',
  failed: 'Blocking issues found',
};

const SEVERITY_ORDER: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
const SEVERITY_ICON: Readonly<Record<Severity, string>> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🔵',
  info: '⚪',
};

export const MAX_COMMENT_CHARS = 60_000;
const MAX_FIELD_CHARS = 2_000;

/**
 * Everything in a review body is derived from pull-request content the author
 * controls, so links and raw HTML are neutralised before publishing. A comment
 * must never become a phishing vector or a way to hide a finding's origin.
 */
export function sanitizeUntrustedMarkdown(value: string, maxChars = MAX_FIELD_CHARS): string {
  // Line endings are normalised and invisible characters removed first, so a
  // control byte can never hide markup from the patterns below (and so the
  // published comment stays plain, terminal-free text). Tabs and newlines stay.
  const plain = stripAnsi(value.replace(/\r\n?/g, '\n')).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');

  const withoutHtml = plain
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?[a-z][\s\S]{0,200}>/gi, (tag) => tag.replace(/[<>]/g, ''));

  const withoutLinks = withoutHtml
    // Images from arbitrary hosts render as plain text. This runs BEFORE the
    // link pass: `![alt](url)` would otherwise be half-consumed by it.
    .replace(/!\[([^\]\n]{0,200})\]\(([^)\n]{0,400})\)/g, 'image: $1')
    // [text](url) -> text (url) : readable, but not clickable.
    .replace(/\[([^\]\n]{0,200})\]\(([^)\n]{0,400})\)/g, '$1 ($2)')
    // Bare autolinks are the other half of the same trick.
    .replace(/<((?:https?|file|javascript|data):[^>\n]{0,400})>/gi, '$1');

  // A stray heading would let content reshape the comment's outline.
  const flattened = withoutLinks.replace(/^#{1,6}\s+/gm, '');
  // Last sweep: comment openers/closers that survived the earlier passes only
  // as fragments (e.g. un-terminated `<!-->` or `<>`-stripped tags). No output
  // may contain `<!--` or `-->`, or two fields could team up to hide content.
  const withoutFragments = flattened.replace(/<!-->?|-->/g, '');
  return truncate(redactSecrets(withoutFragments), maxChars).trim();
}

export interface ReviewRenderContext {
  readonly outcome: ReviewOutcome;
  readonly reviewRunId: string;
  readonly repositoryFullName: string;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly model: string;
  readonly durationMs: number;
  readonly dashboardUrl: string | null;
  readonly generatedAt?: Date;
  /**
   * Findings raised by earlier runs on this pull request. They are what keeps a
   * re-review honest: without them the comment silently drops everything the
   * current run happened not to raise again.
   */
  readonly previousFindings?: readonly PriorFindingReference[];
}

export function findingSeverityIcon(severity: Severity): string {
  return SEVERITY_ICON[severity];
}

export function renderReviewComment(context: ReviewRenderContext): string {
  const { outcome } = context;
  const kept = outcome.validated.filter((entry) => entry.decision === 'keep');
  const actionable = kept.filter((entry) => entry.publishable);
  const summary = summarizeFindings(actionable.map((entry) => entry.finding));
  const verdict = outcome.verdict ?? 'neutral';
  const head = context.headSha.slice(0, 7);

  const lines: string[] = [];
  lines.push(REVIEW_COMMENT_MARKER);
  lines.push('');
  lines.push(`## ${verdictBadge(verdict)} AI Code Review — ${VERDICT_LABEL[verdict]}`);
  lines.push('');
  lines.push(
    `${actionable.length} actionable finding(s) of ${kept.length} kept · \`${head}\` · ${formatDuration(context.durationMs)}`,
  );
  if (summary.total > 0) {
    const breakdown = SEVERITY_ORDER.filter((severity) => summary.bySeverity[severity] > 0)
      .map((severity) => `${summary.bySeverity[severity]} ${severity}`)
      .join(' · ');
    lines.push(breakdown);
  }

  if (outcome.usage.estimatedCostUsd > 0) {
    lines.push(
      `Model \`${context.model}\` · ${outcome.usage.tokensIn + outcome.usage.tokensOut} tokens · ~$${outcome.usage.estimatedCostUsd.toFixed(3)}`,
    );
  }
  // The reviewer's own prose is the most useful part of the comment — and it is
  // still derived from pull-request content, so it passes through the sanitizer.
  const narrative = outcome.narrative.trim();
  if (narrative.length > 0) {
    lines.push('');
    lines.push(sanitizeUntrustedMarkdown(narrative, 8_000));
  }
  if (outcome.budgetExhausted) {
    lines.push('');
    lines.push(
      `> **Budget reached.** ${outcome.stoppedReason ?? 'The review stopped early; later parts of this diff were not analyzed.'}`,
    );
  }
  if (outcome.status === 'failed') {
    lines.push('');
    lines.push(`> **Incomplete.** ${sanitizeUntrustedMarkdown(outcome.error ?? 'a node failed', 600)}`);
  }

  lines.push(...renderProgress(context.previousFindings ?? [], outcome.validated));
  lines.push(...renderFindings(kept));
  lines.push(...renderChecks(outcome));
  lines.push(...renderWarnings(outcome));
  lines.push(...renderFooter(context, kept));

  const joined = lines.join('\n');
  // Reserve room for a closing fence so the final comment never exceeds the
  // cap even when truncation leaves a code block open.
  const cap = joined.length > MAX_COMMENT_CHARS - 4 ? MAX_COMMENT_CHARS - 4 : MAX_COMMENT_CHARS;
  return closeOpenCodeFence(truncate(joined, cap).trimEnd());
}

/** An unterminated fence at the cut would break everything after it on GitHub. */
function closeOpenCodeFence(markdown: string): string {
  const fences = markdown.match(/^ {0,3}```/gm);
  if (fences === null || fences.length % 2 === 0) {
    return markdown;
  }
  return `${markdown}\n\`\`\``;
}

function verdictBadge(verdict: ReviewVerdict): string {
  return verdict === 'failed' ? '❌' : verdict === 'passed' ? '✅' : '⚠️';
}

/**
 * Says what changed since the earlier runs on this pull request. A re-review
 * reports mostly new findings, so without this section the published comment
 * replaces a list of critical findings with a shorter list of notes and the
 * earlier findings appear to have been fixed when they were merely not raised
 * again. The wording never claims a finding was fixed: this run either saw it
 * again or it did not.
 */
function renderProgress(
  previous: readonly PriorFindingReference[],
  validated: readonly FindingValidationOutcome[],
): string[] {
  if (previous.length === 0) {
    return [];
  }
  const previousFingerprints = new Set(previous.map((entry) => entry.fingerprint));
  const current = new Set(validated.map((entry) => entry.fingerprint));

  const fresh = validated.filter(
    (entry) => entry.decision === 'keep' && !previousFingerprints.has(entry.fingerprint),
  ).length;
  const stillReported = previous.filter((entry) => current.has(entry.fingerprint)).length;
  const carried = previous.filter((entry) => !current.has(entry.fingerprint));

  const lines: string[] = ['', '### Progress since the previous review', ''];
  lines.push(`- **${fresh} new** — reported for the first time by this run`);
  lines.push(`- **${stillReported} still reported** — raised again by this run`);
  if (carried.length > 0) {
    const blocking = carried.filter(
      (entry) => entry.severity === 'critical' || entry.severity === 'high',
    ).length;
    const blockingNote = blocking > 0 ? `, including ${blocking} critical/high` : '';
    lines.push(
      `- **${carried.length} from earlier runs were not raised again**${blockingNote} — this run neither confirmed nor cleared them, so check them before merging`,
    );
    // Name what was carried over: a count alone still hides which earlier
    // findings are outstanding.
    const named = carried
      .filter(
        (entry): entry is PriorFindingReference & { title: string } =>
          typeof entry.title === 'string' && entry.title.trim().length > 0,
      )
      .slice(0, 10);
    for (const entry of named) {
      const location =
        entry.file === undefined
          ? ''
          : entry.line === null || entry.line === undefined
            ? `\`${entry.file}\``
            : `\`${entry.file}:${entry.line}\``;
      lines.push(
        `  - ${findingSeverityIcon(entry.severity)} ${sanitizeUntrustedMarkdown(entry.title, 200)}${location.length > 0 ? ` — ${location}` : ''}`,
      );
    }
    if (carried.length > named.length) {
      lines.push(`  - …and ${carried.length - named.length} more`);
    }
  }
  return lines;
}

function renderFindings(kept: readonly FindingValidationOutcome[]): string[] {
  if (kept.length === 0) {
    return ['', '_No findings were kept after validation._'];
  }
  const lines: string[] = ['', '### Findings'];
  for (const severity of SEVERITY_ORDER) {
    const group = kept.filter((entry) => entry.finding.severity === severity);
    if (group.length === 0) {
      continue;
    }
    lines.push('');
    lines.push(`#### ${findingSeverityIcon(severity)} ${severity} (${group.length})`);
    for (const entry of group) {
      lines.push(...renderFinding(entry));
    }
  }
  return lines;
}

function renderFinding(entry: FindingValidationOutcome): string[] {
  const { finding } = entry;
  const location =
    finding.line === null
      ? `\`${finding.file}\``
      : `\`${finding.file}:${finding.line}${finding.endLine === null || finding.endLine === finding.line ? '' : `-${finding.endLine}`}\``;

  const lines = [
    '',
    `- **${sanitizeUntrustedMarkdown(finding.title, 200)}** — ${location} · ${finding.category} · confidence ${(finding.confidence * 100).toFixed(0)}%${entry.publishable ? '' : ' · _suppressed_'}`,
  ];
  const description = sanitizeUntrustedMarkdown(finding.description);
  if (description.length > 0) {
    lines.push(`  ${description.replace(/\n+/g, ' ')}`);
  }
  if (finding.suggestion !== null && finding.suggestion.trim().length > 0) {
    lines.push(`  - **Suggestion:** ${sanitizeUntrustedMarkdown(finding.suggestion, 800)}`);
  }
  if (finding.evidence !== null && finding.evidence.trim().length > 0) {
    lines.push('  - **Evidence:**');
    for (const chunk of sanitizeUntrustedMarkdown(finding.evidence, 1_200).split('\n').slice(0, 12)) {
      lines.push(`    \`${chunk}\``.replace(/`{2}/g, '`'));
    }
  }
  return lines;
}

function renderChecks(outcome: ReviewOutcome): string[] {
  if (outcome.commands.length === 0) {
    return outcome.plan === null ? [] : ['', '_No checks were runnable for this change._'];
  }
  const lines: string[] = ['', '### Checks run', '', '| Kind | Command | Result | Time |', '| --- | --- | --- | --- |'];
  for (const command of outcome.commands) {
    const status =
      command.status === 'succeeded'
        ? '✅ passed'
        : command.status === 'skipped'
          ? '⏭️ skipped'
          : `❌ ${command.status}`;
    lines.push(
      `| ${command.kind} | \`${sanitizeUntrustedMarkdown(command.command, 120)}\` | ${status} (${command.exitCode ?? '—'}) | ${formatDuration(command.durationMs)} |`,
    );
  }
  if (outcome.skipped.length > 0) {
    lines.push('', `Skipped: ${outcome.skipped.map((reason) => sanitizeUntrustedMarkdown(reason, 160)).join(' · ')}`);
  }
  return lines;
}

function renderWarnings(outcome: ReviewOutcome): string[] {
  const notes = [...outcome.warnings];
  if (outcome.injectionSignals.length > 0) {
    const kinds = [...new Set(outcome.injectionSignals.map((signal) => signal.kind))].join(', ');
    notes.push(
      `Content in the pull request looked like prompt-injection attempts (${kinds}). It was treated as data, not instructions.`,
    );
  }
  if (notes.length === 0) {
    return [];
  }
  return ['', '### Notes', '', ...notes.slice(0, 12).map((note) => `> ${sanitizeUntrustedMarkdown(note, 400)}`)];
}

function renderFooter(context: ReviewRenderContext, kept: readonly FindingValidationOutcome[]): string[] {
  const lines: string[] = ['', '---'];
  if (context.dashboardUrl !== null) {
    lines.push(
      `Full agent trace, every finding and the raw check output: [review dashboard](${escapeMarkdownLinkPath(context.dashboardUrl)})`,
    );
  }
  const suppressed = kept.filter((entry) => !entry.publishable).length;
  lines.push(
    `Findings are suggestions from an automated reviewer, not a merge gate. ${suppressed > 0 ? `${suppressed} low-confidence item(s) were suppressed rather than published. ` : ''}If something here is wrong, reply and a human sees it too.`,
  );
  lines.push('');
  lines.push(`<!-- run:${context.reviewRunId} -->`);
  return lines;
}

/** Only allow an https-ish dashboard path we were handed, never model output. */
function escapeMarkdownLinkPath(url: string): string {
  return url.replace(/[)\s]/g, '%20');
}

export function renderCheckRun(context: ReviewRenderContext): CheckRunSummary {
  const { outcome } = context;
  const kept = outcome.validated.filter((entry) => entry.decision === 'keep' && entry.publishable);
  const summary = summarizeFindings(kept.map((entry) => entry.finding));
  const verdict = outcome.verdict ?? 'neutral';
  return buildCheckRunSummary({
    headline: `AI Code Review — ${VERDICT_LABEL[verdict]}`,
    filesAnalyzed: outcome.classification?.sourceFiles.length ?? summary.total,
    summary,
    outcomes: outcome.commands.map(checkRecordToOutcome),
    verdict,
  });
}

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    // A clock skew or missing timestamp must never render "NaNm NaNs".
    return '0ms';
  }
  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }
  const seconds = durationMs / 1_000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  }
  // Round once into whole seconds: rounding minutes and seconds separately can
  // produce "5m 60s".
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  const tail = `${minutes}m ${remainder}s`;
  return hours > 0 ? `${hours}h ${tail}` : tail;
}
