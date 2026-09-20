'use client';

// Reusable data table with client-side sorting, accessible sort headers,
// empty states, and a companion pagination control.

import { useMemo, useState, type ReactNode } from 'react';
import { Spinner } from './layout';

export interface Column<T> {
  key: string;
  header: string;
  /** Render the cell content. Falls back to a plain text read of `accessor`. */
  render?: (row: T) => ReactNode;
  /** Value used when the column is sorted. Sorting is off without it. */
  sortValue?: (row: T) => string | number | null | undefined;
  cellClass?: string;
  headerClass?: string;
}

type SortDirection = 'asc' | 'desc';

export interface SortState {
  key: string;
  direction: SortDirection;
}

export interface DataTableProps<T> {
  caption: string;
  columns: Column<T>[];
  rows: T[];
  keyOf: (row: T) => string;
  emptyMessage: string;
  emptyHint?: string;
  loading?: boolean;
  /** Column key and direction to sort by before the user touches anything. */
  defaultSort?: SortState;
}

export function DataTable<T,>({
  caption,
  columns,
  rows,
  keyOf,
  emptyMessage,
  emptyHint,
  loading = false,
  defaultSort,
}: DataTableProps<T>) {
  const [sort, setSort] = useState<SortState | null>(defaultSort ?? null);

  const sortedRows = useMemo(() => {
    if (sort === null) {
      return rows;
    }
    const column = columns.find((candidate) => candidate.key === sort.key);
    if (column === undefined || column.sortValue === undefined) {
      return rows;
    }
    const accessor = column.sortValue;
    const factor = sort.direction === 'asc' ? 1 : -1;
    return [...rows].sort((left, right) => {
      const a = accessor(left);
      const b = accessor(right);
      if (a === b) {
        return 0;
      }
      if (a === null || a === undefined) {
        return 1;
      }
      if (b === null || b === undefined) {
        return -1;
      }
      if (typeof a === 'number' && typeof b === 'number') {
        return (a - b) * factor;
      }
      return String(a).localeCompare(String(b)) * factor;
    });
  }, [rows, sort, columns]);

  function toggleSort(key: string) {
    setSort((current) => {
      if (current === null || current.key !== key) {
        return { key, direction: 'asc' };
      }
      if (current.direction === 'asc') {
        return { key, direction: 'desc' };
      }
      return null;
    });
  }

  if (loading) {
    return (
      <div
        className="flex items-center gap-3 rounded-xl border border-border-subtle bg-surface px-4 py-10 text-sm text-ink-muted"
        role="status"
      >
        <Spinner />
        Loading {caption.toLowerCase()}…
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div
        className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border-strong bg-surface px-6 py-12 text-center"
        role="status"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="h-8 w-8 text-ink-faint"
        >
          <path d="M4 5h16M4 12h16M4 19h10" strokeLinecap="round" />
        </svg>
        <p className="text-sm font-medium text-ink">{emptyMessage}</p>
        {emptyHint !== undefined && <p className="max-w-md text-sm text-ink-muted">{emptyHint}</p>}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-border-subtle bg-surface">
      <table className="w-full min-w-max text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-border-subtle text-xs tracking-wide text-ink-faint uppercase">
            {columns.map((column) => {
              const active = sort !== null && sort.key === column.key;
              const ariaSort = active
                ? sort.direction === 'asc'
                  ? ('ascending' as const)
                  : ('descending' as const)
                : ('none' as const);
              return (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={column.sortValue !== undefined ? ariaSort : undefined}
                  className={`px-4 py-3 font-medium ${column.headerClass ?? ''}`}
                >
                  {column.sortValue !== undefined ? (
                    <button
                      type="button"
                      onClick={() => {
                        toggleSort(column.key);
                      }}
                      className={`inline-flex items-center gap-1 rounded focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none hover:text-ink ${
                        active ? 'text-ink' : ''
                      }`}
                    >
                      {column.header}
                      <span aria-hidden="true" className="text-xs">
                        {active ? (sort.direction === 'asc' ? '▲' : '▼') : '↕'}
                      </span>
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row) => (
            <tr
              key={keyOf(row)}
              className="border-b border-border-subtle last:border-b-0 hover:bg-surface-raised"
            >
              {columns.map((column) => (
                <td key={column.key} className={`px-4 py-3 align-top ${column.cellClass ?? ''}`}>
                  {column.render !== undefined
                    ? column.render(row)
                    : renderFallback(row, column.key)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Fallback cell renderer: read a dot path off the row and stringify it. */
function renderFallback(row: unknown, path: string): ReactNode {
  let current: unknown = row;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') {
      return '—';
    }
    current = (current as Record<string, unknown>)[part];
  }
  if (current === null || current === undefined) {
    return '—';
  }
  if (typeof current === 'string' || typeof current === 'number' || typeof current === 'boolean') {
    return String(current);
  }
  return '—';
}

export function Pager({
  page,
  totalPages,
  total,
  pageSize,
  onChange,
  label = 'results',
}: {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  onChange: (page: number) => void;
  label?: string;
}) {
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  return (
    <nav
      aria-label={`Pagination for ${total} ${label}`}
      className="mt-4 flex flex-wrap items-center justify-between gap-3"
    >
      <p className="text-sm text-ink-muted" aria-live="polite">
        {total === 0
          ? `No ${label}`
          : `Showing ${first}–${last} of ${total} ${label}`}
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            onChange(page - 1);
          }}
          disabled={page <= 1}
          className="rounded-lg border border-border-strong px-3 py-1.5 text-sm text-ink-muted transition-colors hover:bg-surface-raised hover:text-ink focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
        >
          ← Previous
        </button>
        <span className="text-sm text-ink-muted">
          Page <span className="font-medium text-ink">{page}</span> of {Math.max(totalPages, 1)}
        </span>
        <button
          type="button"
          onClick={() => {
            onChange(page + 1);
          }}
          disabled={page >= totalPages}
          className="rounded-lg border border-border-strong px-3 py-1.5 text-sm text-ink-muted transition-colors hover:bg-surface-raised hover:text-ink focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
        >
          Next →
        </button>
      </div>
    </nav>
  );
}
