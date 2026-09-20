export default function Loading() {
  return (
    <div className="flex min-h-screen bg-canvas">
      <div
        className="hidden w-60 shrink-0 flex-col gap-3 border-r border-border-subtle bg-surface p-4 lg:flex"
        aria-hidden="true"
      >
        <div className="h-8 w-32 animate-pulse rounded bg-surface-raised" />
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="h-9 w-full animate-pulse rounded-lg bg-surface-raised" />
        ))}
      </div>
      <div className="min-w-0 flex-1 p-6 lg:p-8">
        <div aria-label="Loading page" role="status" className="mx-auto max-w-6xl space-y-6">
          <div className="h-8 w-64 animate-pulse rounded bg-surface-raised" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="h-28 animate-pulse rounded-xl bg-surface" />
            ))}
          </div>
          <div className="h-96 animate-pulse rounded-xl bg-surface" />
        </div>
        <span className="sr-only">Loading…</span>
      </div>
    </div>
  );
}
