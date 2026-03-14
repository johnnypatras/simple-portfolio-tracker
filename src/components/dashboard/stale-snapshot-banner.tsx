import { Clock } from "lucide-react";

interface StaleSnapshotBannerProps {
  staleHours: number | null;
}

export function StaleSnapshotBanner({ staleHours }: StaleSnapshotBannerProps) {
  if (staleHours == null || staleHours <= 26) return null;

  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 text-amber-400 text-xs mb-3">
      <Clock className="w-3.5 h-3.5 shrink-0" />
      <span>
        Portfolio snapshot is {Math.round(staleHours)} hours old — daily update may have failed.
      </span>
    </div>
  );
}
