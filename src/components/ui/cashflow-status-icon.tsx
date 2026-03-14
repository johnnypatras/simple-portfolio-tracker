import { Clock, AlertTriangle } from "lucide-react";

interface CashflowStatusIconProps {
  cashflowStatus: string | null;
  deltaStatus: string | null;
}

export function CashflowStatusIcon({ cashflowStatus, deltaStatus }: CashflowStatusIconProps) {
  const isPending = cashflowStatus === "pending" || deltaStatus === "pending";
  const isFailed = cashflowStatus === "failed" || deltaStatus === "failed";

  if (!isPending && !isFailed) return null;

  // Build tooltip text
  const parts: string[] = [];
  if (cashflowStatus === "pending") parts.push("Cashflow data pending");
  if (deltaStatus === "pending") parts.push("Delta data pending");
  if (cashflowStatus === "failed") parts.push("Cashflow uses estimate");
  if (deltaStatus === "failed") parts.push("Delta uses estimate");

  if (isFailed) {
    return (
      <span title={parts.join(". ") + ". Chart uses estimate."}>
        <AlertTriangle className="w-3 h-3 text-red-400" />
      </span>
    );
  }

  return (
    <span title={parts.join(". ") + ". Will retry automatically."}>
      <Clock className="w-3 h-3 text-amber-400" />
    </span>
  );
}
