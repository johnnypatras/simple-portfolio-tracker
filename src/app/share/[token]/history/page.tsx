import { requireScope } from "../scope-gate";
import { createAdminClient } from "@/lib/supabase/admin";
import { ActivityTimeline } from "@/components/history/activity-timeline";
import { VALID_ENTITY_TYPES, VALID_ACTIONS } from "@/lib/constants";
import type { ActionType, ActivityLog, EntityType } from "@/lib/types";
import { normalizeActivityLogRow } from "@/lib/activity-log-normalize";

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

  const admin = createAdminClient();
  let query = admin
    .from("activity_log")
    .select("*", { count: "exact" })
    .eq("user_id", share.owner_id)
    .is("split_from_id", null)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (entityType) query = query.eq("entity_type", entityType);
  if (action) query = query.eq("action", action);

  const { data, count } = await query;

  const logs = (data ?? []).map(normalizeActivityLogRow);

  // Fetch split children for any split parents visible on this page
  const potentialParentIds = logs
    .filter((l) => l.undone_at && !l.split_from_id)
    .map((l) => l.id);
  let splitChildren: ActivityLog[] = [];
  if (potentialParentIds.length > 0) {
    const { data: childData } = await admin
      .from("activity_log")
      .select("*")
      .in("split_from_id", potentialParentIds)
      .is("undone_at", null)
      .order("effective_date", { ascending: true });
    splitChildren = (childData ?? []).map(normalizeActivityLogRow);
  }

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-zinc-100">Activity History</h1>
        <p className="text-sm text-zinc-400 mt-1">
          Audit trail of all portfolio changes
        </p>
      </div>
      <ActivityTimeline
        logs={logs}
        total={count ?? 0}
        page={page}
        limit={limit}
        currentEntityType={entityType}
        currentAction={action}
        splitChildren={splitChildren}
      />
    </div>
  );
}
