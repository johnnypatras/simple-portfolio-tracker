/**
 * Pure share-related utilities — no DB, no "use server".
 * Extracted so tests and client components can import directly.
 */

export type ShareScope = "overview" | "full" | "full_with_history";

export const SCOPE_RANK: Record<ShareScope, number> = {
  overview: 0,
  full: 1,
  full_with_history: 2,
};

interface ShareValidationInput {
  expires_at: string | null;
  revoked_at: string | null;
  scope: ShareScope;
}

/**
 * Pure validation predicate for share tokens.
 * Returns validity and scope without touching the database.
 */
export function isShareValid(
  row: ShareValidationInput | null
): { valid: boolean; scope?: ShareScope } {
  if (!row) return { valid: false };
  if (row.revoked_at) return { valid: false };
  if (row.expires_at && new Date(row.expires_at) < new Date())
    return { valid: false };
  return { valid: true, scope: row.scope };
}
