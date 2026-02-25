"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ShareScope } from "@/lib/actions/shares";

interface SharedNavBarProps {
  token: string;
  scope: ShareScope;
  ownerName: string;
}

const allTabs = [
  { id: "overview", label: "Overview", href: "", minScope: "overview" as const },
  { id: "accounts", label: "Accounts", href: "/accounts", minScope: "full" as const },
  { id: "crypto", label: "Crypto", href: "/crypto", minScope: "full" as const },
  { id: "stocks", label: "Equities", href: "/stocks", minScope: "full" as const },
  { id: "cash", label: "Cash", href: "/cash", minScope: "full" as const },
  { id: "history", label: "History", href: "/history", minScope: "full_with_history" as const },
  { id: "diary", label: "Diary", href: "/diary", minScope: "full_with_history" as const },
];

const SCOPE_RANK: Record<ShareScope, number> = {
  overview: 0,
  full: 1,
  full_with_history: 2,
};

export function SharedNavBar({ token, scope, ownerName }: SharedNavBarProps) {
  const pathname = usePathname();
  const basePath = `/share/${token}`;

  const visibleTabs = allTabs.filter(
    (tab) => SCOPE_RANK[scope] >= SCOPE_RANK[tab.minScope]
  );

  return (
    <div className="border-b border-zinc-800/50 bg-zinc-950/80 backdrop-blur-sm sticky top-0 z-40">
      {/* Read-only banner */}
      <div className="bg-blue-500/10 border-b border-blue-500/20 px-4 py-2">
        <p className="text-xs text-blue-400 text-center">
          Viewing <span className="font-medium">{ownerName}&apos;s</span> portfolio
          <span className="text-blue-500/70"> &middot; Read-only</span>
        </p>
      </div>

      {/* Navigation tabs */}
      <div className="px-4 overflow-x-auto">
        <nav className="flex gap-1 py-1" aria-label="Shared portfolio navigation">
          {visibleTabs.map((tab) => {
            const href = `${basePath}${tab.href}`;
            const isActive =
              tab.href === ""
                ? pathname === basePath
                : pathname.startsWith(href);

            return (
              <Link
                key={tab.id}
                href={href}
                className={`px-3 py-2 rounded-md text-sm font-medium transition-colors whitespace-nowrap ${
                  isActive
                    ? "bg-zinc-800 text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
