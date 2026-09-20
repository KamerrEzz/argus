'use client';

// Dashboard home. There is no dedicated stats endpoint, so the numbers are
// derived from cheap list calls: totals come from the pagination envelope and
// the per-status counters from `pageSize=1` queries.

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { formatRelative, repositories, reviews, shortId } from '@/lib/api';
import type { ListResult } from '@/lib/api';
import type { RepositoryListItem, ReviewRunListItem } from '@/lib/types';
import {
  Card,
  PageHeader,
  SecondaryButton,
  Shell,
  StatCard,
  StatusBadge,
  VerdictBadge,
  useSession,
} from '@/components/layout';
import { DataTable, Pager, type Column } from '@/components/table';
import { useToast } from '@/components/toast';

interface HomeData {
  runs: ListResult<ReviewRunListItem>;
  repositoriesResult: ListResult<RepositoryListItem>;
  queued: number;
  running: number;
  awaitingApproval: number;
}

export default function HomePage() {
  return (
    <Shell>
      <DashboardHome />
    </Shell>
  );
}

function DashboardHome() {
  const toast = useToast();
  const { user } = useSession();
  const [data, setData] = useState<HomeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  const loadOverview = useCallback(
    async (runsPage: number) => {
      setLoading(true);
      const [runs, repoList, queued, running, awaitingApproval] = await Promise.all([
        reviews.list({ page: runsPage, pageSize: 10 }).catch(() => null),
        repositories.list({ page: 1, pageSize: 100 }).catch(() => null),
        reviews.list({ page: 1, pageSize: 1, status: 'queued' }).catch(() => null),
        reviews.list({ page: 1, pageSize: 1, status: 'running' }).catch(() => null),
        reviews.list({ page: 1, pageSize: 1, status: 'awaiting_approval' }).catch(() => null),
      ]);

      if (runs === null || repoList === null) {
        toast.error('Could not load the dashboard overview. Check that the API is reachable.');
        setData(null);
      } else {
        setData({
          runs,
          repositoriesResult: repoList,
          queued: queued?.total ?? 0,
          running: running?.total ?? 0,
          awaitingApproval: awaitingApproval?.total ?? 0,
        });
      }
      setLoading(false);
    },
    [toast],
  );

  useEffect(() => {
    void loadOverview(page);
  }, [page, loadOverview]);

  const pending = (data?.queued ?? 0) + (data?.running ?? 0);
  const recentCriticals =
    data?.runs.items.reduce((sum, run) => sum + run.findings.critical, 0) ?? 0;

  const columns: Column<ReviewRunListItem>[] = [
    {
      key: 'id',
      header: 'Run',
      render: (run) => (
        <Link
          href={`/reviews/${run.id}`}
          className="rounded font-mono text-xs text-accent hover:underline focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
        >
          {shortId(run.id)}
        </Link>
      ),
    },
    {
      key: 'repository',
      header: 'Repository',
      sortValue: (run) => run.repository?.fullName ?? '',
      render: (run) =>
        run.repository ? (
          <Link
            href={`/repositories/${run.repository.id}`}
            className="rounded text-ink hover:text-accent hover:underline focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          >
            {run.repository.fullName}
          </Link>
        ) : (
          '—'
        ),
    },
    {
      key: 'pullRequest',
      header: 'Pull request',
      render: (run) =>
        run.pullRequest ? (
          <Link
            href={`/pulls/${run.pullRequest.id}`}
            className="rounded text-ink-muted hover:text-accent hover:underline focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          >
            #{run.pullRequest.number} {run.pullRequest.title}
          </Link>
        ) : (
          '—'
        ),
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (run) => run.status,
      render: (run) => <StatusBadge status={run.status} />,
    },
    {
      key: 'verdict',
      header: 'Verdict',
      sortValue: (run) => run.verdict ?? '',
      render: (run) => <VerdictBadge verdict={run.verdict} />,
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
      key: 'createdAt',
      header: 'Started',
      sortValue: (run) => run.createdAt,
      render: (run) => (
        <time dateTime={run.createdAt} className="text-ink-muted">
          {formatRelative(run.createdAt)}
        </time>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={greeting(user?.name)}
        description="Review throughput, pending work, and the most recent activity across your repositories."
        actions={
          <SecondaryButton
            onClick={() => {
              void loadOverview(page);
            }}
            busy={loading && data === null}
          >
            Refresh
          </SecondaryButton>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Total review runs"
          value={data === null ? '—' : String(data.runs.total)}
          hint="All time"
          tone="accent"
        />
        <StatCard
          label="Pending"
          value={data === null ? '—' : String(pending)}
          hint="Queued + running"
          tone={pending > 0 ? 'warning' : 'default'}
        />
        <StatCard
          label="Awaiting approval"
          value={data === null ? '—' : String(data.awaitingApproval)}
          hint="Publish blocked on a decision"
          tone={data !== null && data.awaitingApproval > 0 ? 'warning' : 'default'}
        />
        <StatCard
          label="Repositories"
          value={data === null ? '—' : String(data.repositoriesResult.total)}
          hint={
            recentCriticals > 0
              ? `${recentCriticals} critical finding(s) in recent runs`
              : 'Registered with the platform'
          }
        />
      </div>

      <div className="mt-6">
        <Card
          title="Recent activity"
          actions={
            <Link
              href="/reviews"
              className="rounded text-sm text-accent hover:underline focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
            >
              View all runs
            </Link>
          }
        >
          <DataTable
            caption="Recent review runs"
            columns={columns}
            rows={data?.runs.items ?? []}
            keyOf={(run) => run.id}
            loading={loading && data === null}
            emptyMessage="No review runs yet"
            emptyHint={
              data?.repositoriesResult.total === 0
                ? 'Add a repository first, then trigger a review from a pull request page.'
                : 'Pick a pull request and start your first review run.'
            }
          />
        </Card>
      </div>

      {data !== null && data.runs.total > data.runs.pageSize && (
        <Pager
          page={page}
          totalPages={Math.min(data.runs.totalPages, 5)}
          total={Math.min(data.runs.total, 5 * data.runs.pageSize)}
          pageSize={data.runs.pageSize}
          onChange={setPage}
          label="recent runs"
        />
      )}
    </div>
  );
}

function greeting(name: string | undefined): string {
  if (name === undefined) {
    return 'Dashboard';
  }
  const hour = new Date().getHours();
  const part = hour < 12 ? 'Good morning' : hour < 19 ? 'Good afternoon' : 'Good evening';
  return `${part}, ${name}`;
}
