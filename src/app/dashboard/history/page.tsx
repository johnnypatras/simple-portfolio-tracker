import { getActivityLogs } from "@/lib/actions/activity-log";
import { ActivityTimeline } from "@/components/history/activity-timeline";
import { MobileMenuButton } from "@/components/sidebar";
import type { ActionType, EntityType } from "@/lib/types";

const VALID_ENTITY_TYPES: EntityType[] = [
  "crypto_asset", "stock_asset", "wallet", "broker",
  "bank_account", "exchange_deposit", "crypto_position",
  "stock_position", "diary_entry", "goal_price", "trade_entry",
];

const VALID_ACTIONS: ActionType[] = ["created", "updated", "removed"];

export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;

  // Parse & validate filters from URL
  const entityTypeParam = typeof params.type === "string" ? params.type : undefined;
  const actionParam = typeof params.action === "string" ? params.action : undefined;
  const pageParam = typeof params.page === "string" ? parseInt(params.page, 10) : 1;

  const entityType = VALID_ENTITY_TYPES.includes(entityTypeParam as EntityType)
    ? (entityTypeParam as EntityType)
    : undefined;
  const action = VALID_ACTIONS.includes(actionParam as ActionType)
    ? (actionParam as ActionType)
    : undefined;
  const page = isNaN(pageParam) || pageParam < 1 ? 1 : pageParam;
  const limit = 50;
  const offset = (page - 1) * limit;

  const { logs, total } = await getActivityLogs({
    entity_type: entityType,
    action,
    limit,
    offset,
  });

  return (
    <div>
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <MobileMenuButton />
          <h1 className="text-2xl font-semibold text-zinc-100">
            Activity History
          </h1>
        </div>
        <p className="text-sm text-zinc-500 mt-1">
          Audit trail of all portfolio changes
        </p>
      </div>
      <ActivityTimeline
        logs={logs}
        total={total}
        page={page}
        limit={limit}
        currentEntityType={entityType}
        currentAction={action}
      />
    </div>
  );
}
