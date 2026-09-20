'use client';

// Repository directory: search, pagination, and the admin actions (register a
// repository, mirror the GitHub App installation).

import Link from 'next/link';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { errorMessage, formatRelative, repositories } from '@/lib/api';
import type { RepositoryListItem } from '@/lib/types';
import {
  Card,
  PageHeader,
  PrimaryButton,
  SecondaryButton,
  Shell,
  inputClass,
  labelClass,
  useSession,
} from '@/components/layout';
import { DataTable, Pager, type Column } from '@/components/table';
import { useToast } from '@/components/toast';

const PAGE_SIZE = 20;

export default function RepositoriesPage() {
  return (
    <Shell>
      <RepositoriesView />
    </Shell>
  );
}

function RepositoriesView() {
  const toast = useToast();
  const { isAdmin } = useSession();

  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<RepositoryListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [busySync, setBusySync] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await repositories.list({
        page,
        pageSize: PAGE_SIZE,
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
  }, [page, appliedSearch, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    setAppliedSearch(search);
  }

  async function handleSync() {
    setBusySync(true);
    try {
      const result = await repositories.sync();
      if (result.failures.length > 0) {
        toast.error(
          `Synced ${result.synced} repositories, but ${result.failures.length} installation(s) failed: ${result.failures[0]?.error ?? 'unknown error'}`,
        );
      } else {
        toast.success(`Sync complete — ${result.synced} repositories mirrored.`);
      }
      void load();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusySync(false);
    }
  }

  const columns: Column<RepositoryListItem>[] = [
    {
      key: 'fullName',
      header: 'Repository',
      sortValue: (repo) => repo.fullName,
      render: (repo) => (
        <div className="min-w-56">
          <Link
            href={`/repositories/${repo.id}`}
            className="rounded font-medium text-ink hover:text-accent hover:underline focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          >
            {repo.fullName}
          </Link>
          <p className="mt-0.5 text-xs text-ink-faint">
            {repo.isPrivate ? 'Private' : 'Public'}
            {repo.language !== null && ` · ${repo.language}`}
            {` · main branch ${repo.defaultBranch}`}
          </p>
        </div>
      ),
    },
    {
      key: 'counts.pullRequests',
      header: 'PRs',
      sortValue: (repo) => repo.counts.pullRequests,
      render: (repo) => <span className="text-ink-muted">{repo.counts.pullRequests}</span>,
    },
    {
      key: 'counts.reviewRuns',
      header: 'Runs',
      sortValue: (repo) => repo.counts.reviewRuns,
      render: (repo) => <span className="text-ink-muted">{repo.counts.reviewRuns}</span>,
    },
    {
      key: 'counts.findings',
      header: 'Findings',
      sortValue: (repo) => repo.counts.findings,
      render: (repo) => <span className="text-ink-muted">{repo.counts.findings}</span>,
    },
    {
      key: 'counts.pendingReviews',
      header: 'Pending',
      sortValue: (repo) => repo.counts.pendingReviews,
      render: (repo) =>
        repo.counts.pendingReviews > 0 ? (
          <span className="font-medium text-status-neutral">{repo.counts.pendingReviews}</span>
        ) : (
          <span className="text-ink-faint">0</span>
        ),
    },
    {
      key: 'lastSyncedAt',
      header: 'Last sync',
      sortValue: (repo) => repo.lastSyncedAt ?? '',
      render: (repo) => (
        <time dateTime={repo.lastSyncedAt ?? undefined} className="text-ink-muted">
          {formatRelative(repo.lastSyncedAt)}
        </time>
      ),
    },
    {
      key: 'isActive',
      header: 'State',
      sortValue: (repo) => (repo.isActive ? 1 : 0),
      render: (repo) => (
        <span className={repo.isActive ? 'text-status-success' : 'text-ink-faint'}>
          {repo.isActive ? 'Active' : 'Inactive'}
        </span>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Repositories"
        description="Every repository the platform can review, with its review counts."
        actions={
          isAdmin ? (
            <SecondaryButton
              onClick={() => {
                void handleSync();
              }}
              busy={busySync}
              title="Mirror the repositories on the GitHub App installation"
            >
              Sync from GitHub
            </SecondaryButton>
          ) : undefined
        }
      />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <form onSubmit={submitSearch} className="flex w-full max-w-md gap-2" role="search">
          <div className="flex-1">
            <label htmlFor="repo-search" className="sr-only">
              Search repositories by name
            </label>
            <input
              id="repo-search"
              type="search"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
              }}
              placeholder="Search owner/name…"
              className={inputClass}
            />
          </div>
          <PrimaryButton type="submit">Search</PrimaryButton>
        </form>
        {appliedSearch.length > 0 && (
          <SecondaryButton
            onClick={() => {
              setSearch('');
              setAppliedSearch('');
              setPage(1);
            }}
          >
            Clear
          </SecondaryButton>
        )}
      </div>

      <DataTable
        caption="Repositories"
        columns={columns}
        rows={items}
        keyOf={(repo) => repo.id}
        loading={loading}
        emptyMessage={
          appliedSearch.length > 0 ? 'No repositories match that search' : 'No repositories yet'
        }
        emptyHint={
          appliedSearch.length > 0
            ? 'Try a shorter fragment of the owner or repository name.'
            : isAdmin
              ? 'Register a repository below, or run “Sync from GitHub” to mirror the App installation.'
              : 'An administrator needs to connect repositories before reviews can run.'
        }
      />

      {total > 0 && (
        <Pager
          page={page}
          totalPages={totalPages}
          total={total}
          pageSize={PAGE_SIZE}
          onChange={setPage}
          label="repositories"
        />
      )}

      {isAdmin && <AddRepositoryCard onCreated={() => void load()} />}
    </div>
  );
}

function AddRepositoryCard({ onCreated }: { onCreated: () => void }) {
  const toast = useToast();
  const [owner, setOwner] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (owner.trim().length === 0 || name.trim().length === 0) {
      toast.error('Owner and repository name are both required.');
      return;
    }
    setBusy(true);
    try {
      const created = await repositories.create(owner.trim(), name.trim());
      toast.success(`Registered ${created.fullName}.`);
      setOwner('');
      setName('');
      onCreated();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-8 max-w-xl">
      <Card title="Register a repository">
        <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
          <div className="min-w-40 flex-1">
            <label htmlFor="new-owner" className={labelClass}>
              Owner
            </label>
            <input
              id="new-owner"
              value={owner}
              onChange={(event) => {
                setOwner(event.target.value);
              }}
              placeholder="acme"
              className={`mt-1.5 ${inputClass}`}
              required
            />
          </div>
          <div className="min-w-40 flex-1">
            <label htmlFor="new-name" className={labelClass}>
              Repository name
            </label>
            <input
              id="new-name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
              placeholder="api-gateway"
              className={`mt-1.5 ${inputClass}`}
              required
            />
          </div>
          <PrimaryButton type="submit" busy={busy}>
            Add
          </PrimaryButton>
        </form>
        <p className="mt-3 text-xs text-ink-faint">
          The repository must be reachable by the GitHub App installation; the platform verifies it
          before saving.
        </p>
      </Card>
    </div>
  );
}
