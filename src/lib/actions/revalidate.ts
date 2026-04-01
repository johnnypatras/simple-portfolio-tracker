"use server";

import { revalidatePath } from "next/cache";

/** Revalidate all dashboard paths after a successful mutation. */
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
