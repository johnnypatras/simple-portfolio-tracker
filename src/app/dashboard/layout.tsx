import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { Sidebar } from "@/components/sidebar";
import { SidebarProvider } from "@/components/sidebar-context";
import { ThemeSync } from "@/components/theme-sync";
import { CurrencyToggle } from "@/components/currency-toggle";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // Fetch profile preferences — theme + currency
  const { data: profile } = await supabase
    .from("profiles")
    .select("theme, primary_currency")
    .eq("id", user.id)
    .single();

  return (
    <SidebarProvider>
      <ThemeSync profileTheme={profile?.theme ?? null} />
      <div className="flex min-h-screen">
        <Sidebar email={user.email ?? ""} />
        <main className="flex-1 min-w-0 lg:ml-0">
          <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:py-8 overflow-x-hidden">
            <div className="absolute top-6 right-4 sm:right-6 lg:right-8 z-10">
              <CurrencyToggle
                initialCurrency={profile?.primary_currency ?? "EUR"}
              />
            </div>
            {children}
          </div>
        </main>
      </div>
    </SidebarProvider>
  );
}
