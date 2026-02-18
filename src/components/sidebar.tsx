"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  LayoutDashboard,
  Bitcoin,
  TrendingUp,
  Landmark,
  History,
  BookOpen,
  Settings,
  LogOut,
  Menu,
  X,
} from "lucide-react";
import { useState } from "react";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/dashboard/crypto", label: "Crypto", icon: Bitcoin },
  { href: "/dashboard/stocks", label: "Stocks & ETFs", icon: TrendingUp },
  { href: "/dashboard/cash", label: "Cash", icon: Landmark },
  { href: "/dashboard/history", label: "History", icon: History },
  { href: "/dashboard/diary", label: "Diary", icon: BookOpen },
];

const bottomItems = [
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

export function Sidebar({ email }: { email: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createClient();
  const [mobileOpen, setMobileOpen] = useState(false);

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  function isActive(href: string) {
    if (href === "/dashboard") return pathname === "/dashboard";
    return pathname.startsWith(href);
  }

  const nav = (
    <>
      {/* Logo */}
      <div className="px-4 py-6 border-b border-zinc-800/50">
        <h1 className="text-sm font-semibold text-zinc-200 tracking-wide">
          Portfolio Tracker
        </h1>
      </div>

      {/* Main nav */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileOpen(false)}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                active
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Bottom nav */}
      <div className="px-3 py-4 border-t border-zinc-800/50 space-y-1">
        {bottomItems.map((item) => {
          const Icon = item.icon;
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileOpen(false)}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                active
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              {item.label}
            </Link>
          );
        })}

        <button
          onClick={handleLogout}
          className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium text-zinc-400 hover:text-red-400 hover:bg-zinc-800/50 transition-colors w-full"
        >
          <LogOut className="w-4 h-4 shrink-0" />
          Sign out
        </button>

        {/* User email */}
        <div className="px-3 pt-3">
          <p className="text-xs text-zinc-600 truncate">{email}</p>
        </div>
      </div>
    </>
  );

  return (
    <>
      {/* Mobile toggle */}
      <button
        onClick={() => setMobileOpen(!mobileOpen)}
        className="fixed top-4 left-4 z-50 p-2 rounded-lg bg-zinc-800 border border-zinc-700 lg:hidden"
      >
        {mobileOpen ? (
          <X className="w-5 h-5 text-zinc-300" />
        ) : (
          <Menu className="w-5 h-5 text-zinc-300" />
        )}
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-30 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar — mobile slides in, desktop always visible */}
      <aside
        className={`fixed top-0 left-0 z-40 h-full w-60 bg-zinc-900 border-r border-zinc-800/50 flex flex-col transition-transform duration-200 lg:translate-x-0 lg:static ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {nav}
      </aside>
    </>
  );
}
