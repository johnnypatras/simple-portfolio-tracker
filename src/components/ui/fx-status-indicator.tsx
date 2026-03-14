import { Clock, AlertTriangle } from "lucide-react";

interface FxStatusIndicatorProps {
  stale: boolean;
  unavailable: boolean;
}

export function FxStatusIndicator({ stale, unavailable }: FxStatusIndicatorProps) {
  if (!stale && !unavailable) return null;

  if (unavailable) {
    return (
      <span title="FX rate unavailable — values shown in original currency">
        <AlertTriangle className="w-3 h-3 text-red-400" />
      </span>
    );
  }

  return (
    <span title="FX rate is stale (>24h old)">
      <Clock className="w-3 h-3 text-amber-400" />
    </span>
  );
}
