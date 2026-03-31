import { Clock, AlertTriangle } from "lucide-react";
import Link from "next/link";

interface ChartWarningBannerProps {
  pendingCount: number;
  failedCount: number;
}

export function ChartWarningBanner({ pendingCount, failedCount }: ChartWarningBannerProps) {
  if (pendingCount === 0 && failedCount === 0) return null;

  return (
    <div className="space-y-1.5 mb-3">
      {pendingCount > 0 && (
        <div role="status" className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 text-amber-400 text-xs">
          <Clock className="w-3.5 h-3.5 shrink-0" />
          <span>
            {pendingCount} {pendingCount === 1 ? "transaction is" : "transactions are"} awaiting price data.{" "}
            <Link href="/dashboard/history" className="underline hover:text-amber-300">
              View activity log
            </Link>
          </span>
        </div>
      )}
      {failedCount > 0 && (
        <div role="status" className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 text-red-400 text-xs">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>
            {failedCount} {failedCount === 1 ? "transaction has" : "transactions have"} estimated values.{" "}
            <Link href="/dashboard/history" className="underline hover:text-red-300">
              View activity log
            </Link>
          </span>
        </div>
      )}
    </div>
  );
}
