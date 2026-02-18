"use client";

import { useState } from "react";
import { Wallet, TrendingUp, Landmark } from "lucide-react";
import { WalletManager } from "./wallet-manager";
import { BrokerManager } from "./broker-manager";
import { BankManager } from "./bank-manager";
import type {
  Wallet as WalletType,
  Broker,
  BankAccount,
} from "@/lib/types";

const tabs = [
  { id: "wallets", label: "Wallets", icon: Wallet },
  { id: "brokers", label: "Brokers", icon: TrendingUp },
  { id: "banks", label: "Bank Accounts", icon: Landmark },
] as const;

type TabId = (typeof tabs)[number]["id"];

interface SettingsTabsProps {
  wallets: WalletType[];
  brokers: Broker[];
  banks: BankAccount[];
}

export function SettingsTabs({ wallets, brokers, banks }: SettingsTabsProps) {
  const [active, setActive] = useState<TabId>("wallets");

  return (
    <div>
      {/* Tab bar */}
      <div className="flex gap-1 bg-zinc-900/50 border border-zinc-800/50 rounded-lg p-1 mb-6">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = active === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActive(tab.id)}
              className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                isActive
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              <Icon className="w-4 h-4" />
              <span className="hidden sm:inline">{tab.label}</span>
              {/* Count badges */}
              <span
                className={`text-xs px-1.5 py-0.5 rounded-full ${
                  isActive
                    ? "bg-zinc-700 text-zinc-300"
                    : "bg-zinc-800 text-zinc-600"
                }`}
              >
                {tab.id === "wallets"
                  ? wallets.length
                  : tab.id === "brokers"
                    ? brokers.length
                    : banks.length}
              </span>
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      {active === "wallets" && <WalletManager wallets={wallets} />}
      {active === "brokers" && <BrokerManager brokers={brokers} />}
      {active === "banks" && <BankManager banks={banks} />}
    </div>
  );
}
