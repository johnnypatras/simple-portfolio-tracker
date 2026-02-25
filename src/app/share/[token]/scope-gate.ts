import { notFound } from "next/navigation";
import { validateShareToken, type ShareScope } from "@/lib/actions/shares";

const SCOPE_RANK: Record<ShareScope, number> = {
  overview: 0,
  full: 1,
  full_with_history: 2,
};

/**
 * Validate token and enforce minimum scope for a sub-page.
 * Calls notFound() if the share doesn't meet the required scope.
 */
export async function requireScope(token: string, minScope: ShareScope) {
  const share = await validateShareToken(token);
  if (!share) notFound();
  if (SCOPE_RANK[share.scope] < SCOPE_RANK[minScope]) notFound();
  return share;
}
