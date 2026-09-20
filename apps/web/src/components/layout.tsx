'use client';

// Application shell: session provider, sidebar navigation, and top bar.
//
// The session lives in an httpOnly cookie held by the API, so the browser is
// the only place that can truthfully answer "am I signed in?" — the shell asks
// `GET /auth/me` once per load and bounces to /login when the API says no.

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, errorMessage, fetchMe, logout as apiLogout } from '@/lib/api';
import type { ReviewRunStatus, ReviewVerdict, Severity, User } from '@/lib/types';
import { useToast } from './toast';

// ---------------------------------------------------------------- session

type SessionStatus = 'loading' | 'authed' | 'anon';

interface SessionValue {
  user: User | null;
  status: SessionStatus;
  isAdmin: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<SessionStatus>('loading');
  const toast = useToast();

  const refresh = useCallback(async () => {
    try {
      const me = await fetchMe();
      setUser(me);
      setStatus('authed');
    } catch (error) {
      setUser(null);
      setStatus('anon');
      if (!(error instanceof ApiError && (error.isUnauthorized || error.status === 0))) {
        toast.error(errorMessage(error));
      }
    }
  }, [toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    try {
      await apiLogout();
    } catch (error) {
      toast.error(errorMessage(error));
    }
    setUser(null);
    setStatus('anon');
  }, [toast]);

  const value = useMemo<SessionValue>(
    () => ({
      user,
      status,
      isAdmin: user?.role === 'admin',
      refresh,
      signOut,
    }),
    [user, status, refresh, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const context = useContext(SessionContext);
  if (context === null) {
    throw new Error('useSession must be used within a SessionProvider');
  }
  return context;
}

// ---------------------------------------------------------------- navigation

const NAV_ITEMS: readonly { href: string; label: string; icon: ReactNode }[] = [
  {
    href: '/',
    label: 'Dashboard',
    icon: (
      <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor">
        <path d="M10.7 2.3a1 1 0 0 0-1.4 0l-8 7A1 1 0 0 0 2.2 11H3v7a1 1 0 0 0 1 1h4v-5h4v5h4a1 1 0 0 0 1-1v-7h.8a1 1 0 0 0 .7-1.7l-7.8-7z" />
      </svg>
    ),
  },
  {
    href: '/repositories',
    label: 'Repositories',
    icon: (
      <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor">
        <path d="M4 2a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a1 1 0 0 0-1-1h-5a2 2 0 0 1-2-2V3a1 1 0 0 0-1-1H4zm2.5 12a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5v-6a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5v6z" />
      </svg>
    ),
  },
  {
    href: '/pulls',
    label: 'Pull Requests',
    icon: (
      <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor">
        <path d="M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm9 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM5 11a3 3 0 0 0-1 5.83V19a1 1 0 1 0 2 0v-.5a3 3 0 0 0 2-2.83V9.83A3 3 0 0 0 8 10.5a3 3 0 0 1-3 .5zm11-3a1 1 0 0 0-1 1v6a1 1 0 1 1-2 0v-1H9a1 1 0 1 0 0 2h1a3 3 0 0 0 5.9.7c.06-.22.1-.45.1-.7V9a1 1 0 0 0-1-1z" />
      </svg>
    ),
  },
  {
    href: '/reviews',
    label: 'Review Runs',
    icon: (
      <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor">
        <path d="M10 2a8 8 0 1 0 8 8 8 8 0 0 0-8-8zm1 8.4 3.3 2a1 1 0 0 1-1 1.7l-3.8-2.3a1 1 0 0 1-.5-.9V6a1 1 0 1 1 2 0z" />
      </svg>
    ),
  },
];

const SEGMENT_TITLES: Readonly<Record<string, string>> = {
  repositories: 'Repositories',
  pulls: 'Pull Requests',
  reviews: 'Review Runs',
  events: 'Live Events',
  approvals: 'Publish Approvals',
  login: 'Sign in',
};

function titleForPath(pathname: string): string {
  const segments = pathname.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return 'Dashboard';
  }
  const root = segments[0] ?? '';
  const leaf = segments[segments.length - 1] ?? '';
  const rootTitle = SEGMENT_TITLES[root] ?? 'Overview';
  const leafTitle = SEGMENT_TITLES[leaf];
  if (segments.length > 1 && leafTitle !== undefined && leaf !== root) {
    return `${rootTitle} · ${leafTitle}`;
  }
  return rootTitle;
}

// ---------------------------------------------------------------- shell

export function Shell({ children }: { children: ReactNode }) {
  const { status, user, signOut } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const mainRef = useRef<HTMLElement>(null);
  const wasAuthed = useRef(false);

  useEffect(() => {
    if (status === 'anon') {
      router.replace('/login');
    } else if (status === 'authed') {
      wasAuthed.current = true;
    }
  }, [status, router]);

  // Move focus to the main region on every route change so keyboard and screen
  // reader users land inside the new page instead of the top of the document.
  useEffect(() => {
    mainRef.current?.focus();
  }, [pathname]);

  if (status !== 'authed' || user === null) {
    return <FullScreenSkeleton />;
  }

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-accent focus:px-3 focus:py-2 focus:text-sm focus:text-canvas"
      >
        Skip to main content
      </a>

      <aside className="flex w-full shrink-0 flex-col border-b border-border-subtle bg-surface lg:w-60 lg:min-h-screen lg:border-r lg:border-b-0">
        <div className="flex items-center gap-2 px-4 py-4 lg:px-5">
          <span
            aria-hidden="true"
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-sm font-bold text-canvas"
          >
            AR
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink">AI Code Review</p>
            <p className="truncate text-xs text-ink-faint">Review &amp; QA console</p>
          </div>
        </div>

        <nav aria-label="Primary" className="px-2 pb-4 lg:flex-1">
          <ul className="flex gap-1 overflow-x-auto lg:flex-col">
            {NAV_ITEMS.map((item) => {
              const active =
                item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
              return (
                <li key={item.href} className="shrink-0 lg:w-full">
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${
                      active
                        ? 'bg-accent-soft font-medium text-ink'
                        : 'text-ink-muted hover:bg-surface-raised hover:text-ink'
                    }`}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="hidden border-t border-border-subtle px-4 py-4 lg:block">
          <p className="truncate text-sm font-medium text-ink">{user.name}</p>
          <p className="truncate text-xs text-ink-faint">{user.email}</p>
          <span
            className={`mt-2 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
              user.role === 'admin' ? 'bg-accent-soft text-accent' : 'bg-surface-raised text-ink-muted'
            }`}
          >
            {user.role}
          </span>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-border-subtle bg-surface px-4 py-3 lg:px-8">
          <h1 className="truncate text-base font-semibold text-ink">{titleForPath(pathname)}</h1>
          <div className="flex shrink-0 items-center gap-3">
            <span className="hidden text-sm text-ink-muted sm:inline">
              {user.name}
              <span className="ml-2 rounded-full bg-surface-raised px-2 py-0.5 text-xs text-ink-faint">
                {user.role}
              </span>
            </span>
            <button
              type="button"
              onClick={() => {
                void signOut().then(() => {
                  router.replace('/login');
                });
              }}
              className="rounded-lg border border-border-strong px-3 py-1.5 text-sm text-ink-muted transition-colors hover:bg-surface-raised hover:text-ink focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
            >
              Sign out
            </button>
          </div>
        </header>

        <main
          id="main-content"
          ref={mainRef}
          tabIndex={-1}
          className="flex-1 px-4 py-6 focus:outline-none lg:px-8"
        >
          {children}
        </main>
      </div>
    </div>
  );
}

function FullScreenSkeleton() {
  return (
    <div className="flex min-h-screen" role="status" aria-label="Loading dashboard">
      <div className="hidden w-60 shrink-0 flex-col gap-3 border-r border-border-subtle bg-surface p-4 lg:flex">
        <div className="h-8 w-32 animate-pulse rounded bg-surface-raised" />
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="h-9 w-full animate-pulse rounded-lg bg-surface-raised" />
        ))}
      </div>
      <div className="flex-1 p-8">
        <div className="mb-6 h-6 w-48 animate-pulse rounded bg-surface-raised" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="h-28 animate-pulse rounded-xl bg-surface" />
          ))}
        </div>
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}

// ---------------------------------------------------------------- shared primitives

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 className="text-xl font-semibold text-ink">{title}</h2>
        {description !== undefined && <p className="mt-1 text-sm text-ink-muted">{description}</p>}
      </div>
      {actions !== undefined && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Card({
  title,
  actions,
  children,
  className = '',
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label={title}
      className={`rounded-xl border border-border-subtle bg-surface ${className}`}
    >
      {(title !== undefined || actions !== undefined) && (
        <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-4 py-3">
          {title !== undefined && <h3 className="text-sm font-semibold text-ink">{title}</h3>}
          {actions !== undefined && <div className="flex shrink-0 gap-2">{actions}</div>}
        </div>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function StatCard({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'success' | 'warning' | 'failure' | 'accent';
}) {
  const toneClass =
    tone === 'success'
      ? 'text-status-success'
      : tone === 'warning'
        ? 'text-status-neutral'
        : tone === 'failure'
          ? 'text-status-failure'
          : tone === 'accent'
            ? 'text-accent'
            : 'text-ink';
  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-4">
      <p className="text-xs font-medium tracking-wide text-ink-faint uppercase">{label}</p>
      <p className={`mt-2 text-2xl font-semibold ${toneClass}`}>{value}</p>
      {hint !== undefined && <p className="mt-1 text-xs text-ink-muted">{hint}</p>}
    </div>
  );
}

const STATUS_PILL: Readonly<Record<ReviewRunStatus, string>> = {
  queued: 'bg-surface-raised text-ink-muted',
  running: 'bg-accent-soft text-accent',
  completed: 'bg-accent-soft text-status-success',
  failed: 'bg-status-failure text-canvas',
  cancelled: 'bg-surface-raised text-ink-faint',
  awaiting_approval: 'bg-status-neutral text-canvas',
};

export function StatusBadge({ status }: { status: ReviewRunStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${STATUS_PILL[status]}`}
    >
      {status === 'running' && (
        <span aria-hidden="true" className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
      )}
      {status.replaceAll('_', ' ')}
    </span>
  );
}

const VERDICT_PILL: Readonly<Record<ReviewVerdict, string>> = {
  passed: 'text-status-success',
  neutral: 'text-status-neutral',
  failed: 'text-status-failure',
};

export function VerdictBadge({ verdict }: { verdict: ReviewVerdict | null }) {
  if (verdict === null) {
    return <span className="text-xs text-ink-faint">—</span>;
  }
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold ${VERDICT_PILL[verdict]}`}>
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
      {verdict}
    </span>
  );
}

const SEVERITY_PILL: Readonly<Record<Severity, string>> = {
  critical: 'bg-severity-critical text-canvas',
  high: 'bg-severity-high text-canvas',
  medium: 'bg-severity-medium text-canvas',
  low: 'bg-severity-low text-canvas',
  info: 'bg-surface-raised text-ink-muted',
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span
      className={`inline-block rounded px-2 py-0.5 text-xs font-semibold uppercase ${SEVERITY_PILL[severity]}`}
    >
      {severity}
    </span>
  );
}

export function ExecutionStatusBadge({ status }: { status: string }) {
  const tone =
    status === 'succeeded'
      ? 'text-status-success'
      : status === 'failed' || status === 'timed_out'
        ? 'text-status-failure'
        : status === 'running'
          ? 'text-accent'
          : status === 'skipped' || status === 'pending'
            ? 'text-ink-faint'
            : 'text-ink-muted';
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${tone}`}>
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
      {status.replaceAll('_', ' ')}
    </span>
  );
}

export function PrimaryButton({
  children,
  onClick,
  disabled = false,
  busy = false,
  type = 'button',
  className = '',
  title,
  form,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
  type?: 'button' | 'submit';
  className?: string;
  title?: string;
  form?: string;
}) {
  return (
    <button
      type={type}
      form={form}
      onClick={onClick}
      disabled={disabled || busy}
      title={title}
      aria-busy={busy}
      className={`inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-canvas transition-colors hover:bg-accent/90 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
}

export function SecondaryButton({
  children,
  onClick,
  disabled = false,
  busy = false,
  type = 'button',
  className = '',
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
  type?: 'button' | 'submit';
  className?: string;
  title?: string;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || busy}
      title={title}
      aria-busy={busy}
      className={`inline-flex items-center justify-center gap-2 rounded-lg border border-border-strong bg-surface px-3.5 py-2 text-sm font-medium text-ink-muted transition-colors hover:bg-surface-raised hover:text-ink focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
}

export function DangerButton({
  children,
  onClick,
  disabled = false,
  busy = false,
  type = 'button',
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
  type?: 'button' | 'submit';
  className?: string;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || busy}
      aria-busy={busy}
      className={`inline-flex items-center justify-center gap-2 rounded-lg border border-status-failure px-3.5 py-2 text-sm font-medium text-status-failure transition-colors hover:bg-status-failure hover:text-canvas focus-visible:ring-2 focus-visible:ring-status-failure focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
    >
      <circle cx="12" cy="12" r="9" className="opacity-25" />
      <path d="M21 12a9 9 0 0 0-9-9" strokeLinecap="round" />
    </svg>
  );
}

export const inputClass =
  'w-full rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none';

export const labelClass = 'block text-sm font-medium text-ink-muted';
