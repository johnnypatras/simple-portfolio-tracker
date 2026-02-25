import { notFound } from "next/navigation";
import { requireScope } from "../scope-gate";
import { validateShareToken } from "@/lib/actions/shares";
import { createAdminClient } from "@/lib/supabase/admin";
import { ActivityTimeline } from "@/components/history/activity-timeline";
import type { ActionType, ActivityLog, EntityType } from "@/lib/types";

const VALID_ENTITY_TYPES: EntityType[] = [
  "crypto_asset", "stock_asset", "wallet", "broker",
  "bank_account", "exchange_deposit", "crypto_position",
  "stock_position", "diary_entry", "goal_price", "trade_entry",
];

const VALID_ACTIONS: ActionType[] = ["created", "updated", "removed"];

export default async function SharedHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { token } = await params;
  const share = await requireScope(token, "full_with_history");

  const sp = await searchParams;

  // Parse & validate filters from URL
  const entityTypeParam = typeof sp.type === "string" ? sp.type : undefined;
  const actionParam = typeof sp.action === "string" ? sp.action : undefined;
  const pageParam = typeof sp.page === "string" ? parseInt(sp.page, 10) : 1;

  const entityType = VALID_ENTITY_TYPES.includes(entityTypeParam as EntityType)
    ? (entityTypeParam as EntityType)
    : undefined;
  const action = VALID_ACTIONS.includes(actionParam as ActionType)
    ? (actionParam as ActionType)
    : undefined;
  const page = isNaN(pageParam) || pageParam < 1 ? 1 : pageParam;
  const limit = 50;
  const offset = (page - 1) * limit;

  // Fetch activity logs using admin client (bypasses RLS)
  const validated = await validateShareToken(token);
  if (!validated) notFound();

  const admin = createAdminClient();
  let query = admin
    .from("activity_log")
    .select("*", { count: "exact" })
    .eq("user_id", validated.owner_id)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (entityType) query = query.eq("entity_type", entityType);
  if (action) query = query.eq("action", action);

  const { data, count } = await query;

  return (
    <ActivityTimeline
      logs={(data ?? []) as ActivityLog[]}
      total={count ?? 0}
      page={page}
      limit={limit}
      currentEntityType={entityType}
      currentAction={action}
    />
  );
}
