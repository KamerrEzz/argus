'use client';

// Pull request directory: filter by repository, state, and text search.

import Link from 'next/link';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { errorMessage, formatRelative, pullRequests, repositories } from '@/lib/api';
import type { PullRequestListItem, RepositoryListItem } from '@/lib/types';
import {
  PageHeader,
  PrimaryButton,
  SecondaryButton,
  Shell,
  StatusBadge,
  inputClass,
  labelClass,
} from '@/components/layout';
import { DataTable, Pager, type Column } from '@/components/table';
import { useToast } from '@/components/toast';

const PAGE_SIZE = 20;

const STATES = [
  { value: '', label: 'All states' },
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: 'merged', label: 'Merged' },
] as const;

export default function PullsPage() {
  return (
    <Shell>
      <PullsView />
    </Shell>
  );
}

function PullsView() {
  const toast = useToast();
  const [repoOptions, setRepoOptions] = useState<RepositoryListItem[]>([]);
  const [repositoryId, setRepositoryId] = useState('');
  const [state, setState] = useState('');
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<PullRequestListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    repositories
      .list({ page: 1, pageSize: 100 })
      .then((result) => {
        setRepoOptions(result.items);
      })
      .catch((error: unknown) => {
        toast.error(errorMessage(error));
      });
  }, [toast]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await pullRequests.list({
        page,
        pageSize: PAGE_SIZE,
        ...(repositoryId.length > 0 ? { repositoryId } : {}),
        ...(state.length > 0 ? { state } : {}),
        ...(appliedSearch.trim().length > 0 ? { search: appliedSearch.trim() } : {}),
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
  }, [page, repositoryId, state, appliedSearch, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    setAppliedSearch(search);
  }

  const columns: Column<PullRequestListItem>[] = [
    {
      key: 'number',
      header: 'Pull request',
      sortValue: (pr) => pr.number,
      render: (pr) => (
        <div className="min-w-64">
          <Link
            href={`/pulls/${pr.id}`}
            className="rounded font-medium text-ink hover:text-accent hover:underline focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          >
            #{pr.number} {pr.title}
          </Link>
          <p className="mt-0.5 text-xs text-ink-faint">
            <Link
              href={`/repositories/${pr.repository.id}`}
              className="rounded hover:text-accent hover:underline focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
            >
              {pr.repository.fullName}
            </Link>
            {pr.draft && <span className="ml-2 rounded bg-surface-raised px-1.5 text-xs">draft</span>}
          </p>
        </div>
      ),
    },
    {
      key: 'author',
      header: 'Author',
      sortValue: (pr) => pr.author,
      render: (pr) => <span className="text-ink-muted">{pr.author}</span>,
    },
    {
      key: 'state',
      header: 'State',
      sortValue: (pr) => pr.state,
      render: (pr) => (
        <span
          className={`text-xs font-medium ${
            pr.state === 'open'
              ? 'text-status-success'
              : pr.state === 'merged'
                ? 'text-accent'
                : 'text-ink-faint'
          }`}
        >
          {pr.state}
        </span>
      ),
    },
    {
      key: 'refs',
      header: 'Branch',
      render: (pr) => (
        <span className="font-mono text-xs text-ink-faint">
          {pr.headRef} → {pr.baseRef}
        </span>
      ),
    },
    {
      key: 'diff',
      header: 'Diff',
      sortValue: (pr) => pr.additions + pr.deletions,
      render: (pr) => (
        <span className="font-mono text-xs whitespace-nowrap">
          <span className="text-status-success">+{pr.additions}</span>{' '}
          <span className="text-status-failure">−{pr.deletions}</span>{' '}
          <span className="text-ink-faint">({pr.changedFiles} files)</span>
        </span>
      ),
    },
    {
      key: 'latestReview',
      header: 'Latest review',
      render: (pr) =>
        pr.latestReview === null ? (
          <span className="text-xs text-ink-faint">never reviewed</span>
        ) : (
          <Link
            href={`/reviews/${pr.latestReview.id}`}
            className="rounded focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          >
            <StatusBadge status={pr.latestReview.status} />
          </Link>
        ),
    },
    {
      key: 'updatedAt',
      header: 'Updated',
      sortValue: (pr) => pr.updatedAt,
      render: (pr) => (
        <time dateTime={pr.updatedAt} className="text-ink-muted">
          {formatRelative(pr.updatedAt)}
        </time>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Pull Requests"
        description="Every pull request mirrored from GitHub, newest activity first."
      />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="min-w-52">
          <label htmlFor="filter-repo" className={labelClass}>
            Repository
          </label>
          <select
            id="filter-repo"
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
          <label htmlFor="filter-state" className={labelClass}>
            State
          </label>
          <select
            id="filter-state"
            value={state}
            onChange={(event) => {
              setState(event.target.value);
              setPage(1);
            }}
            className={`mt-1.5 ${inputClass}`}
          >
            {STATES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <form onSubmit={submitSearch} className="flex min-w-52 flex-1 gap-2" role="search">
          <div className="flex-1">
            <label htmlFor="pr-search" className="sr-only">
              Search pull requests by title or author
            </label>
            <input
              id="pr-search"
              type="search"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
              }}
              placeholder="Search title or author…"
              className={inputClass}
            />
          </div>
          <PrimaryButton type="submit">Search</PrimaryButton>
        </form>
        {(appliedSearch.length > 0 || state.length > 0 || repositoryId.length > 0) && (
          <SecondaryButton
            onClick={() => {
              setSearch('');
              setAppliedSearch('');
              setState('');
              setRepositoryId('');
              setPage(1);
            }}
          >
            Clear filters
          </SecondaryButton>
        )}
      </div>

      <DataTable
        caption="Pull requests"
        columns={columns}
        rows={items}
        keyOf={(pr) => pr.id}
        loading={loading}
        emptyMessage={
          repoOptions.length === 0 ? 'No pull requests mirrored yet' : 'No pull requests match these filters'
        }
        emptyHint={
          repoOptions.length === 0
            ? 'Connect a repository and open a pull request on GitHub — webhook events populate this list, or trigger a review by number from the repository page.'
            : 'Widen the filters, or clear them to see everything.'
        }
      />

      {total > 0 && (
        <Pager
          page={page}
          totalPages={totalPages}
          total={total}
          pageSize={PAGE_SIZE}
          onChange={setPage}
          label="pull requests"
        />
      )}
    </div>
  );
}
