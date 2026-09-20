'use client';

// Review run detail: verdict, usage, plan, findings, checks, agent node trace,
// and the reviewer actions (retry, publish, reject, SARIF export).

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import {
  buildSarifReport,
  changedFileLabel,
  downloadTextFile,
  errorMessage,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatUsd,
  reviews,
  shortId,
} from '@/lib/api';
import type { AgentExecution, ReviewFinding, ReviewRunDetail, Severity, TestExecution } from '@/lib/types';
import {
  Card,
  DangerButton,
  ExecutionStatusBadge,
  PageHeader,
  PrimaryButton,
  SecondaryButton,
  SeverityBadge,
  Shell,
  StatusBadge,
  VerdictBadge,
  inputClass,
} from '@/components/layout';
import { DataTable, type Column, type SortState } from '@/components/table';
import { useToast } from '@/components/toast';

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

const RUNNING_STATUSES: ReadonlySet<string> = new Set(['queued', 'running']);

export default function ReviewDetailPage() {
  return (
    <Shell>
      <ReviewDetailView />
    </Shell>
  );
}

function ReviewDetailView() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const toast = useToast();

  const [run, setRun] = useState<ReviewRunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(
    async (showSkeleton: boolean) => {
      if (showSkeleton) {
        setLoading(true);
      }
      try {
        const detail = await reviews.get(id);
        setRun(detail);
      } catch (error) {
        toast.error(errorMessage(error));
        if (showSkeleton) {
          setRun(null);
        }
      } finally {
        if (showSkeleton) {
          setLoading(false);
        }
      }
    },
    [id, toast],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  // Live-ish refresh while the run is still moving.
  useEffect(() => {
    if (run === null || !RUNNING_STATUSES.has(run.status)) {
      return;
    }
    const timer = setInterval(() => {
      void load(false);
    }, 5000);
    return () => {
      clearInterval(timer);
    };
  }, [run, load]);

  async function handleRetry() {
    setBusy('retry');
    try {
      const result = await reviews.retry(id);
      toast.success('New review run started.');
      router.push(`/reviews/${result.reviewRunId}`);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function handleDecision(action: 'publish' | 'reject') {
    setBusy(action);
    try {
      if (action === 'publish') {
        await reviews.publish(id, reason.trim().length > 0 ? reason.trim() : undefined);
        toast.success('Approval recorded — publishing the review.');
      } else {
        await reviews.reject(id, reason.trim().length > 0 ? reason.trim() : undefined);
        toast.success('Review rejected.');
      }
      setReason('');
      await load(false);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  function handleSarif() {
    if (run === null) {
      return;
    }
    downloadTextFile(
      `review-${run.id.slice(0, 8)}.sarif`,
      'application/sarif+json',
      buildSarifReport(run),
    );
    toast.info('SARIF report downloaded.');
  }

  const sortedFindings = useMemo(() => {
    if (run === null) {
      return [] as ReviewFinding[];
    }
    return run.findings;
  }, [run]);

  const severityCounts = useMemo(() => {
    const counts: Record<Severity, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
    };
    for (const finding of run?.findings ?? []) {
      counts[finding.severity] += 1;
    }
    return counts;
  }, [run]);

  if (loading) {
    return (
      <div className="mx-auto max-w-6xl space-y-4" role="status" aria-label="Loading review run">
        <div className="h-8 w-80 animate-pulse rounded bg-surface-raised" />
        <div className="h-24 animate-pulse rounded-xl bg-surface" />
        <div className="h-72 animate-pulse rounded-xl bg-surface" />
        <span className="sr-only">Loading review run…</span>
      </div>
    );
  }

  if (run === null) {
    return (
      <div className="mx-auto max-w-3xl py-16 text-center">
        <h2 className="text-lg font-semibold text-ink">Review run unavailable</h2>
        <p className="mt-2 text-sm text-ink-muted">It no longer exists or you cannot access it.</p>
        <Link
          href="/reviews"
          className="mt-4 inline-block rounded-lg bg-accent px-4 py-2 text-sm font-medium text-canvas hover:bg-accent/90 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
        >
          Back to review runs
        </Link>
      </div>
    );
  }

  const awaitingDecision = run.status === 'awaiting_approval';

  const findingColumns: Column<ReviewFinding>[] = [
    {
      key: 'severity',
      header: 'Severity',
      sortValue: (finding) => SEVERITY_RANK[finding.severity],
      render: (finding) => <SeverityBadge severity={finding.severity} />,
    },
    {
      key: 'title',
      header: 'Finding',
      sortValue: (finding) => finding.title,
      render: (finding) => (
        <div className="min-w-72 max-w-xl">
          <p className="font-medium text-ink">{finding.title}</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-muted line-clamp-3">
            {finding.description}
          </p>
          {finding.suggestion !== null && finding.suggestion.trim().length > 0 && (
            <p className="mt-1 text-xs text-status-success">Suggestion: {finding.suggestion}</p>
          )}
        </div>
      ),
    },
    {
      key: 'file',
      header: 'Location',
      sortValue: (finding) => finding.file ?? '',
      render: (finding) => (
        <span className="font-mono text-xs break-all text-ink-muted">
          {finding.file ?? '—'}
          {finding.line !== null && `:${finding.line}`}
        </span>
      ),
    },
    {
      key: 'category',
      header: 'Category',
      sortValue: (finding) => finding.category,
      render: (finding) => <span className="text-xs text-ink-muted">{finding.category}</span>,
    },
    {
      key: 'source',
      header: 'Source',
      sortValue: (finding) => finding.source,
      render: (finding) => (
        <span className="font-mono text-xs text-ink-faint">{finding.source.replaceAll('_', ' ')}</span>
      ),
    },
    {
      key: 'confidence',
      header: 'Confidence',
      sortValue: (finding) => finding.confidence,
      render: (finding) => <span className="text-xs text-ink-muted">{Math.round(finding.confidence * 100)}%</span>,
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (finding) => finding.status,
      render: (finding) => (
        <span
          className={`text-xs ${finding.publishable ? 'font-medium text-ink' : 'text-ink-faint'}`}
        >
          {finding.status}
          {finding.publishable ? ' · publishable' : ''}
        </span>
      ),
    },
  ];

  const defaultFindingSort: SortState = { key: 'severity', direction: 'asc' };

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={`Review ${shortId(run.id)}`}
        description={`${run.repository.fullName} · ${run.pullRequest !== null ? `#${run.pullRequest.number} ${run.pullRequest.title}` : 'pull request removed'} · triggered by ${run.trigger}`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link
              href={`/reviews/${run.id}/events`}
              className="inline-flex items-center rounded-lg border border-border-strong bg-surface px-3.5 py-2 text-sm font-medium text-ink-muted hover:bg-surface-raised hover:text-ink focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
            >
              Live events
            </Link>
            <Link
              href={`/reviews/${run.id}/approvals`}
              className="inline-flex items-center rounded-lg border border-border-strong bg-surface px-3.5 py-2 text-sm font-medium text-ink-muted hover:bg-surface-raised hover:text-ink focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
            >
              Approvals
            </Link>
            <SecondaryButton onClick={handleSarif}>Download SARIF</SecondaryButton>
            <SecondaryButton
              onClick={() => {
                void handleRetry();
              }}
              busy={busy === 'retry'}
              title="Start a fresh run on the current head"
            >
              Retry
            </SecondaryButton>
          </div>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <StatusBadge status={run.status} />
        <div className="flex items-center gap-1.5 text-sm">
          <span className="text-ink-faint">Verdict:</span>
          <VerdictBadge verdict={run.verdict} />
        </div>
        <span className="text-sm text-ink-faint">
          created {formatDateTime(run.createdAt)} · finished{' '}
          {formatDateTime(run.finishedAt)} · {formatDuration(run.durationMs)}
        </span>
      </div>

      {run.summary !== null && run.summary.trim().length > 0 && (
        <Card title="Narrative summary" className="mb-6">
          <RichText text={run.summary} />
        </Card>
      )}

      {run.error !== null && run.error.trim().length > 0 && (
        <div
          role="alert"
          className="mb-6 rounded-xl border border-status-failure bg-surface p-4 text-sm text-status-failure"
        >
          Run error: {run.error}
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
        <Tile label="Critical" value={severityCounts.critical} tone="failure" />
        <Tile label="High" value={severityCounts.high} tone="warning" />
        <Tile label="Medium" value={severityCounts.medium} tone="neutral" />
        <Tile label="Low" value={severityCounts.low} tone="accent" />
        <Tile label="Info" value={severityCounts.info} tone="muted" />
        <Tile label="Total" value={run.findings.length} tone="default" />
      </div>

      {awaitingDecision && (
        <Card title="Publish decision required" className="mb-6 border-status-neutral">
          <p className="mb-3 text-sm text-ink-muted">
            This run is waiting for a reviewer. Approving publishes the summary comment, inline
            findings, and check run to GitHub.
          </p>
          <label htmlFor="decision-reason" className="sr-only">
            Optional reason for the decision
          </label>
          <textarea
            id="decision-reason"
            rows={2}
            maxLength={2000}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
            placeholder="Optional note recorded with the decision…"
            className={inputClass}
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <PrimaryButton
              onClick={() => {
                void handleDecision('publish');
              }}
              busy={busy === 'publish'}
            >
              Approve &amp; publish
            </PrimaryButton>
            <DangerButton
              onClick={() => {
                void handleDecision('reject');
              }}
              busy={busy === 'reject'}
            >
              Reject
            </DangerButton>
          </div>
        </Card>
      )}

      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title="Usage & cost">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <StatLine label="Tokens in" value={formatNumber(run.tokens.input)} />
            <StatLine label="Tokens out" value={formatNumber(run.tokens.output)} />
            <StatLine label="Estimated cost" value={formatUsd(run.estimatedCostUsd)} />
            <StatLine label="Model" value={run.model} />
            <StatLine label="Iterations" value={formatNumber(run.iterations)} />
            <StatLine label="Tool calls" value={formatNumber(run.toolCalls)} />
            <StatLine label="Files analyzed" value={formatNumber(run.filesAnalyzed)} />
            <StatLine
              label="Budget limit"
              value={run.budgetLimit ?? 'none'}
              danger={run.budgetLimit !== null}
            />
          </dl>
          {run.budgetLimit !== null && (
            <p className="mt-3 rounded-lg bg-surface-raised px-3 py-2 text-xs text-status-neutral">
              The run stopped at a budget limit: <span className="font-mono">{run.budgetLimit}</span>.
            </p>
          )}
          <div className="mt-4 flex flex-wrap gap-4 text-xs text-ink-faint">
            <span>
              head <span className="font-mono text-ink-muted">{run.headSha.slice(0, 10)}</span>
            </span>
            <span>
              base <span className="font-mono text-ink-muted">{run.baseSha.slice(0, 10)}</span>
            </span>
            {run.commentId !== null && <span className="font-mono">comment {run.commentId}</span>}
            {run.checkRunId !== null && <span className="font-mono">check {run.checkRunId}</span>}
          </div>
        </Card>

        <Card title="Review plan">
          {run.plan === null ? (
            <p className="text-sm text-ink-muted">
              The plan is produced once the run starts analyzing the diff.
            </p>
          ) : (
            <>
              <ul className="grid grid-cols-2 gap-1.5 text-sm" aria-label="Enabled analysis passes">
                <PlanFlag label="Tests" on={run.plan.analyzeTests} />
                <PlanFlag label="Lint" on={run.plan.analyzeLint} />
                <PlanFlag label="Typecheck" on={run.plan.analyzeTypecheck} />
                <PlanFlag label="SQL" on={run.plan.analyzeSql} />
                <PlanFlag label="Security" on={run.plan.analyzeSecurity} />
                <PlanFlag label="Dependencies" on={run.plan.analyzeDependencies} />
                <PlanFlag label="Performance" on={run.plan.analyzePerformance} />
                <PlanFlag label="Deep review" on={run.plan.deepReview} />
              </ul>
              {run.planReasons.length > 0 && (
                <ul className="mt-4 space-y-1 text-xs text-ink-faint">
                  {run.planReasons.map((entry) => (
                    <li key={entry} className="font-mono">
                      · {entry}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {run.changedFiles.length > 0 && (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm text-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none">
                {run.changedFiles.length} changed file(s)
              </summary>
              <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto font-mono text-xs text-ink-muted">
                {run.changedFiles.map((entry, index) => (
                  <li key={index}>{changedFileLabel(entry)}</li>
                ))}
              </ul>
            </details>
          )}
        </Card>
      </div>

      <Card title={`Findings (${run.findings.length})`} className="mb-6">
        <DataTable
          caption="Review findings"
          columns={findingColumns}
          rows={sortedFindings}
          keyOf={(finding) => finding.id}
          emptyMessage="No findings"
          emptyHint="The reviewer had nothing to flag on this diff — that is a good outcome."
          defaultSort={defaultFindingSort}
        />
      </Card>

      <div className="mb-6">
        <Card title={`Check runs (${run.testExecutions.length})`}>
          {run.testExecutions.length === 0 ? (
            <p className="text-sm text-ink-muted">
              No checks were runnable for this change.
            </p>
          ) : (
            <ul className="space-y-2">
              {run.testExecutions.map((execution) => (
                <CheckRow key={execution.id} execution={execution} />
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Agent node trace">
        {run.agentExecutions.length === 0 ? (
          <p className="text-sm text-ink-muted">
            The agent has not started yet — stream the live events for progress.
          </p>
        ) : (
          <div className="space-y-6">
            {run.agentExecutions.map((agent) => (
              <AgentTrace key={agent.id} agent={agent} />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- pieces

function Tile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'default' | 'failure' | 'warning' | 'neutral' | 'accent' | 'muted';
}) {
  const toneClass =
    tone === 'failure'
      ? 'text-severity-critical'
      : tone === 'warning'
        ? 'text-severity-high'
        : tone === 'neutral'
          ? 'text-severity-medium'
          : tone === 'accent'
            ? 'text-severity-low'
            : tone === 'muted'
              ? 'text-ink-faint'
              : 'text-ink';
  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-3">
      <p className="text-xs text-ink-faint">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${toneClass}`}>{value}</p>
    </div>
  );
}

function StatLine({ label, value, danger = false }: { label: string; value: string; danger?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-ink-faint">{label}</dt>
      <dd className={`mt-0.5 font-mono text-sm ${danger ? 'text-status-neutral' : 'text-ink'}`}>{value}</dd>
    </div>
  );
}

function PlanFlag({ label, on }: { label: string; on: boolean }) {
  return (
    <li className="flex items-center justify-between rounded-lg bg-surface-raised px-3 py-1.5">
      <span className="text-ink-muted">{label}</span>
      <span className={`font-medium ${on ? 'text-status-success' : 'text-ink-faint'}`}>
        {on ? 'on' : 'off'}
      </span>
    </li>
  );
}

function CheckRow({ execution }: { execution: TestExecution }) {
  const output = [execution.stdout, execution.stderr].filter((part) => part.trim().length > 0);
  return (
    <li className="rounded-lg border border-border-subtle bg-surface-raised">
      <details>
        <summary className="flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none">
          <span className="font-mono text-xs text-ink">{execution.kind}</span>
          <ExecutionStatusBadge status={execution.status} />
          <span className="font-mono text-xs text-ink-faint">{execution.command}</span>
          <span className="ml-auto text-xs text-ink-faint">
            {execution.exitCode !== null && `exit ${execution.exitCode} · `}
            {formatDuration(execution.durationMs)}
          </span>
        </summary>
        <div className="border-t border-border-subtle px-3 py-2">
          {execution.skippedReason !== null && (
            <p className="mb-2 text-xs text-status-neutral">Skipped: {execution.skippedReason}</p>
          )}
          {output.length === 0 ? (
            <p className="text-xs text-ink-faint">No captured output.</p>
          ) : (
            <pre className="max-h-64 overflow-auto rounded bg-canvas p-3 font-mono text-xs text-ink-muted">
              {output.join('\n')}
            </pre>
          )}
        </div>
      </details>
    </li>
  );
}

function AgentTrace({ agent }: { agent: AgentExecution }) {
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <h4 className="font-mono text-sm font-semibold text-ink">{agent.graphName}</h4>
        <ExecutionStatusBadge status={agent.status} />
        <span className="text-xs text-ink-faint">
          {agent.model} · {agent.iterations} iterations · {agent.toolCalls} tool calls ·{' '}
          {formatNumber(agent.tokensIn + agent.tokensOut)} tokens · {formatUsd(agent.estimatedCostUsd)}
        </span>
      </div>
      {agent.error !== null && agent.error.trim().length > 0 && (
        <p className="mb-2 text-xs text-status-failure">{agent.error}</p>
      )}
      <ol className="space-y-3">
        {agent.nodes.map((node) => (
          <li key={node.id} className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className={`mt-1 h-3 w-3 shrink-0 rounded-full ring-2 ring-canvas ${
                node.status === 'succeeded'
                  ? 'bg-status-success'
                  : node.status === 'failed' || node.status === 'timed_out'
                    ? 'bg-status-failure'
                    : node.status === 'running'
                      ? 'bg-accent'
                      : 'bg-border-strong'
              }`}
            />
            <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-mono text-sm font-medium text-ink">{node.node}</span>
              <ExecutionStatusBadge status={node.status} />
              <time dateTime={node.startedAt} className="text-xs text-ink-faint">
                {formatDateTime(node.startedAt)}
              </time>
              <span className="text-xs text-ink-faint">
                {formatDuration(node.durationMs)}
                {node.attempt > 1 && ` · attempt ${node.attempt}`}
              </span>
            </div>
            {node.summary !== null && node.summary.trim().length > 0 && (
              <p className="mt-0.5 text-xs text-ink-muted">{node.summary}</p>
            )}
            {node.error !== null && node.error.trim().length > 0 && (
              <p className="mt-0.5 text-xs text-status-failure">{node.error}</p>
            )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Minimal safe renderer for the run summary: paragraphs, `code`, **bold**, - lists. */
function RichText({ text }: { text: string }) {
  return (
    <div className="space-y-3 text-sm leading-relaxed text-ink-muted">
      {text.split(/\n{2,}/).map((block, blockIndex) => (
        <RichBlock key={blockIndex} block={block} />
      ))}
    </div>
  );
}

function RichBlock({ block }: { block: string }) {
  const lines = block.split('\n');
  const isList = lines.every((line) => /^\s*[-*]\s+/.test(line) || line.trim().length === 0);
  if (isList) {
    return (
      <ul className="list-disc space-y-1 pl-5">
        {lines
          .filter((line) => line.trim().length > 0)
          .map((line, index) => (
            <li key={index}>{renderInline(line.replace(/^\s*[-*]\s+/, ''))}</li>
          ))}
      </ul>
    );
  }
  return <p>{lines.map((line, index) => <span key={index}>{index > 0 && <br />}{renderInline(line)}</span>)}</p>;
}

function renderInline(line: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(line)) !== null) {
    if (match.index > cursor) {
      parts.push(line.slice(cursor, match.index));
    }
    const token = match[0] ?? '';
    if (token.startsWith('`')) {
      parts.push(
        <code key={key} className="rounded bg-surface-raised px-1 py-0.5 font-mono text-xs text-ink">
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      parts.push(
        <strong key={key} className="font-semibold text-ink">
          {token.slice(2, -2)}
        </strong>,
      );
    }
    cursor = match.index + token.length;
    key += 1;
  }
  if (cursor < line.length) {
    parts.push(line.slice(cursor));
  }
  return parts;
}
