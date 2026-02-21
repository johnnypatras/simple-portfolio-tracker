"use client";

import { useState, useMemo } from "react";
import { Settings2, Wallet, TrendingUp, Landmark, ArrowLeftRight, UserCog } from "lucide-react";
import { GeneralSettings } from "./general-settings";
import { WalletManager } from "./wallet-manager";
import { BrokerManager } from "./broker-manager";
import { BankManager } from "./bank-manager";
import { ImportExportSettings } from "./import-export-settings";
import { AccountSettings } from "./account-settings";
import type {
  Wallet as WalletType,
  Broker,
  BankAccount,
  InstitutionWithRoles,
  InstitutionRole,
} from "@/lib/types";
import type { Profile } from "@/types/database";

const tabs = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "wallets", label: "Exchanges & Wallets", icon: Wallet },
  { id: "brokers", label: "Brokers", icon: TrendingUp },
  { id: "banks", label: "Banks", icon: Landmark },
  { id: "import-export", label: "Import / Export", icon: ArrowLeftRight },
  { id: "account", label: "Account", icon: UserCog },
] as const;

type TabId = (typeof tabs)[number]["id"];

interface SettingsTabsProps {
  profile: Profile;
  wallets: WalletType[];
  brokers: Broker[];
  banks: BankAccount[];
  institutions: InstitutionWithRoles[];
}

export function SettingsTabs({ profile, wallets, brokers, banks, institutions }: SettingsTabsProps) {
  const [active, setActive] = useState<TabId>("general");

  // Institution-based cross-reference: institution_id → roles[]
  const institutionRoles = useMemo(() => {
    const map = new Map<string, InstitutionRole[]>();
    for (const inst of institutions) {
      map.set(inst.id, inst.roles);
    }
    return map;
  }, [institutions]);

  function getCount(tabId: TabId): number | null {
    if (tabId === "wallets") return wallets.length;
    if (tabId === "brokers") return brokers.length;
    if (tabId === "banks") return banks.length;
    return null;
  }

  return (
    <div>
      {/* Tab bar */}
      <div className="flex gap-1 bg-zinc-900/50 border border-zinc-800/50 rounded-lg p-1 mb-6 overflow-x-auto">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = active === tab.id;
          const count = getCount(tab.id);
          return (
            <button
              key={tab.id}
              onClick={() => setActive(tab.id)}
              className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors whitespace-nowrap ${
                isActive
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span className="hidden sm:inline">{tab.label}</span>
              {count !== null && (
                <span
                  className={`text-xs px-1.5 py-0.5 rounded-full ${
                    isActive
                      ? "bg-zinc-700 text-zinc-300"
                      : "bg-zinc-800 text-zinc-600"
                  }`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      {active === "general" && <GeneralSettings profile={profile} />}
      {active === "wallets" && <WalletManager wallets={wallets} institutionRoles={institutionRoles} />}
      {active === "brokers" && <BrokerManager brokers={brokers} institutionRoles={institutionRoles} />}
      {active === "banks" && <BankManager banks={banks} institutionRoles={institutionRoles} />}
      {active === "import-export" && <ImportExportSettings />}
      {active === "account" && <AccountSettings profile={profile} />}
    </div>
  );
}
