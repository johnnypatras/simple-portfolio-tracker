export default function ShareLoading() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-8 animate-pulse" role="status" aria-label="Loading shared portfolio">
      {/* Header skeleton */}
      <div className="h-8 w-48 rounded bg-zinc-800 mb-8" />

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <div className="md:col-span-2 rounded-xl bg-zinc-900 p-5">
          <div className="h-4 w-24 rounded bg-zinc-800 mb-3" />
          <div className="h-7 w-32 rounded bg-zinc-800" />
        </div>
        <div className="rounded-xl bg-zinc-900 p-5">
          <div className="h-4 w-24 rounded bg-zinc-800 mb-3" />
          <div className="h-7 w-32 rounded bg-zinc-800" />
        </div>
      </div>

      {/* Chart skeleton */}
      <div className="rounded-xl bg-zinc-900 p-6 mb-8">
        <div className="h-5 w-36 rounded bg-zinc-800 mb-4" />
        <div className="h-64 rounded bg-zinc-800" />
      </div>

      {/* Table skeleton */}
      <div className="rounded-xl bg-zinc-900 p-6">
        <div className="h-5 w-40 rounded bg-zinc-800 mb-4" />
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex gap-4 py-3">
            <div className="h-4 w-1/4 rounded bg-zinc-800" />
            <div className="h-4 w-1/6 rounded bg-zinc-800" />
            <div className="h-4 w-1/5 rounded bg-zinc-800" />
            <div className="h-4 w-1/6 rounded bg-zinc-800" />
          </div>
        ))}
      </div>
    </div>
  );
}
