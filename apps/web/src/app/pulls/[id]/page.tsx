'use client';

// Pull request detail: mirrored GitHub state, description, review history, and
// the two actions that matter — refresh from GitHub and trigger a review.

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  errorMessage,
  formatDateTime,
  formatRelative,
  formatUsd,
  pullRequests,
} from '@/lib/api';
import type { PullRequestDetail, ReviewRunSummary } from '@/lib/types';
import {
  Card,
  PageHeader,
  PrimaryButton,
  SecondaryButton,
  Shell,
  StatusBadge,
  VerdictBadge,
} from '@/components/layout';
import { DataTable, type Column, type SortState } from '@/components/table';
import { useToast } from '@/components/toast';

export default function PullRequestDetailPage() {
  return (
    <Shell>
      <PullRequestDetailView />
    </Shell>
  );
}

function PullRequestDetailView() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const toast = useToast();

  const [pr, setPr] = useState<PullRequestDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyReview, setBusyReview] = useState(false);
  const [busySync, setBusySync] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPr(await pullRequests.get(id));
    } catch (error) {
      toast.error(errorMessage(error));
      setPr(null);
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function triggerReview() {
    setBusyReview(true);
    try {
      const result = await pullRequests.review(id);
      toast.success(
        result.created ? 'Review run created.' : 'A run already exists for this head commit.',
      );
      router.push(`/reviews/${result.reviewRunId}`);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusyReview(false);
    }
  }

  async function syncFromGithub() {
    setBusySync(true);
    try {
      setPr(await pullRequests.sync(id));
      toast.success('Pull request refreshed from GitHub.');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusySync(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl space-y-4" role="status" aria-label="Loading pull request">
        <div className="h-8 w-96 animate-pulse rounded bg-surface-raised" />
        <div className="h-32 animate-pulse rounded-xl bg-surface" />
        <div className="h-64 animate-pulse rounded-xl bg-surface" />
        <span className="sr-only">Loading pull request…</span>
      </div>
    );
  }

  if (pr === null) {
    return (
      <div className="mx-auto max-w-3xl py-16 text-center">
        <h2 className="text-lg font-semibold text-ink">Pull request unavailable</h2>
        <p className="mt-2 text-sm text-ink-muted">It no longer exists or you cannot access it.</p>
        <Link
          href="/pulls"
          className="mt-4 inline-block rounded-lg bg-accent px-4 py-2 text-sm font-medium text-canvas hover:bg-accent/90 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
        >
          Back to pull requests
        </Link>
      </div>
    );
  }

  const columns: Column<ReviewRunSummary>[] = [
    {
      key: 'createdAt',
      header: 'Started',
      sortValue: (run) => run.createdAt,
      render: (run) => (
        <time dateTime={run.createdAt} className="text-ink-muted">
          {formatRelative(run.createdAt)}
        </time>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (run) => <StatusBadge status={run.status} />,
    },
    {
      key: 'verdict',
      header: 'Verdict',
      render: (run) => <VerdictBadge verdict={run.verdict} />,
    },
    {
      key: 'trigger',
      header: 'Trigger',
      render: (run) => <span className="font-mono text-xs text-ink-faint">{run.trigger}</span>,
    },
    {
      key: 'findings.total',
      header: 'Findings',
      sortValue: (run) => run.findings.total,
      render: (run) => (
        <span className="text-ink-muted">
          {run.findings.total}
          {run.findings.critical > 0 && (
            <span className="ml-1 text-status-failure">({run.findings.critical} crit)</span>
          )}
        </span>
      ),
    },
    {
      key: 'cost',
      header: 'Cost',
      sortValue: (run) => Number.parseFloat(run.estimatedCostUsd) || 0,
      render: (run) => <span className="text-ink-muted">{formatUsd(run.estimatedCostUsd)}</span>,
    },
    {
      key: 'open',
      header: '',
      render: (run) => (
        <Link
          href={`/reviews/${run.id}`}
          className="rounded text-sm text-accent hover:underline focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
        >
          Open run
        </Link>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={`#${pr.number} ${pr.title}`}
        description={`${pr.repository.fullName} · opened by ${pr.author} · ${formatDateTime(pr.createdAt)}`}
        actions={
          <div className="flex flex-wrap gap-2">
            <SecondaryButton
              onClick={() => {
                void syncFromGithub();
              }}
              busy={busySync}
            >
              Sync from GitHub
            </SecondaryButton>
            <PrimaryButton
              onClick={() => {
                void triggerReview();
              }}
              busy={busyReview}
              title="Requires triage access on the repository"
            >
              Review now
            </PrimaryButton>
          </div>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3 text-sm">
        <span
          className={`rounded-full px-2.5 py-0.5 font-medium ${
            pr.state === 'open'
              ? 'bg-accent-soft text-status-success'
              : pr.state === 'merged'
                ? 'bg-accent-soft text-accent'
                : 'bg-surface-raised text-ink-faint'
          }`}
        >
          {pr.state}
        </span>
        {pr.draft && <span className="rounded-full bg-surface-raised px-2.5 py-0.5 text-ink-muted">draft</span>}
        <span className="font-mono text-xs text-ink-faint">
          {pr.headRef} <span aria-hidden="true">→</span> {pr.baseRef}
        </span>
        <span className="font-mono text-xs text-ink-faint">head {pr.headSha.slice(0, 10)}</span>
        <span className="font-mono text-xs">
          <span className="text-status-success">+{pr.additions}</span>{' '}
          <span className="text-status-failure">−{pr.deletions}</span>{' '}
          <span className="text-ink-faint">{pr.changedFiles} files</span>
        </span>
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          className="rounded text-accent hover:underline focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
        >
          View on GitHub<span className="sr-only"> (opens in a new tab)</span> ↗
        </a>
      </div>

      <div className="space-y-6">
        {pr.body.trim().length > 0 && (
          <Card title="Description">
            <div className="space-y-3 text-sm leading-relaxed text-ink-muted">
              {pr.body.split(/\n{2,}/).map((paragraph, index) => (
                <p key={index}>{paragraph}</p>
              ))}
            </div>
          </Card>
        )}

        <Card title="Review history">
          <DataTable
            caption="Review runs for this pull request"
            columns={columns}
            rows={pr.reviews}
            keyOf={(run) => run.id}
            emptyMessage="No reviews yet"
            emptyHint="Use “Review now” above to run the first one."
            defaultSort={{ key: 'createdAt', direction: 'desc' } satisfies SortState}
          />
        </Card>
      </div>
    </div>
  );
}
