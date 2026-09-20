import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <div className="max-w-md text-center">
        <p className="font-mono text-sm text-ink-faint">HTTP 404</p>
        <h1 className="mt-2 text-2xl font-semibold text-ink">This page does not exist</h1>
        <p className="mt-3 text-sm text-ink-muted">
          The link may be stale — a repository, pull request, or review run that has since been
          removed or hidden from your access.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link
            href="/"
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-canvas hover:bg-accent/90 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas focus-visible:outline-none"
          >
            Go to dashboard
          </Link>
          <Link
            href="/reviews"
            className="rounded-lg border border-border-strong px-4 py-2 text-sm font-medium text-ink-muted hover:bg-surface hover:text-ink focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          >
            Browse review runs
          </Link>
        </div>
      </div>
    </main>
  );
}
