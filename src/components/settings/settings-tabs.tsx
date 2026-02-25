"use client";

import { useMemo, useState } from "react";
import {
  Settings2,
  ArrowLeftRight,
  UserCog,
  Share2,
  Users,
} from "lucide-react";
import { GeneralSettings } from "./general-settings";
import { ImportExportSettings } from "./import-export-settings";
import { AccountSettings } from "./account-settings";
import { SharingSettings } from "./sharing-settings";
import { UsersSettings } from "./users-settings";
import type { Profile } from "@/lib/types";
import type { LucideIcon } from "lucide-react";

type TabId = "general" | "sharing" | "import-export" | "account" | "users";

interface Tab {
  id: TabId;
  label: string;
  icon: LucideIcon;
}

const BASE_TABS: Tab[] = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "sharing", label: "Sharing", icon: Share2 },
  { id: "import-export", label: "Import / Export", icon: ArrowLeftRight },
  { id: "account", label: "Account", icon: UserCog },
];

interface SettingsTabsProps {
  profile: Profile;
}

export function SettingsTabs({ profile }: SettingsTabsProps) {
  const [active, setActive] = useState<TabId>("general");

  const tabs = useMemo<Tab[]>(() => {
    if (profile.role === "admin") {
      return [...BASE_TABS, { id: "users", label: "Users", icon: Users }];
    }
    return BASE_TABS;
  }, [profile.role]);

  return (
    <div>
      {/* Tab bar */}
      <div className="flex gap-1 bg-zinc-900/50 border border-zinc-800/50 rounded-lg p-1 mb-6 overflow-x-auto">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = active === tab.id;
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
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      {active === "general" && <GeneralSettings profile={profile} />}
      {active === "sharing" && <SharingSettings />}
      {active === "import-export" && <ImportExportSettings />}
      {active === "account" && <AccountSettings profile={profile} />}
      {active === "users" && <UsersSettings />}
    </div>
  );
}
