/**
 * Should a write-time market price be OMITTED so the row lands cashflow_status=null
 * and the date-aware backfill prices it at effective_date? TRUE only when the entry is
 * BACKDATED and carries NO user cost. A today entry's current price IS the effective-date
 * price (keep it); a user cost is stored verbatim regardless (price irrelevant). Mirrors
 * the correct addTransaction pattern (callers pass no price → backfill values by date).
 */
export function omitWriteTimePrice(effectiveDate: string | undefined | null, hasUserCost: boolean): boolean {
  const isBackdated = typeof effectiveDate === "string" && effectiveDate.trim() !== "";
  return isBackdated && !hasUserCost;
}
