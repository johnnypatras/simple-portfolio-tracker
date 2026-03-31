import { revalidatePath } from "next/cache";

/** Revalidate all dashboard paths after a successful mutation. */
export function revalidateDashboard() {
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/crypto");
  revalidatePath("/dashboard/stocks");
  revalidatePath("/dashboard/accounts");
  revalidatePath("/dashboard/cash");
  revalidatePath("/dashboard/diary");
  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/history");
}
