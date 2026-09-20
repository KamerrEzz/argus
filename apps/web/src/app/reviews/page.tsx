'use client';

// Review run directory with status/verdict/repository filters.

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  errorMessage,
  formatDuration,
  formatRelative,
  formatUsd,
  repositories,
  reviews,
  shortId,
} from '@/lib/api';
import type { RepositoryListItem, ReviewRunListItem } from '@/lib/types';
import {
  PageHeader,
  SecondaryButton,
  Shell,
  StatusBadge,
  VerdictBadge,
  inputClass,
  labelClass,
} from '@/components/layout';
import { DataTable, Pager, type Column } from '@/components/table';
import { useToast } from '@/components/toast';

const PAGE_SIZE = 20;

const STATUSES = [
  '',
  'queued',
  'running',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
] as const;

const VERDICTS = ['', 'passed', 'neutral', 'failed'] as const;

export default function ReviewsPage() {
  return (
    <Shell>
      <ReviewsView />
    </Shell>
  );
}

function ReviewsView() {
  const toast = useToast();
  const [repoOptions, setRepoOptions] = useState<RepositoryListItem[]>([]);
  const [repositoryId, setRepositoryId] = useState('');
  const [status, setStatus] = useState('');
  const [verdict, setVerdict] = useState('');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<ReviewRunListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    repositories
      .list({ page: 1, pageSize: 100 })
      .then((result) => {
        setRepoOptions(result.items);
      })
      .catch(() => {
        // The repository filter simply stays empty; the rest of the page works.
      });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await reviews.list({
        page,
        pageSize: PAGE_SIZE,
        ...(repositoryId.length > 0 ? { repositoryId } : {}),
        ...(status.length > 0 ? { status } : {}),
        ...(verdict.length > 0 ? { verdict } : {}),
      });
      setItems(result.items);
      setTotal(result.total);
      setTotalPages(result.totalPages);
    } catch (error) {
      toast.error(errorMessage(error));
      setItems([]);
      setTotal(0);
      setTotalPages(1);
    } finally {
      setLoading(false);
    }
  }, [page, repositoryId, status, verdict, toast]);

  useEffect(() => {
    void load();
  }, [load]);

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
        <span className="font-mono text-xs text-ink-muted">
          {run.findings.critical}c {run.findings.high}h {run.findings.medium}m {run.findings.low}l{' '}
          {run.findings.info}i
        </span>
      ),
    },
    {
      key: 'durationMs',
      header: 'Duration',
      sortValue: (run) => run.durationMs ?? 0,
      render: (run) => <span className="text-ink-muted">{formatDuration(run.durationMs)}</span>,
    },
    {
      key: 'cost',
      header: 'Cost',
      sortValue: (run) => Number.parseFloat(run.estimatedCostUsd) || 0,
      render: (run) => <span className="text-ink-muted">{formatUsd(run.estimatedCostUsd)}</span>,
    },
    {
      key: 'createdAt',
      header: 'Created',
      sortValue: (run) => run.createdAt,
      render: (run) => (
        <time dateTime={run.createdAt} className="text-ink-muted">
          {formatRelative(run.createdAt)}
        </time>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Review Runs"
        description="Every agent review execution, newest first."
        actions={
          <SecondaryButton
            onClick={() => {
              void load();
            }}
          >
            Refresh
          </SecondaryButton>
        }
      />

      <div className="mb-4 flex flex-wrap items-end gap-3" role="search" aria-label="Review run filters">
        <div className="min-w-52">
          <label htmlFor="review-filter-repo" className={labelClass}>
            Repository
          </label>
          <select
            id="review-filter-repo"
            value={repositoryId}
            onChange={(event) => {
              setRepositoryId(event.target.value);
              setPage(1);
            }}
            className={`mt-1.5 ${inputClass}`}
          >
            <option value="">All repositories</option>
            {repoOptions.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.fullName}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="review-filter-status" className={labelClass}>
            Status
          </label>
          <select
            id="review-filter-status"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
            className={`mt-1.5 ${inputClass}`}
          >
            <option value="">All statuses</option>
            {STATUSES.filter((entry) => entry !== '').map((entry) => (
              <option key={entry} value={entry}>
                {entry.replaceAll('_', ' ')}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="review-filter-verdict" className={labelClass}>
            Verdict
          </label>
          <select
            id="review-filter-verdict"
            value={verdict}
            onChange={(event) => {
              setVerdict(event.target.value);
              setPage(1);
            }}
            className={`mt-1.5 ${inputClass}`}
          >
            <option value="">All verdicts</option>
            {VERDICTS.filter((entry) => entry !== '').map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </div>
        {(repositoryId.length > 0 || status.length > 0 || verdict.length > 0) && (
          <SecondaryButton
            onClick={() => {
              setRepositoryId('');
              setStatus('');
              setVerdict('');
              setPage(1);
            }}
          >
            Clear filters
          </SecondaryButton>
        )}
      </div>

      <DataTable
        caption="Review runs"
        columns={columns}
        rows={items}
        keyOf={(run) => run.id}
        loading={loading}
        emptyMessage="No review runs yet"
        emptyHint="Trigger a review from a pull request page or a repository's “Trigger a review” panel."
      />

      {total > 0 && (
        <Pager
          page={page}
          totalPages={totalPages}
          total={total}
          pageSize={PAGE_SIZE}
          onChange={setPage}
          label="review runs"
        />
      )}
    </div>
  );
}
