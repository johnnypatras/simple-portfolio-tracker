"use client";

import { useState } from "react";
import { Clock, AlertTriangle, RefreshCw, Loader2 } from "lucide-react";

interface CashflowStatusIconProps {
  cashflowStatus: string | null;
  deltaStatus: string | null;
  onRetry?: () => Promise<{ success: boolean; error?: string }>;
}

export function CashflowStatusIcon({ cashflowStatus, deltaStatus, onRetry }: CashflowStatusIconProps) {
  const [retrying, setRetrying] = useState(false);

  const isPending = cashflowStatus === "pending" || deltaStatus === "pending";
  const isFailed = cashflowStatus === "failed" || deltaStatus === "failed";

  if (!isPending && !isFailed) return null;

  if (retrying) {
    return <Loader2 className="w-3 h-3 text-zinc-400 animate-spin" />;
  }

  const parts: string[] = [];
  if (cashflowStatus === "pending") parts.push("Cashflow data pending");
  if (deltaStatus === "pending") parts.push("Delta data pending");
  if (cashflowStatus === "failed") parts.push("Cashflow uses estimate");
  if (deltaStatus === "failed") parts.push("Delta uses estimate");

  const handleRetry = async () => {
    if (!onRetry) return;
    setRetrying(true);
    try {
      const result = await onRetry();
      if (!result.success) {
        console.error("[retry]", result.error);
      }
    } finally {
      setRetrying(false);
    }
  };

  const statusIcon = isFailed ? (
    <span
      title={parts.join(". ") + ". Chart uses estimate."}
      role="img"
      aria-label={parts.join(". ") + ". Chart uses estimate."}
    >
      <AlertTriangle className="w-3 h-3 text-red-400" />
    </span>
  ) : (
    <span
      title={parts.join(". ") + ". Will retry automatically."}
      role="img"
      aria-label={parts.join(". ") + ". Will retry automatically."}
    >
      <Clock className="w-3 h-3 text-amber-400" />
    </span>
  );

  return (
    <span className="inline-flex items-center gap-1">
      {statusIcon}
      {onRetry && (
        <button
          onClick={handleRetry}
          className="p-0.5 rounded text-zinc-400 hover:text-zinc-300 transition-colors"
          title="Retry computation"
          aria-label="Retry computation"
        >
          <RefreshCw className="w-3 h-3" />
        </button>
      )}
    </span>
  );
}
