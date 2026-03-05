import { notFound } from "next/navigation";
import { validateShareToken } from "@/lib/actions/shares";
import { SCOPE_RANK, type ShareScope } from "@/lib/share-utils";

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
