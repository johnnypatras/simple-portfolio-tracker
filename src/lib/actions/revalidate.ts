"use server";

import { revalidatePath } from "next/cache";

/**
 * Revalidate all dashboard paths after a successful mutation.
 *
 * Scope: OWNER dashboard only. This intentionally does NOT revalidate
 * `/share/[token]` routes — doing so would require enumerating every active
 * share token, which is out of proportion to the benefit. Share-page viewers
 * therefore get eventual consistency: after an owner mutation (e.g. a legacy
 * adjustment migration) recipients may briefly see stale benchmark/value data
 * until the share route's own cache TTL expires and the page re-renders.
 */
export async function revalidateDashboard() {
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/crypto");
  revalidatePath("/dashboard/stocks");
  revalidatePath("/dashboard/accounts");
  revalidatePath("/dashboard/cash");
  revalidatePath("/dashboard/diary");
  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/history");
}
