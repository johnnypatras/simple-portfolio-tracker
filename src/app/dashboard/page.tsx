import { createServerSupabaseClient } from "@/lib/supabase/server";

export default async function DashboardPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-zinc-100">Dashboard</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Welcome back{user?.email ? `, ${user.email}` : ""}
        </p>
      </div>

      {/* Placeholder cards — will be replaced with real data in Phase 5 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {[
          { label: "Total Portfolio", value: "—", sub: "USD" },
          { label: "Crypto", value: "—", sub: "across all wallets" },
          { label: "Stocks & ETFs", value: "—", sub: "across all brokers" },
          { label: "Cash", value: "—", sub: "banks + exchanges" },
          { label: "24h Change", value: "—", sub: "vs yesterday" },
          { label: "Allocation", value: "—", sub: "crypto / stocks / cash" },
        ].map((card) => (
          <div
            key={card.label}
            className="bg-zinc-900 border border-zinc-800/50 rounded-xl p-5"
          >
            <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
              {card.label}
            </p>
            <p className="text-2xl font-semibold text-zinc-100 mt-2">
              {card.value}
            </p>
            <p className="text-xs text-zinc-600 mt-1">{card.sub}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
