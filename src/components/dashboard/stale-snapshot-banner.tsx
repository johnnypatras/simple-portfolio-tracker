import { Clock } from "lucide-react";

interface StaleSnapshotBannerProps {
  latestSnapshotDate?: string;
}

/** Compute hours since snapshot — plain function, not a component render. */
function getStaleHours(dateStr: string): number {
  return (Date.now() - new Date(dateStr).getTime()) / 3_600_000;
}

export function StaleSnapshotBanner({ latestSnapshotDate }: StaleSnapshotBannerProps) {
  if (!latestSnapshotDate) return null;

  const staleHours = getStaleHours(latestSnapshotDate);
  if (staleHours <= 26) return null;

  return (
    <div role="status" className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 text-amber-400 text-xs mb-3">
      <Clock className="w-3.5 h-3.5 shrink-0" />
      <span>
        Portfolio snapshot is {Math.round(staleHours)} hours old — daily update may have failed.
      </span>
    </div>
  );
}
