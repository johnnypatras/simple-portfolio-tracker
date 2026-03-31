import { Clock, AlertTriangle } from "lucide-react";

interface FxStatusIndicatorProps {
  stale: boolean;
  unavailable: boolean;
}

export function FxStatusIndicator({ stale, unavailable }: FxStatusIndicatorProps) {
  if (!stale && !unavailable) return null;

  if (unavailable) {
    return (
      <span
        title="FX rate unavailable — values shown in original currency"
        aria-label="FX rate unavailable — values shown in original currency"
        role="img"
      >
        <AlertTriangle className="w-3 h-3 text-red-400" aria-hidden="true" />
      </span>
    );
  }

  return (
    <span
      title="FX rate is stale (>24h old)"
      aria-label="FX rate is stale (>24h old)"
      role="img"
    >
      <Clock className="w-3 h-3 text-amber-400" aria-hidden="true" />
    </span>
  );
}
