"use client";

import { useEffect, useRef } from "react";
import FocusTrap from "focus-trap-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  LayoutDashboard,
  Building2,
  Bitcoin,
  TrendingUp,
  Landmark,
  History,
  BookOpen,
  Settings,
  LogOut,
  Menu,
  X,
  Activity,
} from "lucide-react";
import { useSidebar } from "@/components/sidebar-context";
import { HOLDINGS_CACHE_KEY } from "@/components/ui/command-palette-provider";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/dashboard/accounts", label: "Accounts", icon: Building2 },
  { href: "/dashboard/crypto", label: "Crypto", icon: Bitcoin },
  { href: "/dashboard/stocks", label: "Equities", icon: TrendingUp },
  { href: "/dashboard/cash", label: "Banks & Deposits", icon: Landmark },
  { href: "/dashboard/history", label: "History", icon: History },
  { href: "/dashboard/diary", label: "Diary", icon: BookOpen },
];

const bottomItems = [
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

/** Inline hamburger button — rendered inside page header for proper alignment */
export function MobileMenuButton() {
  const { setMobileOpen } = useSidebar();
  return (
    <button
      onClick={() => setMobileOpen(true)}
      aria-label="Open menu"
      className="p-1 -ml-1 rounded-lg lg:hidden"
    >
      <Menu className="w-5 h-5 text-zinc-400" />
    </button>
  );
}

export function Sidebar({ email }: { email: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createClient();
  const { mobileOpen, setMobileOpen } = useSidebar();
  const asideRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!mobileOpen) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMobileOpen(false);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [mobileOpen, setMobileOpen]);

  async function handleLogout() {
    try { localStorage.removeItem(HOLDINGS_CACHE_KEY); } catch { /* ignore */ }
    await supabase.auth.signOut();
    router.push("/login");
  }

  function isActive(href: string) {
    if (href === "/dashboard") return pathname === "/dashboard";
    return pathname.startsWith(href);
  }

  const nav = (
    <>
      {/* Logo — use a non-heading element so the sidebar doesn't inject a
          duplicate h1 on every dashboard page (each page already renders its
          own h1 for the main content, per WCAG 1.3.1 document outline). */}
      <div className="flex items-center justify-between px-4 py-4 border-b border-zinc-800/50">
        <p className="text-sm font-semibold text-zinc-200 tracking-wide">
          Portfolio Tracker
        </p>
        <button
          onClick={() => setMobileOpen(false)}
          aria-label="Close menu"
          className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors lg:hidden"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Main nav */}
      <nav aria-label="Main navigation" className="flex-1 px-3 py-4 space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileOpen(false)}
              aria-current={active ? "page" : undefined}
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
              aria-current={active ? "page" : undefined}
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
          <p className="text-xs text-zinc-400 truncate">{email}</p>
        </div>

        {/* Dev mode indicator */}
        {process.env.NODE_ENV === "development" && (
          <div className="px-3 pt-2 pb-1">
            <div className="flex items-center gap-1.5 text-xs text-emerald-500/70">
              <Activity className="w-3 h-3" />
              <span>dev</span>
            </div>
          </div>
        )}
      </div>
    </>
  );

  return (
    <>
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-30 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar — mobile slides in, desktop always visible */}
      <FocusTrap active={mobileOpen} focusTrapOptions={{ initialFocus: false, fallbackFocus: () => asideRef.current!, allowOutsideClick: true }}>
        <aside
          ref={asideRef}
          tabIndex={-1}
          {...(mobileOpen ? { role: "dialog" as const, "aria-modal": true, "aria-label": "Navigation menu" } : {})}
          className={`fixed top-0 left-0 z-40 h-full w-72 sm:w-60 bg-zinc-900 border-r border-zinc-800/50 flex flex-col transition-transform duration-200 lg:translate-x-0 lg:static lg:w-60 outline-none ${
            mobileOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          {nav}
        </aside>
      </FocusTrap>
    </>
  );
}
